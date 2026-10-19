import { createHash, randomUUID } from 'node:crypto'
import type { EnterpriseBusinessCapability, EnterpriseBusinessCapabilityCatalog } from '../../../src/types/api'
import type { DevelopmentTrialAction, TeamDefinition, TeamDevelopmentProposalResult, TeamWorkspace, TeamWorkspaceCommand } from '../../../src/types/team-workspace'
import { WORKBENCH_RESULT_PROTOCOL } from '../../../src/pages/team-workspace/graph'
import { businessCompletionRequirement, requireDeclaredBusinessCompletion } from '../../../src/pages/team-workspace/business-completion'
import { freezeDevelopmentTrialActions, publicationReadinessBlocker, workflowCandidateCapabilityIds, workflowSimulationChoices, workflowTrialBlocker } from '../../../src/pages/team-workspace/development-trial'
import { toolActivityEvidence, trialToolDisplayName, trialToolMissingDetails, trialToolPayload, trialToolPayloadCompleteness, trialToolStatus, type TrialToolEvidence } from '../../../src/lib/trial-tool-evidence'
import { CapabilityBridge, type CapabilityClaim, type CapabilityScope } from '../lib/capability-bridge'
import { HandoffStore, type HandoffStorage } from '../enterprise/handoff-store'
import { MAX_RPC_WRITE_FRAME_BYTES } from '../agent-rpc/limits'
import { requireRecord, requireString } from '../validation'

/** A step output as Weave's trial activity returns it. */
type TrialOutputItem = { kind?: string; path?: string; content?: string; content_type?: string; content_bytes?: number; truncated?: boolean; output_id?: string; full_content?: string }

interface DevelopmentContext {
  accountKey: string
  teamId: string
  revision: number
  document: TeamDefinition
  catalog: EnterpriseBusinessCapabilityCatalog
  selected?: { kind: 'member' | 'step'; id: string }
  /** What Weave found the saved draft still lacks, as last read. */
  issues?: unknown[]
  stale?: boolean
}
interface DevelopmentTrial {
  teamId: string
  workflowId: string
  workflowName: string
  revision: number
  requestId: string
  intentDigest: string
  authorizationSourceHash?: string
  simulationActionSelectors?: string[]
  businessActions?: DevelopmentTrialAction[]
  runId?: string
  stepNames: Record<string, string>
}
type DevelopmentUserCommandType = 'prompt' | 'steer' | 'follow_up'
const supportsDevelopmentHarness = (harness: CapabilityScope['harness']): boolean => harness === 'pi' || harness === 'loom'
interface DevelopmentUserTurnScope {
  teamId: string
  revision: number
  documentHash: string
  workflowId: string
}
interface DevelopmentUserTurn {
  source: 'trusted_desktop_employee_input'
  sourceHash: string
  turnId: string
  accountKey: string
  runtimeId: string
  sessionPath?: string
  commandType: DevelopmentUserCommandType
  text: string
  scope?: DevelopmentUserTurnScope
}
interface PendingDevelopmentUserCommand {
  token: string
  claim: CapabilityClaim
  commandType: DevelopmentUserCommandType
  consumed: boolean
}
interface DevelopmentActivity {
  status?: string
  completeness?: Record<string, string>
  members?: Array<{
    name?: string; status?: string
    stages?: Array<{
      name?: string; status?: string; inputs?: Array<{ source?: string; summary?: string }>
      outputs?: Array<TrialOutputItem>
      tools?: Array<TrialToolEvidence & { name?: string }> | null
      tool_calls?: number
      failure_reason?: string
    }>
  }>
  outputs?: Array<Record<string, unknown>>
}
interface DevelopmentTrialInput { input?: string; status?: string; output?: string }
interface DevelopmentTrialReceipt { request_id?: string; run_id?: string }
interface StoredDevelopmentTrial extends DevelopmentTrial {}
interface StoredDevelopment {
  context?: Omit<DevelopmentContext, 'catalog'>
  trial?: StoredDevelopmentTrial
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]))
}

function comparableDocument(document: TeamDefinition): TeamDefinition {
  // Weave's typed configuration writes these two omitted optional fields as
  // null/0. Normalize only those declared defaults, including persisted older
  // pending saves; all business fields, graph bindings and versions still match.
  return { ...document, members: document.members.map((member) => ({
    ...member, configuration: { ...member.configuration,
      toolLoopControl: member.configuration.toolLoopControl === undefined ? null : member.configuration.toolLoopControl,
      maxToolRepeats: member.configuration.maxToolRepeats === undefined ? 0 : member.configuration.maxToolRepeats,
    },
  })) }
}

function sameDocument(left: TeamDefinition, right: TeamDefinition): boolean {
  return JSON.stringify(canonical(comparableDocument(left))) === JSON.stringify(canonical(comparableDocument(right)))
}

function digest(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonical(value))).digest('hex')
}

function requestedSimulationSelectors(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 32 || value.some((item) => typeof item !== 'string' || !item.trim() || item.length > 512)) {
    throw new TypeError('本次模拟动作选择无效')
  }
  const selectors = value as string[]
  if (new Set(selectors).size !== selectors.length) throw new TypeError('本次模拟动作不能重复选择')
  return selectors
}

function stableUuid(value: string): string {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function messageStatus(status: string | undefined): string {
  return ({
    submitting: '等待接单', queued: '排队中', running: '执行中', succeeded: '已完成',
    failed: '失败', cancelled: '已取消', blocked: '等待处理', pending: '等待执行',
    completed: '已完成', tool_started: '执行中', tool_completed: '已完成', tool_failed: '失败',
  } as Record<string, string>)[status ?? ''] ?? '等待更新'
}

function completenessLabel(value: string | undefined): string {
  return ({ complete: '完整', partial: '部分', unavailable: '不可用', not_applicable: '不适用（本次零调用）' } as Record<string, string>)[value ?? ''] ?? '未确认'
}

export class TeamDevelopmentAgentBridge extends CapabilityBridge {
  protected readonly rateLimit = 30
  protected readonly rateLimitError = '团队开发请求过于频繁，请稍后重试'
  private readonly runtimeTokens = new Map<string, string>()
  private readonly contexts = new Map<string, DevelopmentContext>()
  private readonly listedTeams = new Map<string, Array<{ id: string; name: string }>>()
  private readonly trials = new Map<string, DevelopmentTrial>()
  /** Trial outputs shown in this conversation, by the reference given to Pi. */
  private readonly trialOutputs = new Map<string, Map<string, { teamId: string; runId: string; outputId: string }>>()
  private readonly userTurns = new Map<string, DevelopmentUserTurn>()
  private readonly pendingUserCommands = new Map<string, PendingDevelopmentUserCommand>()
  private readonly store: HandoffStore

  constructor(private readonly options: {
    accountKey(): Promise<string>
    developer(): Promise<{ accountId: string }>
    teams(): Promise<Array<{ id: string; name: string; objective?: string }>>
    team(teamId: string, accountId: string): Promise<TeamWorkspace>
    workspace(command: TeamWorkspaceCommand): Promise<unknown>
    catalog(): Promise<EnterpriseBusinessCapabilityCatalog>
    /** Asks the person at the window for a secret; absent, nothing that needs one can be configured. */
    requestSecret?(prompt: { title: string; label: string; detail?: string }): Promise<string | undefined>
    /** Asks the person at the window before something that cannot be taken back; absent, nothing of the kind is done. */
    confirmOperation?(question: { title: string; subject?: string; message: string }): Promise<boolean>
    /** Shows the person a secret an operation produced and says whether a window took it. */
    revealSecrets?(secret: { title: string; message: string; values: Array<{ label: string; value: string }> }): boolean
    /** Has the person choose where to save a team package and writes it; undefined when they cancel. */
    saveTeamPackage?(suggestedName: string, contents: string): Promise<string | undefined>
    /** Has the person choose a team package file and reads it; undefined when they cancel. */
    openTeamPackage?(): Promise<{ name: string; contents: string } | undefined>
    extensionPath: string
    storage?: HandoffStorage
  }) { super(); this.store = new HandoffStore(options.storage) }

  private storageKey(accountKey: string, sessionFile: string): string { return `team-development:${accountKey}:${sessionFile}` }

  private async persist(claim: CapabilityClaim): Promise<void> {
    if (!claim.sessionPath) return
    const accountKey = await this.options.accountKey()
    const context = this.contexts.get(claim.token)
    const value: StoredDevelopment = {
      ...(context ? { context: {
        accountKey: context.accountKey, teamId: context.teamId, revision: context.revision, document: context.document,
        selected: context.selected, issues: context.issues, stale: context.stale,
      } } : {}),
      ...(this.trials.has(claim.token) ? { trial: this.trials.get(claim.token) } : {}),
    }
    await this.store.checkpoint(this.storageKey(accountKey, claim.sessionPath), 'team-development-v1', value)
  }

  private async restore(accountKey: string, sessionFile: string, token?: string): Promise<StoredDevelopment | undefined> {
    const saved = await this.store.inspect<StoredDevelopment>(this.storageKey(accountKey, sessionFile))
    if (!saved) return undefined
    const value = saved.value
    if (value.context && value.context.accountKey !== accountKey) return undefined
    if (value.context) {
      // Edits are applied by Weave now; a candidate kept by an earlier desktop
      // release has nothing left to wait for, so the session resumes from the
      // draft as it stands.
      const stored = value.context as unknown as Record<string, unknown>
      delete stored.proposal
      delete stored.pendingSave
      const developer = await this.options.developer()
      const remote = await this.options.team(value.context.teamId, developer.accountId)
      value.context.revision = remote.revision
      value.context.document = structuredClone(remote.document)
      value.context.issues = remote.issues
      value.context.stale = false
      if (token && !this.contexts.has(token)) this.contexts.set(token, { ...value.context, catalog: await this.options.catalog() })
    }
    if (token && value.trial) this.trials.set(token, value.trial)
    return value
  }

  protected environmentEntries(url: string, token: string): NodeJS.ProcessEnv {
    return {
      GOOEYPI_TEAM_DEVELOPMENT_URL: url,
      GOOEYPI_TEAM_DEVELOPMENT_TOKEN: token,
      GOOEYPI_TEAM_DEVELOPMENT_EXTENSION_PATH: this.options.extensionPath,
    }
  }

  override environmentFor(scope: CapabilityScope): NodeJS.ProcessEnv {
    if (!supportsDevelopmentHarness(scope.harness)) throw new Error('当前运行环境不支持团队开发')
    return super.environmentFor(scope)
  }

  bindRuntime(token: string | undefined, runtimeId: string, sessionFile?: string): void {
    if (!token) return
    const claim = this.claimForToken(token)
    if (!claim || !supportsDevelopmentHarness(claim.harness)) return
    const previousToken = this.runtimeTokens.get(runtimeId)
    if (previousToken && previousToken !== token) {
      this.clearUserTurn(previousToken)
      this.pendingUserCommands.delete(runtimeId)
    }
    if (claim.sessionPath && sessionFile && claim.sessionPath !== sessionFile) { this.clearUserTurn(token); this.revoke(token); throw new Error('团队开发会话已变化') }
    if (sessionFile) {
      claim.sessionPath = sessionFile
      const turn = this.userTurns.get(token)
      if (turn && turn.sessionPath === undefined) turn.sessionPath = sessionFile
    }
    this.runtimeTokens.set(runtimeId, token)
  }

  bindRuntimeSession(runtimeId: string, sessionFile: string): void {
    const token = this.runtimeTokens.get(runtimeId)
    if (token) this.bindRuntime(token, runtimeId, sessionFile)
  }

  private clearUserTurn(token: string): void {
    this.userTurns.delete(token)
    for (const [runtimeId, pending] of this.pendingUserCommands) if (pending.token === token) this.pendingUserCommands.delete(runtimeId)
  }

  private documentHash(document: TeamDefinition): string {
    return digest(JSON.stringify(canonical(comparableDocument(document))))
  }

  private draftIdentity(context: Pick<DevelopmentContext, 'teamId' | 'revision' | 'document'>): Pick<DevelopmentUserTurnScope, 'teamId' | 'revision' | 'documentHash'> {
    return { teamId: context.teamId, revision: context.revision, documentHash: this.documentHash(context.document) }
  }

  private sameDraftIdentity(left: Pick<DevelopmentUserTurnScope, 'teamId' | 'revision' | 'documentHash'>, right: Pick<DevelopmentUserTurnScope, 'teamId' | 'revision' | 'documentHash'>): boolean {
    return left.teamId === right.teamId && left.revision === right.revision && left.documentHash === right.documentHash
  }

  private sameTurnScope(left: DevelopmentUserTurnScope, right: DevelopmentUserTurnScope): boolean {
    return this.sameDraftIdentity(left, right) && left.workflowId === right.workflowId
  }

  private assertPiOpenContextChange(
    token: string,
    sourceAtDispatch: DevelopmentUserTurn | undefined,
    contextAtDispatch: DevelopmentContext | undefined,
    nextContext: DevelopmentContext,
  ): void {
    const current = this.userTurns.get(token)
    if (this.contexts.get(token) !== contextAtDispatch) throw new Error('当前团队开发上下文已变化；请重新读取后再打开团队。')
    if (current && current.accountKey !== nextContext.accountKey) throw new Error('账号已变化；不会把当前员工请求绑定到另一个开发账号。')
    const nextIdentity = this.draftIdentity(nextContext)
    const previousIdentity = contextAtDispatch ? this.draftIdentity(contextAtDispatch) : undefined
    if (current !== sourceAtDispatch) {
      if (!previousIdentity || !this.sameDraftIdentity(previousIdentity, nextIdentity)) {
        throw new Error('员工轮次已变化；不会用新请求接续旧团队上下文切换。')
      }
      return
    }
    if (current?.scope && !this.sameDraftIdentity(current.scope, nextIdentity)) {
      throw new Error('本轮员工请求已绑定其他团队或草稿；请在目标上下文重新提出模拟要求。')
    }
  }

  private rebindUserTurnAfterControlledSave(
    token: string,
    sourceAtDispatch: DevelopmentUserTurn | undefined,
    previousIdentity: Pick<DevelopmentUserTurnScope, 'teamId' | 'revision' | 'documentHash'>,
    context: DevelopmentContext,
  ): void {
    const current = this.userTurns.get(token)
    if (!current) return
    if (this.contexts.get(token) !== context) return
    const nextIdentity = this.draftIdentity(context)
    if (current !== sourceAtDispatch) {
      if (!this.sameDraftIdentity(previousIdentity, nextIdentity)) this.clearUserTurn(token)
      return
    }
    if (!current.scope) return
    if (!this.sameDraftIdentity(current.scope, previousIdentity)
      || !context.document.workflows.some((workflow) => workflow.id === current.scope!.workflowId)) {
      this.clearUserTurn(token)
      return
    }
    current.scope = { ...this.draftIdentity(context), workflowId: current.scope.workflowId }
  }

  invalidateEmployeeTurn(runtimeId: string): void {
    const token = this.runtimeTokens.get(runtimeId)
    if (token) this.clearUserTurn(token)
    this.pendingUserCommands.delete(runtimeId)
  }

  /** Called before forwarding a trusted renderer command so previous turns cannot carry forward. */
  beginEmployeeCommand(runtimeId: string, rawType: unknown): void {
    const token = this.runtimeTokens.get(runtimeId)
    const claim = token ? this.claimForToken(token) : undefined
    if (!token || !claim || !['prompt', 'steer', 'follow_up', 'abort', 'compact'].includes(String(rawType))) return
    this.invalidateEmployeeTurn(runtimeId)
    if (rawType === 'prompt' || rawType === 'steer' || rawType === 'follow_up') {
      this.pendingUserCommands.set(runtimeId, { token, claim, commandType: rawType, consumed: false })
    }
  }

  /** Revalidates the captured input through the same trusted desktop input parser as enterprise handoffs. */
  async captureTrustedEmployeeCommand(runtimeId: string, command: unknown, employeeInput?: unknown): Promise<void> {
    const pending = this.pendingUserCommands.get(runtimeId)
    const token = this.runtimeTokens.get(runtimeId)
    if (!pending || pending.consumed || !token || pending.token !== token) return
    pending.consumed = true
    try {
      const value = requireRecord(command, 'command')
      if (value.type !== pending.commandType) return
      const claim = this.claimForToken(token)
      if (!claim || claim !== pending.claim || !supportsDevelopmentHarness(claim.harness)) return
      const prompt = requireString(value.message, 'command.message', { min: 1, max: 1_048_576, trim: false })
      const { captureEmployeeInput } = await import('../enterprise/employee-input')
      const captured = captureEmployeeInput(prompt, employeeInput, claim)
      const images = value.images === undefined ? [] : (() => {
        if (!Array.isArray(value.images) || value.images.length > 8) throw new TypeError('桌面员工输入中的图片来源无效')
        return value.images.map((raw, index) => {
          const image = requireRecord(raw, `images[${index}]`)
          if (image.type !== 'image') throw new TypeError('桌面员工输入中的图片来源无效')
          const mimeType = requireString(image.mimeType, `images[${index}].mimeType`, { min: 1, max: 100 })
          const data = requireString(image.data, `images[${index}].data`, { min: 1, max: MAX_RPC_WRITE_FRAME_BYTES })
          return { mimeType, sha256: createHash('sha256').update(data).digest('hex') }
        })
      })()
      const accountKey = await this.options.accountKey()
      const turnId = randomUUID()
      const sourceHash = createHash('sha256').update(JSON.stringify(canonical({
        source: 'trusted_desktop_employee_input', turnId, commandType: pending.commandType,
        accountKey, runtimeId, sessionPath: claim.sessionPath ?? null,
        prompt, text: captured.text, materials: captured.materials ?? [], images,
      }))).digest('hex')
      if (this.pendingUserCommands.get(runtimeId) !== pending || this.runtimeTokens.get(runtimeId) !== token
        || this.claimForToken(token) !== claim || await this.options.accountKey() !== accountKey) return
      this.userTurns.set(token, {
        source: 'trusted_desktop_employee_input', sourceHash, turnId,
        accountKey, runtimeId, ...(claim.sessionPath ? { sessionPath: claim.sessionPath } : {}),
        commandType: pending.commandType, text: captured.text,
      })
    } finally {
      if (this.pendingUserCommands.get(runtimeId) === pending) this.pendingUserCommands.delete(runtimeId)
    }
  }

  async bindContext(runtimeId: string, context: Omit<DevelopmentContext, 'accountKey'>, accountKey: string): Promise<void> {
    const token = this.runtimeTokens.get(runtimeId)
    const claim = token ? this.claimForToken(token) : undefined
    if (!token || !claim) throw new Error('Pi 开发会话尚未启动')
    if (!Number.isSafeInteger(context.revision) || context.revision < 0 || !Array.isArray(context.document?.members) || !Array.isArray(context.document?.workflows)) throw new Error('团队草稿不完整')
    const previous = this.contexts.get(token)
    const sameIdentity = Boolean(previous && previous.accountKey === accountKey && previous.teamId === context.teamId
      && previous.revision === context.revision && this.documentHash(previous.document) === this.documentHash(context.document))
    if (!sameIdentity) {
      this.clearUserTurn(token)
    }
    this.contexts.set(token, { ...context, accountKey, document: structuredClone(context.document), stale: false })
    if (!sameIdentity) this.trials.delete(token)
    await this.persist(claim)
  }

  /** Pi's edits go straight to Weave; nothing waits in the desktop to be applied. */
  async getProposal(_runtimeId: string): Promise<TeamDevelopmentProposalResult | undefined> { return undefined }

  async getState(runtimeId: string): Promise<{ teamId?: string; revision?: number }> {
    const token = this.runtimeTokens.get(runtimeId)
    const claim = token ? this.claimForToken(token) : undefined
    if (claim?.sessionPath && !this.contexts.has(token!)) await this.restore(await this.options.accountKey(), claim.sessionPath, token)
    const context = token ? this.contexts.get(token) : undefined
    if (context && await this.options.accountKey() !== context.accountKey) throw new Error('团队开发账号已变化')
    return context ? { teamId: context.teamId, revision: context.revision } : {}
  }

  async getStateForSession(sessionFile: string): Promise<{ teamId?: string; revision?: number }> {
    const context = (await this.restore(await this.options.accountKey(), sessionFile))?.context
    return context ? { teamId: context.teamId, revision: context.revision } : {}
  }

  invalidateAccount(): void { this.revokeAllClaims(); this.contexts.clear(); this.runtimeTokens.clear(); this.listedTeams.clear(); this.userTurns.clear(); this.pendingUserCommands.clear() }

  protected onClaimRevoked(claim: CapabilityClaim): void {
    this.contexts.delete(claim.token)
    this.listedTeams.delete(claim.token)
    this.trials.delete(claim.token)
    this.clearUserTurn(claim.token)
    for (const [runtimeId, token] of this.runtimeTokens) if (token === claim.token) this.runtimeTokens.delete(runtimeId)
  }

  private readableContext(context: DevelopmentContext) {
    const members = context.document.members
    const workflows = context.document.workflows
    const memberName = (id: unknown) => members.find((item) => item.id === id)?.configuration.displayName ?? '未指定成员'
    const capabilityName = (id: string) => context.catalog.capabilities.find((item) => item.id === id)?.name ?? '当前不可读取的业务动作'
    return {
      team: {
        name: context.document.name,
        objective: context.document.objective,
        issues: context.issues ?? [],
        draftStatus: context.stale ? '团队草稿已在别处变化；这里显示的是变化前的内容。保存、试跑和更新团队会先拒绝，请重新打开该团队读取最新草稿' : '当前草稿',
        members: members.map((item) => ({
          name: item.configuration.displayName, role: item.configuration.role === 'avatar' ? '负责人' : '成员',
          duty: item.relationship.duty, whenToUse: item.relationship.whenToUse,
          contextInstruction: item.relationship.contextInstruction,
          resultRequirement: item.relationship.resultRequirement,
          instruction: item.configuration.systemPrompt, model: item.configuration.model,
          skills: item.configuration.skills, businessActions: item.configuration.businessCapabilityIds.map(capabilityName),
        })),
        workflows: workflows.map((flow) => {
          const stepName = (id: unknown) => flow.graph_definition.nodes.find((node) => node.id === id)?.label ?? '未命名步骤'
          const completion = businessCompletionRequirement(flow)
          const candidateIds = workflowCandidateCapabilityIds(context.document, flow)
          const candidateActions = candidateIds.flatMap((id) => context.catalog.capabilities.filter((item) => item.id === id))
          const simulationActions = workflowSimulationChoices(candidateActions).map(({ selector, action }) => ({
            selector, name: action.name, description: action.description,
            effect: action.effect === 'write' ? '业务写动作' : '只读业务动作',
            status: action.status === 'available' ? '可模拟' : '暂不可用',
          }))
          return {
            name: flow.name, description: flow.description,
            ...(completion ? { businessCompletion: { actions: completion.capabilities.map(capabilityName), whenAuthorized: true, allowNeedsInput: completion.allowNeedsInput } } : {}),
            simulation_actions: simulationActions,
            resultProtocol: flow.graph_definition.result_protocol === WORKBENCH_RESULT_PROTOCOL ? '可要求补充材料' : '普通结果',
            steps: flow.graph_definition.nodes.map((node) => ({
              name: node.label || '未命名步骤', type: ({ lead: '负责人处理', worker: '成员执行', parallel: '并行分工', join: '汇合结果', deliver: '交付结果' } as Record<string, string>)[node.type] ?? '流程步骤',
              executor: node.type === 'lead' ? members.find((item) => item.configuration.role === 'avatar')?.configuration.displayName : node.type === 'worker' ? memberName(node.config?.agent_id) : undefined,
              instruction: node.config?.instruction, resultRequirement: node.config?.result_requirement,
              inputs: Object.values((node.inputs ?? {}) as Record<string, { value?: { source?: string; node_id?: string } }>).map((binding) => binding.value?.source === 'run_input' ? '本次任务输入' : binding.value?.source === 'node_output' ? `${stepName(binding.value.node_id)}的结果` : '其他输入'),
              deliveryFrom: node.type === 'deliver' ? stepName((node.config?.result as { node_id?: string } | undefined)?.node_id) : undefined,
              joinPolicy: node.type === 'join' ? node.config?.policy : undefined,
            })),
            connections: flow.graph_definition.edges.map((edge) => ({ from: stepName(edge.from_node_id), to: stepName(edge.to_node_id), relation: ({ success: '继续', branch: '并行分支', join: '汇合', back: '返回' } as Record<string, string>)[edge.route ?? 'success'] ?? '连接' })),
          }
        }),
      },
      selected: context.selected?.kind === 'member' ? memberName(context.selected.id)
        : context.selected?.kind === 'step' ? workflows.flatMap((flow) => flow.graph_definition.nodes).find((node) => node.id === context.selected?.id)?.label : undefined,
      business_actions: context.catalog.capabilities.map((item) => ({ name: item.name, description: item.description, effect: item.effect === 'write' ? '修改业务记录' : '只读取业务资料', status: item.status === 'available' ? '可绑定' : '暂不可用', params: item.params ?? [] })),
    }
  }

  private acceptSavedDocument(context: DevelopmentContext, remote: TeamWorkspace): void {
    context.document = structuredClone(remote.document)
    context.revision = remote.revision
    context.issues = remote.issues
    context.stale = false
  }

  private async currentTeam(context: DevelopmentContext, accountId: string): Promise<TeamWorkspace> {
    if (await this.options.accountKey() !== context.accountKey) throw new Error('团队开发账号已变化')
    return this.options.team(context.teamId, accountId)
  }

  // Weave applies controlled edits: it resolves the names, validates the result
  // and answers a repeated request with its first outcome. A draft that moved on
  // is left alone and marked, so the session reads it again before trying.
  private async applyOperations(context: DevelopmentContext, developer: { accountId: string }, operations: unknown[], requestId: string, dryRun: boolean, claim: CapabilityClaim): Promise<{ revision?: number; changes?: string[]; issues?: unknown[] }> {
    if (await this.options.accountKey() !== context.accountKey) throw new Error('团队开发账号已变化')
    const send = () => this.options.workspace({ action: 'operations', teamId: context.teamId, accountId: developer.accountId, revision: context.revision, requestId, dryRun, operations }) as Promise<{ revision?: number; changes?: string[]; issues?: unknown[] }>
    const answered = (cause: unknown) => typeof (cause as { status?: unknown })?.status === 'number'
    const refuse = async (cause: unknown): Promise<never> => {
      if ((cause as { code?: unknown })?.code === 'development_revision_stale') {
        context.stale = true
        await this.persist(claim)
        throw new Error('团队草稿已变化，与本次修改的起点不一致；没有保存。请重新打开该团队读取最新草稿，再重新提交修改。')
      }
      throw cause
    }
    try {
      return await send()
    } catch (cause) {
      if (answered(cause) || dryRun) return refuse(cause)
      // No answer came back. The same request id asks Weave what became of it.
      try { return await send() } catch (again) { return refuse(again) }
    }
  }

  private async saveTeam(context: DevelopmentContext, developer: { accountId: string }, rawOperations: unknown, claim: CapabilityClaim, sourceAtDispatch?: DevelopmentUserTurn): Promise<unknown> {
    if (!Array.isArray(rawOperations)) throw new Error('修改内容必须是 JSON 数组')
    const previousIdentity = this.draftIdentity(context)
    // The same change to the same draft in the same session is one request.
    const requestId = stableUuid(digest({ kind: 'team-save', account: context.accountKey, session: claim.sessionPath ?? claim.token, team: context.teamId, revision: context.revision, operations: rawOperations }))
    const result = await this.applyOperations(context, developer, rawOperations, requestId, false, claim)
    const remote = await this.currentTeam(context, developer.accountId)
    this.acceptSavedDocument(context, remote)
    this.rebindUserTurnAfterControlledSave(claim.token, sourceAtDispatch, previousIdentity, context)
    await this.persist(claim)
    return { team: remote.document.name, changes: result.changes ?? [], issues: remote.issues ?? result.issues ?? [], message: '团队草稿已保存，当前生效版本没有改变。' }
  }

  private businessActions(context: DevelopmentContext, workflow: TeamDefinition['workflows'][number]): EnterpriseBusinessCapability[] {
    const ids = workflowCandidateCapabilityIds(context.document, workflow)
    return ids.map((id) => {
      const action = context.catalog.capabilities.find((candidate) => candidate.id === id)
      if (!action || action.executionMode === 'employee_only' || action.status !== 'available' || !action.actionName || !action.objectName) throw new Error(action?.unavailableReason ?? '当前流程候选成员绑定了暂不可用的 Forge 业务动作，请先修正团队草稿')
      return action
    })
  }

  private async requireCurrentUserTurn(context: DevelopmentContext, claim: CapabilityClaim, expected: DevelopmentUserTurn | undefined, workflowId: string): Promise<DevelopmentUserTurn> {
    const turn = expected
    if (!turn || this.userTurns.get(claim.token) !== turn) {
      throw new Error('模拟动作需要绑定当前账号和桌面会话中的员工请求；请在当前会话重新提出本轮模拟要求。')
    }
    if (turn.source !== 'trusted_desktop_employee_input' || !/^[0-9a-f]{64}$/.test(turn.sourceHash)
      || turn.accountKey !== context.accountKey || turn.runtimeId.length === 0
      || this.runtimeTokens.get(turn.runtimeId) !== claim.token || !supportsDevelopmentHarness(claim.harness)
      || turn.sessionPath !== undefined && turn.sessionPath !== claim.sessionPath) {
      throw new Error('模拟动作需要绑定当前账号和桌面会话中的员工请求；请在当前会话重新提出本轮模拟要求。')
    }
    const expectedScope: DevelopmentUserTurnScope = { ...this.draftIdentity(context), workflowId }
    if (turn.scope && !this.sameTurnScope(turn.scope, expectedScope)) {
      throw new Error('本轮模拟请求已绑定其他团队、草稿修订或流程；请在目标上下文重新提出模拟要求。')
    }
    const accountKey = await this.options.accountKey()
    if (accountKey !== context.accountKey || this.userTurns.get(claim.token) !== turn
      || this.claimForToken(claim.token) !== claim || this.runtimeTokens.get(turn.runtimeId) !== claim.token) {
      throw new Error('员工账号、会话或当前请求已变化；本次模拟动作不会转移到新的开发上下文。')
    }
    if (turn.scope && !this.sameTurnScope(turn.scope, expectedScope)) {
      throw new Error('本轮模拟请求已绑定其他团队、草稿修订或流程；请在目标上下文重新提出模拟要求。')
    }
    turn.scope ??= expectedScope
    return turn
  }

  private async runTrial(context: DevelopmentContext, developer: { accountId: string }, params: Record<string, unknown>, claim: CapabilityClaim, sourceAtDispatch?: DevelopmentUserTurn): Promise<unknown> {
    const workflowName = typeof params.workflow_name === 'string' ? params.workflow_name.trim() : ''
    const input = typeof params.input === 'string' ? params.input : ''
    if (!input.trim() || Buffer.byteLength(input, 'utf8') > 700_000) throw new Error('请提供 700 KB 以内的测试输入')
    const matches = context.document.workflows.filter((workflow) => workflow.name === workflowName)
    if (matches.length !== 1) throw new Error('请使用当前草稿中的准确流程名称')
    const workflow = matches[0]!
    const remote = await this.currentTeam(context, developer.accountId)
    if (remote.revision !== context.revision || !sameDocument(remote.document, context.document)) {
      context.stale = true
      await this.persist(claim)
      throw new Error('团队草稿已在别处变化，与当前读取的内容不一致；请重新打开该团队读取最新草稿，再试跑。')
    }
    context.stale = false
    const selectors = requestedSimulationSelectors(params.simulation_actions)
    const userTurn = selectors.length ? await this.requireCurrentUserTurn(context, claim, sourceAtDispatch, workflow.id) : undefined
    const intentDigest = digest({ teamId: context.teamId, revision: context.revision, workflowId: workflow.id, input, simulationActions: [...selectors].sort() })
    const prior = this.trials.get(claim.token)
    if (prior && (!Array.isArray(prior.simulationActionSelectors) || !Array.isArray(prior.businessActions))) {
      throw new Error('上次试跑没有保存完整的固定模拟动作范围；请先读取该试跑状态并确认结束，再开始新的试跑。')
    }
    if (prior?.businessActions?.some((action) => action.simulationAuthorized) && !prior.authorizationSourceHash) {
      throw new Error('上次模拟动作没有可信员工请求来源记录；请先读取试跑状态，不会重放旧动作范围。')
    }
    if (prior?.businessActions?.some((action) => action.simulationAuthorized) && !prior.runId && prior.intentDigest !== intentDigest) {
      throw new Error('上次模拟试跑结果尚待核对；请先读取该试跑状态，不会用新请求覆盖固定动作范围。')
    }
    if (userTurn && prior?.intentDigest === intentDigest && prior.authorizationSourceHash && prior.authorizationSourceHash !== userTurn.sourceHash) {
      throw new Error('这组模拟输入与动作已绑定到另一条员工请求；请先读取原试跑状态，勿重复提交。')
    }
    const trial = prior?.intentDigest === intentDigest ? prior : undefined
    if (!trial) {
      const sessionKey = claim.sessionPath ?? claim.token
      const actions = this.businessActions(context, workflow)
      const frozenActions = freezeDevelopmentTrialActions(workflowSimulationChoices(actions), selectors)
      const nextTrial: DevelopmentTrial = {
        teamId: context.teamId, workflowId: workflow.id, workflowName: workflow.name,
        revision: context.revision,
        requestId: stableUuid(`${context.accountKey}:${sessionKey}:${context.teamId}:${intentDigest}`),
        intentDigest,
        ...(userTurn ? { authorizationSourceHash: userTurn.sourceHash } : {}),
        simulationActionSelectors: [...selectors].sort(),
        businessActions: frozenActions,
        stepNames: Object.fromEntries(workflow.graph_definition.nodes.map((node) => [node.id, node.label || '流程步骤'])),
      }
      this.trials.set(claim.token, nextTrial)
      await this.persist(claim)
      return this.submitTrial(context, developer, nextTrial, input, claim)
    }
    return this.submitTrial(context, developer, trial, input, claim)
  }

  private async submitTrial(context: DevelopmentContext, developer: { accountId: string }, trial: DevelopmentTrial, input: string, claim: CapabilityClaim): Promise<unknown> {
    if (!Array.isArray(trial.simulationActionSelectors) || !Array.isArray(trial.businessActions)) throw new Error('本次试跑固定动作范围缺失；不会用新的模拟授权重试')
    let authorizationTurn: DevelopmentUserTurn | undefined
    if (trial.businessActions.some((action) => action.simulationAuthorized)) {
      authorizationTurn = await this.requireCurrentUserTurn(context, claim, this.userTurns.get(claim.token), trial.workflowId)
      if (!trial.authorizationSourceHash || authorizationTurn.sourceHash !== trial.authorizationSourceHash) throw new Error('本次模拟动作与当前员工请求来源不一致；请核对试跑状态后重新提出模拟要求。')
    }
    if (context.teamId !== trial.teamId || context.revision !== trial.revision || await this.options.accountKey() !== context.accountKey) throw new Error('账号、团队或草稿修订已变化；本次固定试跑不会转移到新的开发上下文')
    if (authorizationTurn && this.userTurns.get(claim.token) !== authorizationTurn) throw new Error('员工轮次已变化；本次模拟动作不会转移到新的员工请求。')
    const receipt = await this.options.workspace({
      action: 'trial', teamId: trial.teamId, accountId: developer.accountId,
      revision: trial.revision, workflowId: trial.workflowId, requestId: trial.requestId,
      input, businessActions: trial.businessActions,
    }) as DevelopmentTrialReceipt
    if (receipt?.request_id && receipt.request_id !== trial.requestId) throw new Error('Weave 返回了不同的试跑回执')
    if (typeof receipt?.run_id === 'string') trial.runId = receipt.run_id
    this.trials.set(claim.token, trial)
    await this.persist(claim)
    return { team: context.document.name, workflow: trial.workflowName, status: '已提交隔离试跑', message: '试跑使用 Weave 的隔离模拟，会记录业务动作模拟调用，但不携带凭据、不访问或写入 Forge。可读取试跑状态查看固定输入、步骤记录和实际工具输入输出。' }
  }

  private async trialStatus(context: DevelopmentContext, developer: { accountId: string }, claim: CapabilityClaim): Promise<unknown> {
    if (await this.options.accountKey() !== context.accountKey) throw new Error('团队开发账号已变化')
    const trial = this.trials.get(claim.token)
    if (!trial || trial.teamId !== context.teamId) throw new Error('当前 Pi 会话还没有本团队的试跑记录')
    const remote = await this.options.team(trial.teamId, developer.accountId)
    if (!trial.runId) {
      const receipt = remote.trials.find((item) => item.request_id === trial.requestId)
      if (receipt?.run_id) trial.runId = receipt.run_id
    }
    const [inputResult, activityResult] = await Promise.allSettled([
      this.options.workspace({ action: 'input', teamId: trial.teamId, requestId: trial.requestId, accountId: developer.accountId }) as Promise<DevelopmentTrialInput>,
      trial.runId
        ? this.options.workspace({ action: 'activity', teamId: trial.teamId, runId: trial.runId, accountId: developer.accountId }) as Promise<DevelopmentActivity & { outputs?: Array<Record<string, unknown>> }>
        : Promise.resolve(undefined),
    ])
    if (inputResult.status === 'rejected') throw inputResult.reason
    if (inputResult.value.input === undefined) throw new Error('Weave 未返回本次试跑的固定输入')
    // A newly admitted trial may have a run receipt before its activity exists.
    // Keep the fixed input and live status readable while the trace catches up.
    const activityUnavailable = activityResult.status === 'rejected'
    const material = inputResult.value
    const activity = activityResult.status === 'fulfilled' ? activityResult.value : undefined
    if (activity?.status && ['succeeded', 'failed', 'cancelled'].includes(activity.status)) {
      const legacyTrial = !Array.isArray(trial.simulationActionSelectors) || !Array.isArray(trial.businessActions)
      if (legacyTrial) this.trials.delete(claim.token)
      else this.trials.set(claim.token, trial)
      await this.persist(claim)
    }
    const completeness = activity?.completeness ?? {}
    const callEvidence = toolActivityEvidence(activity)
    const payloadCompleteness = trialToolPayloadCompleteness(activity)
    const fullTrace = ['stages', 'member_inputs', 'member_outputs', 'member_tool_activity'].every((key) => completeness[key] === 'complete') && callEvidence !== 'incomplete'
    const members = (activity?.members ?? []).map((member) => ({
      name: member.name ?? '团队成员', status: messageStatus(member.status),
      steps: (member.stages ?? []).map((stage) => ({
        name: stage.name ?? '流程步骤', status: messageStatus(stage.status),
        inputs: (stage.inputs ?? []).map((item) => ({
          source: item.source === 'run_input' ? '本次试跑输入' : item.source === 'node_output' ? '前序步骤输出' : '其他来源',
          ...(item.summary ? { summary: item.summary } : {}),
          evidence: 'Weave 记录的输入摘要；不是完整原始步骤输入。',
        })),
        outputs: (stage.outputs ?? []).map((item) => this.trialOutputView(claim, trial, item)),
        tools: (stage.tools ?? []).map((tool) => ({
          name: trialToolDisplayName(tool, trial.businessActions ?? context.catalog.capabilities), status: trialToolStatus(tool),
          ...(trialToolPayload(tool, 'input') !== undefined ? { actual_input: trialToolPayload(tool, 'input') } : {}),
          ...(trialToolPayload(tool, 'output') !== undefined ? { actual_output: trialToolPayload(tool, 'output') } : {}),
          ...(tool.input_state ? { input_state: tool.input_state, input_bytes: tool.input_bytes } : {}),
          ...(tool.output_state ? { output_state: tool.output_state, output_bytes: tool.output_bytes } : {}),
          evidence: trialToolMissingDetails(tool) || 'Weave 记录的工具实际输入与输出；模拟回执不代表 Forge 业务结果。',
        })),
        ...(stage.failure_reason ? { failure: stage.failure_reason } : {}),
      })),
    }))
    const outputs = (activity?.outputs ?? []).map((item) => {
      const content = item.content
      const nodeId = typeof item.node_id === 'string' ? item.node_id : undefined
      return {
        ...(typeof nodeId === 'string' && trial.stepNames[nodeId] ? { step: trial.stepNames[nodeId] } : {}),
        title: typeof item.title === 'string' ? item.title : '试跑结果',
        ...(typeof content === 'string' ? { content } : {}),
      }
    })
    return {
      team: context.document.name, workflow: trial.workflowName,
      status: messageStatus(activity?.status ?? material.status),
      fixed_input: material.input,
      final_result: material.output || undefined,
      trace: {
        completeness: {
          stages: completenessLabel(completeness.stages),
          step_input_summaries: completenessLabel(completeness.member_inputs),
          step_outputs: completenessLabel(completeness.member_outputs),
          tool_activity: completenessLabel(callEvidence === 'incomplete' ? 'partial' : 'complete'),
          tool_input_output: completenessLabel(payloadCompleteness),
          deliverables: completenessLabel(completeness.deliverables),
        },
        trajectory: !activity ? '尚未取得完整活动记录' : !fullTrace ? '活动记录不完整或只部分可用' : ['complete', 'not_applicable'].includes(payloadCompleteness) ? '完整活动记录' : '步骤和调用清单完整；工具实参或回执不完整',
        ...(activityUnavailable ? { activity_note: 'Weave 活动暂不可读取，请稍后再取；不能仅凭最终结果判定调试通过。' } : {}),
        input_note: '固定输入为本次完整试跑材料；各步骤的 inputs 是 Weave 记录的摘要字段，不能当作完整原始输入。工具调用清单与实参、回执完整性分别核对；没有保存的字段不能从模型摘要补作证据。',
        output_note: '步骤输出最多先给 64 条、每条只给开头部分；标为预览的用 output_ref 读全文，更多步骤输出用试跑输出翻页读取。',
        members, outputs,
      },
    }
  }

  /** One step output as Pi sees it: a preview is said to be one, with the way to the whole body. */
  private trialOutputView(claim: CapabilityClaim, trial: DevelopmentTrial, item: TrialOutputItem) {
    let outputRef: string | undefined
    if (item.output_id && trial.runId && item.full_content === 'stored') {
      const refs = this.trialOutputs.get(claim.token) ?? new Map<string, { teamId: string; runId: string; outputId: string }>()
      this.trialOutputs.set(claim.token, refs)
      outputRef = [...refs].find(([, value]) => value.outputId === item.output_id && value.runId === trial.runId)?.[0]
      if (!outputRef) {
        outputRef = `output-${refs.size + 1}`
        refs.set(outputRef, { teamId: trial.teamId, runId: trial.runId, outputId: item.output_id })
      }
    }
    const stored = item.full_content === 'stored', failed = item.full_content === 'storage_failed'
    return {
      kind: item.kind === 'artifact' ? '步骤文件' : '步骤结果',
      ...(item.path ? { name: item.path } : {}),
      content: item.content ?? '',
      ...(item.content_bytes !== undefined ? { original_bytes: item.content_bytes } : {}),
      truncated: item.truncated === true,
      ...(outputRef ? { output_ref: outputRef } : {}),
      evidence: failed ? '该步骤输出超过试跑可保存的大小，Weave 未能保存全文（保存失败），这里只有开头部分。'
        : !item.truncated ? 'Weave 实际保存的该步骤输出全文。'
          : stored ? '这里是开头部分预览；全文已保存，可用 output_ref 读取。'
            : '这是全文保存上线前的旧试跑，Weave 只保留了截断内容，不能视为完整原文。',
    }
  }

  private async trialOutputPage(context: DevelopmentContext, developer: { accountId: string }, claim: CapabilityClaim, params: Record<string, unknown>): Promise<unknown> {
    if (await this.options.accountKey() !== context.accountKey) throw new Error('团队开发账号已变化')
    const trial = this.trials.get(claim.token)
    if (!trial?.runId || trial.teamId !== context.teamId) throw new Error('当前 Pi 会话还没有可读取的本团队试跑')
    const offset = typeof params.offset === 'number' && Number.isInteger(params.offset) && params.offset >= 0 ? params.offset : 0
    const page = await this.options.workspace({ action: 'trial-outputs', teamId: trial.teamId, runId: trial.runId, offset, accountId: developer.accountId }) as { outputs?: Array<Record<string, unknown>>; total?: number; next_offset?: number | null; earlier_outputs_dropped?: boolean }
    return {
      total: page.total ?? 0, ...(typeof page.next_offset === 'number' ? { next_offset: page.next_offset } : {}),
      outputs: (page.outputs ?? []).map((item) => this.trialOutputView(claim, trial, item as TrialOutputItem)),
      ...(page.earlier_outputs_dropped ? { note: '这次试跑早于全文保存上线，超过 64 条后的步骤输出当时没有保存。' } : {}),
    }
  }

  private async trialOutputWhole(context: DevelopmentContext, developer: { accountId: string }, claim: CapabilityClaim, params: Record<string, unknown>): Promise<unknown> {
    if (await this.options.accountKey() !== context.accountKey) throw new Error('团队开发账号已变化')
    const ref = typeof params.output_ref === 'string' ? params.output_ref.trim() : ''
    const target = this.trialOutputs.get(claim.token)?.get(ref)
    if (!target || target.teamId !== context.teamId) throw new Error('output_ref 只能来自本会话最近读取的试跑输出')
    const whole = await this.options.workspace({ action: 'trial-output', teamId: target.teamId, runId: target.runId, outputId: target.outputId, accountId: developer.accountId }) as { content?: string; content_encoding?: string; content_bytes?: number; content_type?: string; full_content?: string }
    if (whole.full_content !== 'stored') throw new Error('Weave 没有保存这条输出的全文')
    return {
      content: whole.content ?? '', content_type: whole.content_type, original_bytes: whole.content_bytes,
      ...(whole.content_encoding === 'base64' ? { encoding: 'base64', note: '该输出不是文本，以 base64 原样给出。' } : {}),
      evidence: 'Weave 保存的该步骤输出全文。',
    }
  }

  private async updateTeam(context: DevelopmentContext, developer: { accountId: string }, claim: CapabilityClaim): Promise<unknown> {
    const remote = await this.currentTeam(context, developer.accountId)
    if (remote.revision !== context.revision || !sameDocument(remote.document, context.document)) {
      context.stale = true
      await this.persist(claim)
      throw new Error('团队草稿已在别处变化，与当前读取的内容不一致；本次没有更新团队。请重新打开该团队读取最新草稿并重新试跑。')
    }
    if (remote.published_revision === context.revision) return { team: remote.document.name, status: '已更新', message: '该团队版本已经生效。' }
    requireDeclaredBusinessCompletion(context.document)
    const trialBlocker = workflowTrialBlocker(remote)
    if (trialBlocker) throw new Error(trialBlocker)
    const readinessBlocker = publicationReadinessBlocker(remote, context.catalog)
    if (readinessBlocker) throw new Error(readinessBlocker)
    try {
      const updated = await this.options.workspace({ action: 'publish', teamId: context.teamId, accountId: developer.accountId, revision: context.revision }) as TeamWorkspace
      if (!updated || updated.published_revision !== context.revision) throw new Error('Weave 尚未确认本次团队版本已生效')
      this.acceptSavedDocument(context, updated)
      await this.persist(claim)
      return { team: updated.document.name, status: '已更新', message: '团队已更新，新工作将使用本次配置。' }
    } catch (cause) {
      try {
        const latest = await this.currentTeam(context, developer.accountId)
        if (latest.published_revision === context.revision) {
          this.acceptSavedDocument(context, latest)
          await this.persist(claim)
          return { team: latest.document.name, status: '已更新', message: '已从 Weave 核对到本次团队版本生效。' }
        }
        if (latest.revision !== context.revision || !sameDocument(latest.document, context.document)) context.stale = true
      } catch { /* Preserve the draft and report the uncertain publication result. */ }
      await this.persist(claim)
      throw cause
    }
  }

  protected async dispatch(method: string, params: Record<string, unknown>, claim: CapabilityClaim): Promise<unknown> {
    const sourceAtDispatch = ['open', 'save', 'trial'].includes(method) ? this.userTurns.get(claim.token) : undefined
    let contextAtDispatch = method === 'open' ? this.contexts.get(claim.token) : undefined
    const developer = await this.options.developer()
    if (method === 'list') {
      const teams = await this.options.teams()
      this.listedTeams.set(claim.token, teams.map((team) => ({ id: team.id, name: team.name })))
      return { teams: teams.map((team) => ({ name: team.name, objective: team.objective })) }
    }
    if (method === 'models') {
      const listed = await this.options.workspace({ action: 'model-providers', accountId: developer.accountId }) as { providers?: unknown }
      return { providers: Array.isArray(listed?.providers) ? listed.providers : [], message: '这是组织共享的模型供应方及其模型；成员只能选其中的模型。标为 deployment 的随部署提供，不在这里修改。' }
    }
    if (method === 'configure_model') {
      const accountKey = await this.options.accountKey()
      const provider = typeof params.provider === 'string' ? params.provider.trim() : ''
      const name = typeof params.name === 'string' ? params.name.trim() : ''
      const baseUrl = typeof params.base_url === 'string' ? params.base_url.trim() : ''
      const models = Array.isArray(params.models) ? [...new Set(params.models.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))] : []
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(provider) || !name || name.length > 80 || !/^https?:\/\/\S+$/.test(baseUrl) || models.length < 1 || models.length > 32) {
        throw new Error('需要供应方标识（小写字母、数字和连字符）、名称、完整的接口地址和 1 至 32 个模型名称')
      }
      // The key is typed into the app's own field and goes from here to Weave. It is
      // never a tool parameter, so it cannot come from, or return to, the conversation.
      let apiKey: string | undefined
      if (params.keep_key !== true) {
        apiKey = await this.options.requestSecret?.({ title: '组织模型密钥', label: `${name} 的密钥`, detail: `保存后由 Weave 加密保管，供本组织的团队调用 ${new URL(baseUrl).host}。` })
        if (!apiKey) throw new Error('没有填写密钥，组织模型未改动')
      }
      if (this.claimForToken(claim.token) !== claim || await this.options.accountKey() !== accountKey) throw new Error('账号或会话已变化，组织模型未改动')
      const saved = await this.options.workspace({ action: 'configure-model-provider', accountId: developer.accountId, provider, name, baseUrl, models, apiKey }) as { models?: unknown }
      return { name, models: Array.isArray(saved?.models) ? saved.models : models, message: apiKey ? '组织模型已保存，密钥已由 Weave 加密保管。现在可以给成员选这些模型。' : '组织模型已更新，沿用原来的密钥。' }
    }
    if (method === 'workspace_guide') {
      const topic = typeof params.topic === 'string' ? params.topic.trim() : ''
      if (topic.length > 64) throw new Error('操作类别无效')
      return this.options.workspace({ action: 'workspace-guide', accountId: developer.accountId, ...(topic ? { topic } : {}) })
    }
    if (method === 'workspace_apply') {
      const operation = params.operation
      if (!operation || typeof operation !== 'object' || Array.isArray(operation) || typeof (operation as { kind?: unknown }).kind !== 'string') throw new Error('操作内容必须是带 kind 的 JSON 对象')
      const accountKey = await this.options.accountKey()
      const unchanged = async () => this.claimForToken(claim.token) === claim && await this.options.accountKey() === accountKey
      type Answer = { status?: string; title?: unknown; subject?: unknown; message?: unknown; secrets?: unknown; forge_session?: unknown; result?: unknown; reveal?: unknown }
      const text = (value: unknown) => typeof value === 'string' ? value : ''
      // Weave says what an operation still needs; the person supplies it at the
      // window. Consent and secrets are never tool parameters, so neither can
      // come from, or return to, the conversation.
      let confirmed = false
      let forgeSession = false
      const secrets: Record<string, string> = {}
      for (let round = 0; round < 4; round += 1) {
        const answer = await this.options.workspace({ action: 'workspace-apply', accountId: developer.accountId, operation: operation as Record<string, unknown>, confirmed, secrets, forgeSession }) as Answer
        if (answer?.status === 'confirmation_required' && !confirmed) {
          const title = text(answer.title) || '办理这项操作'
          if (!await this.options.confirmOperation?.({ title, subject: text(answer.subject) || undefined, message: text(answer.message) })) return { status: 'declined', message: `使用者没有同意“${title}”，未办理，也没有改动。不要重试，除非使用者再次明确要求。` }
          if (!await unchanged()) throw new Error('账号或会话已变化，未办理')
          confirmed = true
          continue
        }
        if (answer?.status === 'needs_input' && round < 3) {
          const wanted = Array.isArray(answer.secrets) ? answer.secrets as Array<{ field?: unknown; label?: unknown }> : []
          for (const item of wanted) {
            const field = text(item?.field), label = text(item?.label) || '密钥'
            if (!field || secrets[field]) throw new Error('Weave 要求的填写项无法识别，未办理')
            const value = await this.options.requestSecret?.({ title: '填写密钥', label, detail: '由桌面直接交给 Weave 加密保管，不会出现在对话里。' })
            if (!value) return { status: 'declined', message: `没有填写${label}，未办理，也没有改动。` }
            secrets[field] = value
          }
          if (answer.forge_session === true) {
            if (forgeSession) throw new Error('当前登录不能用于这项操作，请重新登录后再试')
            forgeSession = true
          } else if (!wanted.length) throw new Error('Weave 没有说明还需要什么，未办理')
          if (!await unchanged()) throw new Error('账号或会话已变化，未办理')
          continue
        }
        if (answer?.status !== 'done') throw new Error('Weave 没有完成这项操作')
        const values = (Array.isArray(answer.reveal) ? answer.reveal as Array<{ label?: unknown; value?: unknown }> : []).map((item) => ({ label: text(item?.label), value: text(item?.value) })).filter((item) => item.label && item.value)
        // The team list read earlier no longer holds once a team is archived.
        if ((operation as { kind: string }).kind === 'team_archive') this.listedTeams.delete(claim.token)
        if (!values.length) return { status: 'done', result: answer.result }
        // A secret the operation produced is shown by the window and goes no further.
        const shown = await unchanged() && this.options.revealSecrets?.({ title: '请保存以下内容', message: '这些内容只显示这一次，对话里不会出现。请复制后在需要的地方使用。', values }) === true
        return { status: 'done', result: answer.result, message: shown ? '操作产生的令牌和命令已由桌面显示给使用者，这里不包含它们；不要向使用者索要或复述。' : '操作已完成，但令牌没能显示给使用者（应用窗口不可用）。需要时请使用者再办理一次更换令牌。' }
      }
      throw new Error('这项操作需要的确认或填写没有完成，未办理')
    }
    if (method === 'create') {
      const name = typeof params.name === 'string' ? params.name.trim() : ''
      const objective = typeof params.objective === 'string' ? params.objective.trim() : ''
      const kind = params.kind === 'code' ? 'code' : 'business'
      if (!name || name.length > 80 || !objective || objective.length > 2000) throw new Error('新团队需要名称（80 字以内）和明确的目标（2000 字以内）')
      if (params.kind !== undefined && params.kind !== 'business' && params.kind !== 'code') throw new Error('团队类型只能是业务团队（business）或代码团队（code）')
      const accountKey = await this.options.accountKey()
      // The same team asked for again in the same session is the same request.
      const requestId = stableUuid(digest({ kind: 'team-create', account: accountKey, session: claim.sessionPath ?? claim.token, name, objective, ...(kind === 'code' ? { teamKind: kind } : {}) }))
      const created = await this.options.workspace({ action: 'create', accountId: developer.accountId, requestId, name, objective, kind }) as { team_id?: unknown }
      if (typeof created?.team_id !== 'string' || !created.team_id) throw new Error('Weave 没有返回新团队')
      const [draft, catalog] = await Promise.all([this.options.team(created.team_id, developer.accountId), this.options.catalog()])
      this.contexts.set(claim.token, { accountKey, teamId: created.team_id, revision: draft.revision, document: structuredClone(draft.document), catalog, issues: draft.issues, stale: false })
      this.listedTeams.delete(claim.token)
      this.trials.delete(claim.token)
      await this.persist(claim)
      return { name: draft.document.name, objective: draft.document.objective, message: kind === 'code'
        ? '代码团队已建好并已打开它的草稿：负责人、编码与验证两位成员，以及验证未通过时退回编码的流程。读取上下文后先给两位成员选执行节点。'
        : '团队已建好并已打开它的草稿：负责人、一位业务办理员和基础流程。读取上下文后继续配置。' }
    }
    if (method === 'import') {
      if (!this.options.openTeamPackage) throw new Error('应用窗口不可用，无法选择团队文件')
      const chosen = await this.options.openTeamPackage()
      if (!chosen) return { status: 'declined', message: '没有选择团队文件，未导入，也没有改动。' }
      let pkg: unknown
      try { pkg = JSON.parse(chosen.contents) } catch { throw new Error('所选文件不是团队导出文件') }
      if ((pkg as { format?: unknown } | null)?.format !== 'weave-team-package') throw new Error('所选文件不是团队导出文件')
      const accountKey = await this.options.accountKey()
      // The same file imported again in the same session is the same request.
      const requestId = stableUuid(digest({ kind: 'team-import', account: accountKey, session: claim.sessionPath ?? claim.token, package: digest(chosen.contents) }))
      const imported = await this.options.workspace({ action: 'import', accountId: developer.accountId, requestId, package: pkg }) as { team_id?: unknown; adjustments?: unknown }
      if (typeof imported?.team_id !== 'string' || !imported.team_id) throw new Error('Weave 没有返回导入的团队')
      const [draft, catalog] = await Promise.all([this.options.team(imported.team_id, developer.accountId), this.options.catalog()])
      this.contexts.set(claim.token, { accountKey, teamId: imported.team_id, revision: draft.revision, document: structuredClone(draft.document), catalog, issues: draft.issues, stale: false })
      this.listedTeams.delete(claim.token)
      this.trials.delete(claim.token)
      await this.persist(claim)
      const adjustments = Array.isArray(imported.adjustments) ? imported.adjustments.filter((line): line is string => typeof line === 'string') : []
      return { status: 'done', name: draft.document.name, objective: draft.document.objective, file: chosen.name, adjustments,
        message: adjustments.length
          ? '团队已导入为新的未发布草稿并已打开。adjustments 列出的内容在本工作区没有对应项，已去掉或改为成员自带技能；请逐条告诉开发者，读取上下文后补齐。'
          : '团队已导入为新的未发布草稿并已打开，没有需要调整的内容。读取上下文后试跑，再发布。' }
    }
    if (method === 'open') {
      const teamName = typeof params.team_name === 'string' ? params.team_name : ''
      let known = this.listedTeams.get(claim.token)
      if (!known) { known = (await this.options.teams()).map((team) => ({ id: team.id, name: team.name })); this.listedTeams.set(claim.token, known) }
      const candidates = known.filter((team) => team.name === teamName)
      if (candidates.length !== 1) throw new Error('请使用当前账号可开发且不重复的准确团队名称')
      const teamId = candidates[0]!.id
      if (!this.contexts.has(claim.token) && claim.sessionPath) await this.restore(await this.options.accountKey(), claim.sessionPath, claim.token)
      if (!contextAtDispatch) contextAtDispatch = this.contexts.get(claim.token)
      const [draft, catalog] = await Promise.all([this.options.team(teamId, developer.accountId), this.options.catalog()])
      const nextContext: DevelopmentContext = { accountKey: await this.options.accountKey(), teamId, revision: draft.revision, document: structuredClone(draft.document), catalog, issues: draft.issues, stale: false }
      this.assertPiOpenContextChange(claim.token, sourceAtDispatch, contextAtDispatch, nextContext)
      this.contexts.set(claim.token, nextContext)
      await this.persist(claim)
    }
    if (!this.contexts.has(claim.token) && claim.sessionPath) await this.restore(await this.options.accountKey(), claim.sessionPath, claim.token)
    const context = this.contexts.get(claim.token)
    if (!context || await this.options.accountKey() !== context.accountKey) throw new Error('请先查找可开发团队并打开团队草稿')
    if (method === 'open') return { name: context.document.name, objective: context.document.objective, message: '已打开团队草稿；请读取完整上下文后再提修改。' }
    if (method === 'context') {
      // What may be changed is Weave's to say; without its list the draft still reads.
      const guide = await this.options.workspace({ action: 'guide', accountId: developer.accountId }).catch(() => undefined) as { topics?: unknown; console_only?: unknown } | undefined
      return { ...this.readableContext(context), editable: guide?.topics ?? [], console_only: guide?.console_only }
    }
    if (method === 'guide') {
      const topic = typeof params.topic === 'string' ? params.topic.trim() : ''
      if (!topic || topic.length > 64) throw new Error('请给出要读取的修改类别')
      return this.options.workspace({ action: 'guide', accountId: developer.accountId, topic })
    }
    if (method === 'preview') {
      if (!Array.isArray(params.operations)) throw new Error('修改内容必须是 JSON 数组')
      const result = await this.applyOperations(context, developer, params.operations, randomUUID(), true, claim)
      return { changes: result.changes ?? [], issues: result.issues ?? [], message: '以上是预览，没有保存或发布，也没有留下待处理内容。开发者同意后提交同一组修改保存。' }
    }
    if (method === 'export') {
      if (!this.options.saveTeamPackage) throw new Error('应用窗口不可用，无法选择保存位置')
      const pkg = await this.options.workspace({ action: 'export', accountId: developer.accountId, teamId: context.teamId }) as { team?: { name?: unknown }; members?: unknown[]; workflows?: unknown[] }
      const name = typeof pkg?.team?.name === 'string' && pkg.team.name.trim() ? pkg.team.name.trim() : context.document.name
      const file = await this.options.saveTeamPackage(`${name.replace(/[\\/:*?"<>|]/g, '_')}.weave-team.json`, JSON.stringify(pkg, null, 2))
      if (!file) return { status: 'declined', message: '没有选择保存位置，未导出。' }
      return { status: 'done', team: name, file, members: pkg.members?.length ?? 0, workflows: pkg.workflows?.length ?? 0,
        message: '已把 Weave 中保存的团队草稿导出到开发者选择的文件。文件不含密钥、运行记录和发布状态；在另一个工作区用“导入团队”可建成新的草稿。' }
    }
    if (method === 'save') return this.saveTeam(context, developer, params.operations, claim, sourceAtDispatch)
    if (method === 'trial') return this.runTrial(context, developer, params, claim, sourceAtDispatch)
    if (method === 'trial_status') return this.trialStatus(context, developer, claim)
    if (method === 'trial_outputs') return this.trialOutputPage(context, developer, claim, params)
    if (method === 'trial_output') return this.trialOutputWhole(context, developer, claim, params)
    if (method === 'update_team') return this.updateTeam(context, developer, claim)
    throw new Error('不支持的团队开发操作')
  }
}
