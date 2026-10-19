import type { BusinessInputSource } from './employee-business-inputs'
import { storedUploadProgress } from './upload-progress'
import { isDraftAction, proveDraftInputs, assertDraftSourcesCurrent, type DraftEvidence } from './employee-business-provenance'
import { randomUUID } from 'node:crypto'
import type { EmployeeBusinessAction, EmployeeBusinessContext, EmployeeBusinessOperation, EmployeeBusinessParameter, EmployeeBusinessRequest, EmployeeBusinessTarget, EmployeeBusinessCreationSelection, EmployeeBusinessRecord } from '../../../src/types/employee-business'
import type { EnterpriseService } from '../enterprise'
import type { WorkspaceMaterialPromptReference } from '../../../src/types/api'
import { type HandoffStore, digest } from './handoff-store'
import { freezeMaterials, type FrozenMaterial } from './materials'
import { canonicalBusinessJSON, employeeBusinessRequestDigest, validateEmployeeBusinessValues, validateEmployeeBusinessLineItems } from './employee-business-contract'
import { rejectUnknownKeys, requireRecord } from '../validation'

/** What the employee is shown before an action whose request the wording did not settle; read-only, in their own terms. */
export interface EmployeeBusinessConfirmation { action: string; record: string; fields: Array<{ label: string; value: string }> }
export interface EmployeeBusinessTurn {
  accountKey: string; sessionPath: string; messageId: string; employeePrompt: string; cwd: string
  materials: WorkspaceMaterialPromptReference[]; readOnly: boolean
  inputSources?(): Promise<BusinessInputSource[]>
  /** Puts the action in front of the employee; resolves false when they decline, walk away or no window can ask. */
  confirm?(request: EmployeeBusinessConfirmation): Promise<boolean>
  presentRecord?(record: EmployeeBusinessRecord): { name: string; record_key: string }
  assertCurrent(): Promise<void>
}
type Service = Pick<EnterpriseService, 'getEmployeeBusinessContext' | 'executeEmployeeBusinessAction' | 'getEmployeeBusinessOperation' | 'stageWorkMaterials'>
interface BoundDirectory { messageId: string; context: EmployeeBusinessContext; sources?: BusinessInputSource[] }
interface Intent {
  selection: EmployeeBusinessTarget; accountKey: string; messageId: string; request: EmployeeBusinessRequest
  inputEvidence?: DraftEvidence
  materials: FrozenMaterial[]; phase: 'prepared' | 'sent'; operation?: EmployeeBusinessOperation; actionLabel?: string
}
interface PendingOperation { intentKey: string }
type StoredSelection = EmployeeBusinessTarget & { anchored?: true }

function sessionKey(account: string, path: string) { return `employee-business-source:${account}:${digest(path)}` }
function scopeKey(account: string, source: EmployeeBusinessTarget, sessionPath: string) { return 'objectName' in source
  ? `employee-business-operation:${account}:creation:${digest(sessionPath)}:${source.objectName}`
  : `employee-business-operation:${account}:${source.record.objectName}:${source.record.recordId}` }
function terminal(operation?: EmployeeBusinessOperation) { return operation?.status === 'succeeded' || operation?.status === 'failed' }
function publicOperation(operation?: EmployeeBusinessOperation, actionLabel?: string, previous = false, presentRecord?: EmployeeBusinessTurn['presentRecord']) {
  const action = actionLabel ? `「${actionLabel}」` : '业务动作（旧记录未保存动作名称）'
  return operation ? {
    status: operation.status, repeated: operation.repeated, no_effect: operation.noEffect === true,
    ...(actionLabel ? { action_label: actionLabel } : {}),
    message: operation.status === 'succeeded' ? previous
      ? `Forge 已确认此前${action}成功；此回执不代表当前目录中的其他动作已办理，请核对当前业务状态。`
      : `Forge 已确认本次${action}成功，请按当前业务记录核对后续状态。`
      : operation.status === 'failed' ? 'Forge 已确认本次业务动作失败。' : '原操作结果仍待核对，没有重新执行。',
    records: operation.recordReferences?.map((record) => presentRecord ? presentRecord(record) : { name: record.label }),
  } : { status: 'unknown', message: '原操作结果暂无法核对，没有重新执行；请稍后从当前事项查询。' }
}
function affirmativeEnumLiteral(prompt: string, literal: string): boolean {
  if (!literal || /(如果|假如|除非|(?:^|[，。；\n])若)/.test(prompt)) return false
  return prompt.split(/[，。；,;\n]/).some((clause) => {
    const index = clause.indexOf(literal)
    if (index < 0) return false
    const surrounding = clause.slice(0, index) + clause.slice(index + literal.length)
    return !/(不|未|没|别|禁止|拒绝|取消)/.test(surrounding)
  })
}
function faithfulValues(prompt: string, values: EmployeeBusinessRequest['values'], parameters: EmployeeBusinessParameter[]) {
  for (const [name, value] of Object.entries(values)) {
    const parameter = parameters.find((item) => item.name === name)!
    const literal = String(value)
    const present = typeof value === 'number' ? new RegExp(`(^|[^\\d.\\-])${literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\d.])`).test(prompt) : prompt.includes(literal)
    const mapped = parameter.enumLabels?.find((entry) => entry.value === value)
    const uniqueLabel = mapped && parameter.enumLabels?.filter((entry) => entry.label === mapped.label).length === 1
    const selected = parameter.enum
      ? present && affirmativeEnumLiteral(prompt, literal) || uniqueLabel && affirmativeEnumLiteral(prompt, mapped.label)
      : present
    if (!selected) throw new Error('办理参数必须来自本轮员工明确原文；请明确提供准确日期、名称、金额和业务选项')
  }
}
/**
 * Negation of another named step is not negation of the current directory action.
 * Wording that neither asks for the action nor declines it is left for the employee to settle.
 */
function directoryActionIntent(prompt: string, label?: string, draft = false, record?: string): 'requested' | 'refused' | 'unclear' {
  if (/(?:只读|只看看|只分析|只查看|仅查看|讨论|了解|解释|介绍|如果|假如|除非|倾向|建议|你觉得|是否|能否|可否|如何|怎么|什么意思|是什么|算了|暂停|先等等|不授权|[?？])/.test(prompt)) return 'refused'
  const verbs = '办理|登记|记录|提交|创建|新增|新建|补充|修改|转换|转为|转成|生成|确认|同意|批准|保存|更新|执行|启动|操作|转|建|补'
  const canonical = (verb: string) => /^(?:转换|转为|转成|转)$/.test(verb) ? '转' : /^(?:创建|新增|新建|建)$/.test(verb) ? '创建' : verb === '补' ? '补充' : verb === '记录' ? '登记' : verb
  const currentVerb = label?.match(new RegExp(`^(?:${verbs})`))?.[0]
  const negative = new RegExp(`(?:不要|暂不|先不|禁止|不得|不想|不需要|不再|先别|别(?=(?:${verbs}))|不(?=(?:${verbs})))`)
  const normalize = (text: string) => text.replace(/转换为|转换成|转为|转成/g, '转').replace(/当前|这份|本次|\s/g, '')
  // Naming the bound record inside the request does not make it a request about another object.
  const ownRecord = record && record.length > 2 ? record : undefined
  let accepted = false
  for (const part of prompt.split(/[，,。；;！!\n]/)) {
    const clause = (ownRecord ? part.split(ownRecord).join('') : part).trim()
    if (negative.test(clause)) {
      const deniedVerbs = clause.match(new RegExp(verbs, 'g')) ?? []
      // Unscoped stop, same action, or generic execution denial always wins, even after a positive clause.
      if (!currentVerb || !deniedVerbs.length || deniedVerbs.some(verb => canonical(verb) === canonical(currentVerb) || /^(?:办理|执行|操作)$/.test(verb))
        || label && normalize(clause).includes(normalize(label))) return 'refused'
      continue
    }
    const escaped = label ? normalize(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : undefined
    const normalizedClause = normalize(clause)
    const labelRequest = escaped && (new RegExp(`^(?:请(?:你|帮我|协助我)?|帮我|麻烦(?:你)?|现在|立即)\\s*${escaped}`).test(normalizedClause)
      || new RegExp(`^${escaped}(?:一下|吧)?$`).test(normalizedClause))
    const directive = /^(?:请|帮我|麻烦|现在|立即|那就|就|先(?!前)|按|把|将)/.test(clause)
    const imperativeVerb = /^(?:办理|登记|提交|创建|新增|新建|补充|修改|转换|转为|转成|生成|确认|同意|批准|保存|更新|执行|启动)/.test(clause)
    const historicalStatement = /(?:上一轮|上次|先前|曾经|之前|已经|已完成|失败了|成功了|完成了|他说|对方说|模型说)/.test(clause)
    const requestedVerb = clause.match(new RegExp(verbs))?.[0]
    const target = currentVerb && label ? normalize(label.slice(currentVerb.length)) : undefined
    // A bound object may be omitted from a completed-state target, but another explicit object cannot replace it.
    const completedTarget = target?.match(/^.+?(已.+)$/)?.[1]
    const requestedTarget = requestedVerb ? normalize(clause.slice(clause.indexOf(requestedVerb) + requestedVerb.length)).replace(/(?:一下|吧)$/, '') : undefined
    const sameAction = currentVerb && requestedVerb && canonical(currentVerb) === canonical(requestedVerb)
      && Boolean(target && normalizedClause.includes(target) || completedTarget && requestedTarget === completedTarget)
    // A generic handling verb names no step itself; the directory label closing the clause does.
    const handlingNamedAction = Boolean(escaped) && new RegExp(`(?:办理|执行|操作).*${escaped}(?:一下|吧)?$`).test(normalizedClause)
    accepted ||= !historicalStatement && (Boolean(labelRequest) || (directive || imperativeVerb) && Boolean(sameAction || handlingNamedAction)
      || draft && directive && /(?:建吧|补吧)/.test(clause)
      // Without a fresh directory this can only reach the existing pending-operation lookup, never a new write.
      || !label && (directive || imperativeVerb) && Boolean(requestedVerb))
  }
  return accepted ? 'requested' : 'unclear'
}
function confirmationFields(action: EmployeeBusinessAction, selection: EmployeeBusinessTarget, values: EmployeeBusinessRequest['values'], lineItems: EmployeeBusinessRequest['lineItems'], file?: string): EmployeeBusinessConfirmation['fields'] {
  const names = 'objectName' in selection ? { ...selection.referenceFacts, sku_id: selection.skuNames } as Record<string, Record<string, { name: string }> | undefined> : {}
  const shown = (parameter: EmployeeBusinessParameter, value: unknown) => typeof value === 'boolean' ? value ? '是' : '否'
    : parameter.enumLabels?.find(entry => entry.value === value)?.label ?? names[parameter.name]?.[String(value)]?.name ?? String(value)
  const pairs = (parameters: EmployeeBusinessParameter[], row: Record<string, unknown>) => parameters.filter(parameter => row[parameter.name] !== undefined)
    .map(parameter => ({ label: parameter.label, value: shown(parameter, row[parameter.name]) }))
  const fileParameter = action.parameters.find(parameter => parameter.type === 'file')
  return [...pairs(action.parameters, values), ...(fileParameter && file ? [{ label: fileParameter.label, value: file }] : []),
    ...(lineItems ?? []).map((row, index) => ({ label: `明细 ${index + 1}`, value: pairs(action.lineItems!.fields, row).map(pair => `${pair.label} ${pair.value}`).join('，') }))]
}
/** Current employee actions share the native action entry point, with durable unknown-result fencing. */
export class EmployeeBusinessActions {
  private readonly directories = new Map<string, BoundDirectory>()
  private readonly running = new Map<string, Promise<unknown>>()
  /** The employee's answer for the current message of a session: the confirmed request, or false once declined. */
  private readonly confirmations = new Map<string, { messageId: string; answer: string | false }>()
  constructor(private readonly service: Service, private readonly store: HandoffStore) {}

  async bind(account: string, sessionPath: string, selection: EmployeeBusinessTarget, anchored = false): Promise<void> {
    const key = sessionKey(account, sessionPath)
    if (!anchored && (await this.store.inspect<StoredSelection>(key))?.value.anchored) return
    await this.store.checkpoint(key, digest(key), { ...structuredClone(selection), ...(anchored ? { anchored: true as const } : {}) })
    this.directories.delete(key)
  }
  async selection(account: string, sessionPath: string): Promise<EmployeeBusinessTarget | undefined> {
    const saved = (await this.store.inspect<StoredSelection>(sessionKey(account, sessionPath)))?.value
    return saved ? 'objectName' in saved ? { objectName: saved.objectName, source: saved.source, ...(saved.referenceFacts ? { referenceFacts: saved.referenceFacts } : {}), ...(saved.skuNames ? { skuNames: saved.skuNames } : {}), ...(saved.referenceIds ? { referenceIds: saved.referenceIds } : {}) } : { record: saved.record, source: saved.source } : undefined
  }
  async selectCreation(turn: EmployeeBusinessTurn, selection: EmployeeBusinessCreationSelection) {
    await turn.assertCurrent()
    await this.bind(turn.accountKey, turn.sessionPath, selection, true)
  }
  private async lookup(intentKey: string, turn: EmployeeBusinessTurn): Promise<Intent> {
    const saved = await this.store.inspect<Intent>(intentKey)
    if (!saved || saved.value.accountKey !== turn.accountKey) throw new Error('原操作不属于当前员工，不能继续')
    const intent = saved.value
    if (intent.phase === 'sent' && !terminal(intent.operation)) {
      try {
        const result = await this.service.getEmployeeBusinessOperation(intent.request.opKey)
        await turn.assertCurrent()
        this.match(result, intent.request)
        intent.operation = result
        await this.store.checkpoint(intentKey, saved.fingerprint, intent)
      } catch { await turn.assertCurrent() }
    }
    return intent
  }
  private match(operation: EmployeeBusinessOperation, request: EmployeeBusinessRequest) {
    if (operation.operationId !== request.opKey || operation.contextId !== request.contextId || operation.requestDigest !== employeeBusinessRequestDigest(request)) {
      throw new Error('业务动作回执与原请求不匹配，结果仍待核对')
    }
  }
  async list(turn: EmployeeBusinessTurn) {
    const selection = await this.selection(turn.accountKey, turn.sessionPath)
    if (!selection) throw new Error('请先从本人业务事项、业务消息或业务记录读取中选择当前记录')
    await turn.assertCurrent()
    const pending = await this.store.inspect<PendingOperation>(scopeKey(turn.accountKey, selection, turn.sessionPath))
    let previousIntent: Intent | undefined
    if (pending) {
      const prior = await this.lookup(pending.value.intentKey, turn)
      previousIntent = prior
      if (prior.phase === 'sent' && !terminal(prior.operation)) return { actions: [], operation: publicOperation(prior.operation, prior.actionLabel, true, turn.presentRecord) }
    }
    const context = await this.service.getEmployeeBusinessContext(selection)
    await turn.assertCurrent()
    if (Date.parse(context.expiresAt) <= Date.now()) throw new Error('本人业务动作上下文已过期，请重新打开')
    const allSources = context.actions.some(isDraftAction) && turn.inputSources ? await turn.inputSources() : undefined
    let remaining = 8000
    const sources = allSources?.slice(-8).reverse().filter(source => {
      if (source.text.length > remaining) return false
      remaining -= source.text.length; return true
    }).reverse()
    this.directories.set(sessionKey(turn.accountKey, turn.sessionPath), { messageId: turn.messageId, context, sources })
    return {
      ...(sources ? { input_sources: sources.map(({ source_ref, text }) => ({ source_ref, text })), input_sources_complete: false } : {}),
      status: context.actions.length ? 'available' : 'none', record: 'record' in context ? context.record.label : context.objectLabel,
      ...(previousIntent?.operation ? { previous_operation: publicOperation(previousIntent.operation, previousIntent.actionLabel, true, turn.presentRecord) } : {}),
      actions: context.actions.map(({ action_ref, label, description, parameters, lineItems }) => ({ action_ref, label, description, inputs: parameters, ...(lineItems ? { lineItems } : {}) })),
      message: '目录只说明当前可用动作。input_sources仅是本人本会话已核实的近期输入，不代表完整历史；缺少的来源不能推断。初始打开只读；办理须有员工本轮明确要求。文件仅取本轮实际选定的一件原件。',
    }
  }
  async run(turn: EmployeeBusinessTurn, raw: Record<string, unknown>): Promise<unknown> {
    rejectUnknownKeys(raw, ['turn_key', 'action_ref', 'values', 'lineItems', 'input_sources'], 'employee business action')
    if (turn.readOnly) throw new Error('打开业务事项只授权查看，请在新的员工消息中明确办理')
    const directory = this.directories.get(sessionKey(turn.accountKey, turn.sessionPath))
    const selectedDraft = directory?.messageId === turn.messageId ? directory.context.actions.find(item => item.action_ref === raw.action_ref) : undefined
    const intent = directoryActionIntent(turn.employeePrompt, selectedDraft?.label, Boolean(selectedDraft && isDraftAction(selectedDraft) && selectedDraft.capabilityId !== 'forge:action:forge_quotation.quotation_convert_to_contract'),
      selectedDraft && 'record' in directory!.context ? directory!.context.record.label : undefined)
    // Only an action from this turn's directory can be put to the employee; a refusal never is.
    const confirm = intent === 'unclear' && Boolean(selectedDraft && turn.confirm)
    if (intent !== 'requested' && !confirm) throw new Error('请在本轮明确要求办理当前业务动作')
    const selection = await this.selection(turn.accountKey, turn.sessionPath)
    if (!selection) throw new Error('当前没有已读取的业务目标')
    if ('objectName' in selection && (/[?？]/.test(turn.employeePrompt) || /(?:只|仅|先).{0,3}(?:查看|查询|看看|了解|分析|列出)|(?:如何|怎么|怎样|哪些字段|什么信息)/.test(turn.employeePrompt))) throw new Error('查看创建要求不授权写入，请在新消息中明确要求创建')
    const key = scopeKey(turn.accountKey, selection, turn.sessionPath)
    const prior = this.running.get(key)
    if (prior) { await prior; return this.run(turn, raw) }
    const operation = this.execute(turn, raw, selection, key, confirm)
    this.running.set(key, operation)
    try { return await operation } finally { this.running.delete(key) }
  }
  private async confirmed(turn: EmployeeBusinessTurn, fingerprint: string, request: EmployeeBusinessConfirmation) {
    const session = sessionKey(turn.accountKey, turn.sessionPath)
    const earlier = this.confirmations.get(session)
    if (earlier?.messageId === turn.messageId) {
      if (earlier.answer === fingerprint) return
      throw new Error(earlier.answer ? '本轮确认的办理内容已固定，不能替换参数或动作' : '员工本轮没有确认办理，请等待员工新的消息')
    }
    // Asked once per message: a second call while the first is open, or after it lapsed, is not another question.
    this.confirmations.set(session, { messageId: turn.messageId, answer: false })
    if (!await turn.confirm!(request)) throw new Error('员工本轮没有确认办理，请等待员工新的消息')
    this.confirmations.set(session, { messageId: turn.messageId, answer: fingerprint })
  }
  private async execute(turn: EmployeeBusinessTurn, raw: Record<string, unknown>, selection: EmployeeBusinessTarget, key: string, confirm = false) {
    const assertCurrent = async () => {
      await turn.assertCurrent()
      if (canonicalBusinessJSON(await this.selection(turn.accountKey, turn.sessionPath)) !== canonicalBusinessJSON(selection)) throw new Error('当前业务来源已变化，旧办理请求已停止')
    }
    await assertCurrent()
    const pending = await this.store.inspect<PendingOperation>(key)
    if (pending) {
      const prior = await this.lookup(pending.value.intentKey, turn)
      const sameMessage = prior.messageId === turn.messageId && prior.request.employeeMessage.sessionId === digest(turn.sessionPath)
      if (sameMessage && (prior.request.action_ref !== raw.action_ref || canonicalBusinessJSON(prior.request.values) !== canonicalBusinessJSON(raw.values) || canonicalBusinessJSON(prior.request.lineItems ?? null) !== canonicalBusinessJSON(raw.lineItems ?? null))) throw new Error('本轮操作内容已固定，不能替换参数或动作')
      if (prior.phase === 'sent' && (!terminal(prior.operation) || sameMessage)) return publicOperation(prior.operation, prior.actionLabel, !sameMessage, turn.presentRecord)
    }
    const directory = this.directories.get(sessionKey(turn.accountKey, turn.sessionPath))
    if (!directory || directory.messageId !== turn.messageId) throw new Error('请先读取本轮当前事项动作目录')
    const context = directory.context
    const action = context.actions.find((item) => item.action_ref === raw.action_ref)
    if (!action) throw new Error('动作引用不属于本轮目录')
    if (action.capabilityId === 'forge:action:forge_sales_contract.contract_draft_payment_term_update' && (/[?？]/.test(turn.employeePrompt) || /(?:只|仅|先).{0,3}(?:查看|查询|看看|了解|分析|列出)|(?:如何|怎么|怎样)/.test(turn.employeePrompt))) throw new Error('查看付款条款不授权修改，请在新消息中明确要求补充')
    const values = validateEmployeeBusinessValues(action.parameters, requireRecord(raw.values, 'values'), 'objectName' in selection && selection.objectName === 'forge_sales_lead')
    if ('objectName' in selection) {
      for (const name of ['customer_id', 'contact_id', 'opportunity_id', 'quotation_type_id', 'issuer_id']) {
        if (values[name] !== undefined && !action.parameters.find(p => p.name === name)?.enum?.includes(values[name])) throw new Error('业务引用尚未绑定，请先查找读取准确记录并刷新创建目录')
      }
    }
    const lineItems = validateEmployeeBusinessLineItems(action, raw.lineItems)
    let inputEvidence: DraftEvidence | undefined
    const draftKey = `${key}:draft-inputs`
    if (isDraftAction(action) && turn.inputSources) {
      const previous = (await this.store.inspect<DraftEvidence>(draftKey))?.value
      const currentSources = await turn.inputSources()
      inputEvidence = proveDraftInputs({ context, selection, action, values, lineItems, rawSources: raw.input_sources,
        sources: directory.sources ?? [], conflictSources: currentSources, messageId: turn.messageId, previous })
      assertDraftSourcesCurrent(inputEvidence, await turn.inputSources())
    } else {
      if (raw.input_sources !== undefined) throw new Error('当前动作不接受草稿来源参数')
      faithfulValues(turn.employeePrompt, values, action.parameters)
      for (const row of lineItems ?? []) faithfulValues(turn.employeePrompt, row, action.lineItems!.fields)
    }
    const assertContextCurrent = async () => {
      const current = await this.service.getEmployeeBusinessContext(selection)
      await turn.assertCurrent()
      if (current.contextVersion !== context.contextVersion || ('recordVersion' in current ? current.recordVersion : undefined) !== ('recordVersion' in context ? context.recordVersion : undefined)
        || canonicalBusinessJSON(current.actions) !== canonicalBusinessJSON(context.actions) || Date.parse(context.expiresAt) <= Date.now()) {
        throw new Error('当前业务记录或参数声明已变化，请重新读取后由员工提出新的办理要求')
      }
    }
    await assertContextCurrent()
    const fileParameter = action.parameters.find((p) => p.type === 'file')
    if (fileParameter && (turn.materials.length > 1 || fileParameter.required && turn.materials.length !== 1)) throw new Error('请在本轮只选择一份明确用于本动作的原件')
    const intentKey = `employee-business-intent:${turn.accountKey}:${digest(turn.sessionPath)}:${turn.messageId}`
    const fingerprint = digest(canonicalBusinessJSON({ selection, contextVersion: context.contextVersion, action: action.action_ref, values, ...(lineItems ? { lineItems } : {}), materials: turn.materials }))
    if (confirm) {
      await this.confirmed(turn, fingerprint, { action: action.label, record: 'record' in context ? context.record.label : context.objectLabel,
        fields: confirmationFields(action, selection, values, lineItems, turn.materials[0]?.name) })
      // The answer can arrive minutes later; nothing read before it is trusted afterwards.
      await assertCurrent()
      await assertContextCurrent()
    }
    let intent = await this.store.freeze<Intent>(intentKey, fingerprint, async () => ({
      selection, ...(inputEvidence ? { inputEvidence } : {}), accountKey: turn.accountKey, messageId: turn.messageId, phase: 'prepared', actionLabel: action.label,
      materials: fileParameter && turn.materials.length ? await freezeMaterials(turn.cwd, turn.materials.map(({ path, sha256 }) => ({ path, sha256 }))) : [],
      request: { version: '1', contextId: context.contextId, contextVersion: context.contextVersion, opKey: randomUUID(),
        employeeMessage: { sessionId: digest(turn.sessionPath), messageId: turn.messageId, sha256: digest(turn.employeePrompt) }, action_ref: action.action_ref, values, ...(lineItems ? { lineItems } : {}) },
    }))
    if (inputEvidence) await this.store.checkpoint(draftKey, digest(draftKey), inputEvidence)
    await this.store.checkpoint(key, digest(key), { intentKey })
    if (intent.phase === 'sent') return publicOperation((await this.lookup(intentKey, turn)).operation, intent.actionLabel, false, turn.presentRecord)
    if (intent.materials.length && !intent.request.file) {
      const resources = await this.service.stageWorkMaterials(intent.materials, assertCurrent, storedUploadProgress(this.store, intentKey))
      await assertCurrent()
      if (resources.length !== 1 || !fileParameter) throw new Error('本轮业务原件上传回执无效')
      const resource = resources[0], material = intent.materials[0]
      if (!resource.id || resource.sha256 !== material.sha256 || resource.bytes !== material.bytes || resource.name !== material.name) throw new Error('本轮原件上传回执与冻结材料不一致')
      intent.request.file = { parameter: fileParameter.name, fileId: resource.id, name: material.name, mediaType: material.mediaType, bytes: material.bytes, sha256: material.sha256 }
      intent = await this.store.checkpoint(intentKey, fingerprint, intent)
    }
    await assertCurrent()
    if (intent.inputEvidence) assertDraftSourcesCurrent(intent.inputEvidence, await turn.inputSources!())
    intent.phase = 'sent'
    await this.store.checkpoint(intentKey, fingerprint, intent)
    try {
      const result = await this.service.executeEmployeeBusinessAction(intent.request)
      await turn.assertCurrent()
      this.match(result, intent.request)
      intent.operation = result
      await this.store.checkpoint(intentKey, fingerprint, intent)
    } catch { await turn.assertCurrent() }
    return publicOperation(intent.operation, intent.actionLabel, false, turn.presentRecord)
  }
}
