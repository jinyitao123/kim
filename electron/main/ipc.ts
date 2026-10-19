import { ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type { ApplicationMenuName, AppMeta, CheckoutCatalog, EnterpriseHumanTask, EnterpriseWorkChoice, HarnessId, SessionChangeEvent, ThemeMode } from '../../src/types/api'
import type { AgentRpcManager } from './agent-rpc'
import type { GitService } from './git'
import type { CuaDriverService } from './cua-driver'
import type { ModelCatalogProvider } from './model-catalog'
import type { PluginService } from './plugins'
import type { PetService } from './pets'
import type { PrimeProviderService } from './providers'
import { ProjectAccountScopeChangedError, type ProjectService } from './projects'
import type { CheckoutService } from './checkouts'
import type { SettingsService } from './settings-schedules'
import type { AutomationService } from './schedules/service'
import type { HeartbeatService } from './schedules/heartbeats'
import type { SessionService } from './sessions'
import type { TerminalService } from './terminal'
import type { VoiceService } from './voice'
import type { UpdateService } from './updates'
import { approvalContextView, type EnterpriseService } from './enterprise'
import type { AgentEnterpriseBridge } from './enterprise/agent-bridge'
import type { TeamDevelopmentAgentBridge } from './development/agent-bridge'
import type { TeamDevelopmentContextInput, TeamDevelopmentProposalResult } from '../../src/types/team-workspace'
import type { TeamDevelopmentState } from '../../src/types/team-workspace'
import type { AgentBrowserService } from './browser/agent-service'
import { rejectUnknownKeys, requireExistingPath, requireInteger, requireRecord, requireString, requireWebUrl } from './validation'

interface Services {
  meta: AppMeta
  refreshHarnesses(): Promise<{ meta: AppMeta; settings: ReturnType<SettingsService['get']> }>
  popupApplicationMenu(sender: WebContents, menu: ApplicationMenuName, x: number, y: number): boolean
  setTitleBarTheme(sender: WebContents, theme: Exclude<ThemeMode, 'system'>): boolean
  projects: ProjectService
  checkouts: Record<HarnessId, CheckoutService>
  sessions: SessionService
  agents: AgentRpcManager
  terminals: TerminalService
  git: GitService
  plugins: PluginService
  providers: PrimeProviderService
  settings: SettingsService
  updates: UpdateService
  enterprise: EnterpriseService
  importEnterpriseConnection?(): Promise<import('../../src/types/api').EnterpriseConnectionImportResult>
  restartEnterpriseConnection?(): Promise<void>
  enterpriseBridge?: AgentEnterpriseBridge
  runAttention?: import('./enterprise/run-attention').RunAttentionService
  teamDevelopmentBridge?: TeamDevelopmentAgentBridge
  secretPrompts?: import('./secret-prompt').SecretPrompts
  actionConfirmations?: import('./action-confirmation').ActionConfirmations
  operationPrompts?: import('./operation-prompt').OperationPrompts
  updateTeamDevelopment(runtimeId: string, input: TeamDevelopmentContextInput): Promise<void>
  getTeamDevelopmentProposal(runtimeId: string): Promise<TeamDevelopmentProposalResult | undefined>
  getTeamDevelopmentState(runtimeId: string): Promise<TeamDevelopmentState>
  getTeamDevelopmentStateForSession(sessionFile: string): Promise<TeamDevelopmentState>
  cuaDriver: CuaDriverService
  heartbeats: HeartbeatService
  schedules: AutomationService
  browser: AgentBrowserService
  voice: VoiceService
  pets: PetService
  /** Pi Work counterparts; always constructed, even when the pi CLI is absent. */
  pi: HarnessServices
  /** Loom Work counterparts; always constructed, even when the loom executable is absent. */
  loom: HarnessServices
  /** Applies the persisted interface scale to every live app renderer. */
  applyInterfaceZoom?(scale: number): void
}

interface HarnessServices {
  providers?: Pick<PrimeProviderService, 'catalog' | 'saveApiKey' | 'logout'>
  projects: ProjectService
  sessions: SessionService
  agents: AgentRpcManager
  catalog: ModelCatalogProvider
  plugins: PluginService
}

/** Strict enum gate for the untrusted optional harness argument; absence means 'prime'. */
function requireHarness(value: unknown): HarnessId {
  if (value === undefined) return 'prime'
  if (value === 'prime' || value === 'pi' || value === 'loom') return value
  throw new TypeError('Invalid harness')
}

function requireApplicationMenu(value: unknown): ApplicationMenuName {
  if (value === 'file' || value === 'edit' || value === 'view' || value === 'window' || value === 'help') return value
  throw new TypeError('Invalid application menu')
}

function requireMenuCoordinate(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10_000) throw new TypeError('Invalid menu coordinate')
  return Math.round(value)
}

function requireResolvedTheme(value: unknown): Exclude<ThemeMode, 'system'> {
  if (value === 'light' || value === 'dark') return value
  throw new TypeError('Invalid resolved theme')
}

function requireEnterpriseWorkChoice(value: unknown): EnterpriseWorkChoice {
  const source = requireRecord(value, 'choice')
  const version = source.version
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) throw new TypeError('Invalid workflow version')
  if (!Array.isArray(source.businessCapabilityIds) || source.businessCapabilityIds.length > 32 || source.businessCapabilityIds.some((item) => typeof item !== 'string' || !item.startsWith('forge:action:') || item.length > 160)) throw new TypeError('Invalid business capabilities')
  return {
    teamId: requireString(source.teamId, 'teamId', { min: 1, max: 128 }), teamName: requireString(source.teamName, 'teamName', { min: 1, max: 300 }),
    workflowId: requireString(source.workflowId, 'workflowId', { min: 1, max: 128 }), workflowName: requireString(source.workflowName, 'workflowName', { min: 1, max: 300 }), version,
    businessCapabilityIds: [...new Set(source.businessCapabilityIds)],
  }
}

function requireEnterpriseHumanTask(value: unknown): Pick<EnterpriseHumanTask, 'runId' | 'interactionId' | 'inputRevisionID' | 'workbenchSessionID'> {
  const source = requireRecord(value, 'task')
  return { runId: requireString(source.runId, 'runId', { min: 1, max: 256 }), interactionId: requireString(source.interactionId, 'interactionId', { min: 1, max: 256 }),
    ...(source.inputRevisionID !== undefined ? { inputRevisionID: requireString(source.inputRevisionID, 'inputRevisionID', { min: 1, max: 128 }) } : {}),
    ...(source.workbenchSessionID !== undefined ? { workbenchSessionID: requireString(source.workbenchSessionID, 'workbenchSessionID', { min: 1, max: 256 }) } : {}) }
}

type IpcEvent = IpcMainInvokeEvent | IpcMainEvent

export function isTrustedRendererUrl(url: string, expectedRendererUrl: string): boolean {
  try {
    const actual = new URL(url)
    const expected = new URL(expectedRendererUrl)
    // Fragments never cross the document/security boundary; allow in-document anchors only.
    actual.hash = ''
    expected.hash = ''
    return actual.href === expected.href
  } catch { return false }
}

export interface IpcRegistration {
  authorize(webContents: WebContents): void
  revoke(webContentsId: number): void
  dispose(): void
  /**
   * Resolves on the renderer bootstrap's first `app:get-meta` invoke, which
   * only reaches its handler once `verify` has admitted an authorized sender on
   * the trusted main frame. Nothing else observes it, so no verification work
   * is added to the shared invoke path.
   */
  whenRendererReady: Promise<void>
}

let activeIpcRegistration: IpcRegistration | null = null

export function registerIpc(services: Services, expectedRendererUrl: string): IpcRegistration {
  if (activeIpcRegistration) {
    console.warn('registerIpc called while a previous registration was still active; disposing the previous registration')
    activeIpcRegistration.dispose()
  }
  const authorized = new Map<number, WebContents>()
  const invokeChannels: string[] = []
  const eventChannels: string[] = []
  let closed = false
  let announceRendererReady: (() => void) | null = null
  const whenRendererReady = new Promise<void>((resolve) => { announceRendererReady = resolve })

  const verify = (event: IpcEvent): void => {
    const trustedFrame = event.senderFrame === event.sender.mainFrame
      && isTrustedRendererUrl(event.senderFrame.url, expectedRendererUrl)
      && isTrustedRendererUrl(event.sender.getURL(), expectedRendererUrl)
    if (closed || !authorized.has(event.sender.id) || event.sender.isDestroyed() || !trustedFrame) throw new Error('IPC sender is not authorized')
  }
  const handle = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown | Promise<unknown>): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, ...args) => { verify(event); return listener(event, ...args) })
    invokeChannels.push(channel)
  }
  const on = (channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void): void => {
    const wrapped = (event: IpcMainEvent, ...args: unknown[]) => {
      try { verify(event); listener(event, ...args) } catch (error) { console.warn(`Rejected ${channel}:`, error instanceof Error ? error.message : error) }
    }
    // Symmetric with handle(): these are private fixed channels, so any prior listener is stale.
    ipcMain.removeAllListeners(channel)
    ipcMain.on(channel, wrapped)
    eventChannels.push(channel)
  }

  const projectServices: Record<HarnessId, ProjectService> = { prime: services.projects, pi: services.pi.projects, loom: services.loom.projects }
  const sessionServices: Record<HarnessId, SessionService> = { prime: services.sessions, pi: services.pi.sessions, loom: services.loom.sessions }
  const agentManagers: Record<HarnessId, AgentRpcManager> = { prime: services.agents, pi: services.pi.agents, loom: services.loom.agents }
  const pluginServices: Record<HarnessId, PluginService> = { prime: services.plugins, pi: services.pi.plugins, loom: services.loom.plugins }
  const projectsFor = (harness: HarnessId): ProjectService => projectServices[harness]
  const readProjectCatalog = async <T>(harness: HarnessId, read: () => Promise<T>, cancelled: () => T): Promise<T> => {
    const projects = projectsFor(harness)
    const revision = projects.scopeRevision
    try {
      const result = await read()
      return projects.scopeRevision === revision ? result : cancelled()
    } catch (error) {
      if (error instanceof ProjectAccountScopeChangedError) return cancelled()
      throw error
    }
  }
  const checkoutsFor = (harness: HarnessId): CheckoutService => services.checkouts[harness]
  const sessionsFor = (harness: HarnessId): SessionService => sessionServices[harness]
  const agentsFor = (harness: HarnessId): AgentRpcManager => agentManagers[harness]
  const pluginsFor = (harness: HarnessId): PluginService => pluginServices[harness]
  // Runtime ids route by ownership; ids no manager owns fall through to the
  // Prime manager so requireRuntime keeps its exact not-found semantics.
  const agentsForRuntime = (runtimeId: unknown): AgentRpcManager => {
    if (typeof runtimeId === 'string') {
      if (services.pi.agents.has(runtimeId)) return services.pi.agents
      if (services.loom.agents.has(runtimeId)) return services.loom.agents
    }
    return services.agents
  }
  /**
   * Routes a session file to the harness whose validated session root contains
   * it, using each service's own canonicalizing path authorization (never
   * substring checks). Paths no root accepts rethrow the Prime error, so
   * rejection shape and text are unchanged.
   */
  const sessionsForPath = async (filePath: unknown): Promise<{ harness: HarnessId; service: SessionService }> => {
    try {
      await services.sessions.requireSessionPath(filePath)
      return { harness: 'prime', service: services.sessions }
    } catch (primeError) {
      for (const harness of ['pi', 'loom'] as const) {
        try { await sessionServices[harness].requireSessionPath(filePath) } catch { continue }
        return { harness, service: sessionServices[harness] }
      }
      throw primeError
    }
  }
  /** Pi credentials stay CLI-owned; Prime authentication is managed by the app. */
  const cliOwnedProviderAuth: Partial<Record<HarnessId, string>> = {
    pi: 'Pi provider authentication is managed by the pi CLI',
    loom: 'Loom uses the providers connected for Prime Work; connect them there',
  }
  const requirePrimeProviderAuth = (harness: unknown): void => {
    const rejection = cliOwnedProviderAuth[requireHarness(harness)]
    if (rejection) throw new Error(rejection)
  }

  handle('app:get-meta', () => {
    announceRendererReady?.()
    announceRendererReady = null
    return services.meta
  })
  handle('app:refresh-harnesses', () => services.refreshHarnesses())
  handle('app:popup-menu', (event, menu, x, y) => services.popupApplicationMenu(event.sender, requireApplicationMenu(menu), requireMenuCoordinate(x), requireMenuCoordinate(y)))
  handle('app:set-title-bar-theme', (event, theme) => services.setTitleBarTheme(event.sender, requireResolvedTheme(theme)))
  handle('app:open-external', async (_event, url) => {
    try { await shell.openExternal(requireWebUrl(url, { mailto: true }), { activate: true }); return true } catch (error) {
      console.warn('Rejected app:open-external:', error instanceof Error ? error.message : error)
      return false
    }
  })
  handle('app:reveal-path', async (_event, path) => {
    let requested: string
    try { requested = await requireExistingPath(path) } catch (error) {
      console.warn('Rejected app:reveal-path:', error instanceof Error ? error.message : error)
      return false
    }
    const authorizations: Array<() => Promise<string> | string> = [
      () => services.projects.authorizePath(requested),
      () => services.sessions.requireSessionPath(requested),
      () => services.plugins.authorizeReveal(requested),
      () => services.pi.projects.authorizePath(requested),
      () => services.pi.sessions.requireSessionPath(requested),
      () => services.pi.plugins.authorizeReveal(requested),
      () => services.loom.projects.authorizePath(requested),
      () => services.loom.sessions.requireSessionPath(requested),
    ]
    for (const authorize of authorizations) {
      let authorized: string
      try { authorized = await authorize() } catch { continue /* denial here defers to the next authorization domain */ }
      try {
        shell.showItemInFolder(authorized)
        return true
      } catch (error) {
        console.warn('Rejected app:reveal-path:', error instanceof Error ? error.message : error)
        return false
      }
    }
    console.warn('Rejected app:reveal-path: no authorization domain covers the path')
    return false
  })
  handle('updates:get-state', () => services.updates.getState())
  handle('updates:check', () => services.updates.check())
  handle('updates:download-and-install', () => services.updates.downloadAndInstall())
  handle('enterprise:invalidate-handoff', (_event, runtimeId) => {
    const id = requireString(runtimeId, 'runtimeId', { min: 1, max: 256 })
    agentsForRuntime(id)
    services.enterpriseBridge?.invalidateHandoff(id)
  })
  handle('enterprise:get-status', () => services.enterprise.getStatus())
  handle('enterprise:import-connection', () => {
    if (!services.importEnterpriseConnection) throw new Error('组织连接导入不可用。')
    return services.importEnterpriseConnection()
  })
  handle('enterprise:restart-connection', () => {
    if (!services.restartEnterpriseConnection) throw new Error('应用重启不可用。')
    return services.restartEnterpriseConnection()
  })
  handle('enterprise:feishu-status', () => services.enterprise.getFeishuStatus())
  handle('enterprise:feishu-link-code', () => services.enterprise.createFeishuLinkCode())
  handle('enterprise:feishu-unlink', () => services.enterprise.unlinkFeishu())
  handle('enterprise:get-session', () => services.enterprise.getSession())
  handle('enterprise:sign-in', () => { services.enterpriseBridge?.invalidateAccount(); return services.enterprise.signIn() })
  handle('enterprise:cancel-sign-in', () => services.enterprise.cancelSignIn())
  handle('enterprise:reopen-sign-in', () => services.enterprise.reopenSignIn())
  handle('enterprise:sign-out', () => { services.enterpriseBridge?.invalidateAccount(); return services.enterprise.signOut() })
  handle('enterprise:team-workspace', (_event, command) => {
    const requested = requireRecord(command, 'command') as unknown as import('../../src/types/team-workspace').TeamWorkspaceCommand
    // Keys reach Weave only through the main process's own prompt.
    if (requested.action === 'configure-model-provider') throw new Error('组织模型只能通过对话中的配置工具办理')
    // Confirmations and secrets for these are taken by the main process's own dialogs.
    if (requested.action === 'workspace-apply') throw new Error('工作区操作只能通过对话中的办理工具办理')
    return services.enterprise.teamWorkspace(requested)
  })
  handle('enterprise:answer-secret-prompt', (_event, id, value) => {
    services.secretPrompts?.answer(requireString(id, 'id', { min: 1, max: 64 }), value === null || value === undefined ? undefined : requireString(value, 'value', { min: 1, max: 4096 }))
  })
  handle('enterprise:answer-action-confirmation', (_event, id, confirmed) => {
    services.actionConfirmations?.answer(requireString(id, 'id', { min: 1, max: 64 }), confirmed === true)
  })
  handle('enterprise:answer-operation-prompt', (_event, id, confirmed) => {
    services.operationPrompts?.answer(requireString(id, 'id', { min: 1, max: 64 }), confirmed === true)
  })
  handle('enterprise:update-team-development', (_event, runtimeId, input) => services.updateTeamDevelopment(requireString(runtimeId, 'runtimeId', { min: 1, max: 256 }), requireRecord(input, 'input') as unknown as TeamDevelopmentContextInput))
  handle('enterprise:invalidate-team-development-turn', (_event, runtimeId) => services.teamDevelopmentBridge?.invalidateEmployeeTurn(requireString(runtimeId, 'runtimeId', { min: 1, max: 256 })))
  handle('enterprise:get-team-development-proposal', (_event, runtimeId) => services.getTeamDevelopmentProposal(requireString(runtimeId, 'runtimeId', { min: 1, max: 256 })))
  handle('enterprise:get-team-development-state', (_event, runtimeId) => services.getTeamDevelopmentState(requireString(runtimeId, 'runtimeId', { min: 1, max: 256 })))
  handle('enterprise:get-team-development-state-for-session', (_event, sessionFile) => services.getTeamDevelopmentStateForSession(requireString(sessionFile, 'sessionFile', { min: 1, max: 4096 })))
  handle('enterprise:get-development-overview', () => services.enterprise.getDevelopmentOverview())
  handle('enterprise:get-business-capability-catalog', () => services.enterprise.getBusinessCapabilityCatalog())
  handle('enterprise:create-development-team', (_event, input) => services.enterprise.createDevelopmentTeam(requireRecord(input, 'input') as unknown as import('../../src/types/api').EnterpriseCreateTeamInput))
  handle('enterprise:update-development-team', (_event, input) => services.enterprise.updateDevelopmentTeam(requireRecord(input, 'input') as unknown as import('../../src/types/api').EnterpriseUpdateTeamInput))
  handle('enterprise:create-development-team-member', (_event, input) => services.enterprise.createDevelopmentTeamMember(requireRecord(input, 'input') as unknown as import('../../src/types/api').EnterpriseCreateTeamMemberInput))
  handle('enterprise:remove-development-team-member', (_event, teamId, memberId) => services.enterprise.removeDevelopmentTeamMember(requireString(teamId, 'teamId', { min: 1, max: 160 }), requireString(memberId, 'memberId', { min: 1, max: 160 })))
  handle('enterprise:create-development-workflow', (_event, input) => services.enterprise.createDevelopmentWorkflow(requireRecord(input, 'input') as unknown as import('../../src/types/api').EnterpriseCreateWorkflowInput))
  handle('enterprise:create-development-workflow-draft', (_event, workflowId) => services.enterprise.createDevelopmentWorkflowDraft(requireString(workflowId, 'workflowId', { min: 1, max: 160 })))
  handle('enterprise:update-development-workflow-draft', (_event, input) => services.enterprise.updateDevelopmentWorkflowDraft(requireRecord(input, 'input') as unknown as import('../../src/types/api').EnterpriseUpdateWorkflowDraftInput))
  handle('enterprise:validate-development-workflow', (_event, workflowId, version) => services.enterprise.validateDevelopmentWorkflow(requireString(workflowId, 'workflowId', { min: 1, max: 160 }), requireInteger(version, 'version', 1, 1_000_000)))
  handle('enterprise:publish-development-workflow', (_event, workflowId, version) => services.enterprise.publishDevelopmentWorkflow(requireString(workflowId, 'workflowId', { min: 1, max: 160 }), requireInteger(version, 'version', 1, 1_000_000)))
  handle('enterprise:archive-development-workflow', (_event, workflowId) => services.enterprise.archiveDevelopmentWorkflow(requireString(workflowId, 'workflowId', { min: 1, max: 160 })))
  handle('enterprise:get-team-member-config-draft', (_event, teamId, agentId) => services.enterprise.getTeamMemberConfigDraft(requireString(teamId, 'teamId', { min: 1, max: 160 }), requireString(agentId, 'agentId', { min: 1, max: 160 })))
  handle('enterprise:save-team-member-config-draft', (_event, draft) => services.enterprise.saveTeamMemberConfigDraft(requireRecord(draft, 'draft') as unknown as import('../../src/types/api').EnterpriseTeamMemberConfigDraft))
  handle('enterprise:apply-team-member-config-draft', (_event, teamId, agentId, revision) => services.enterprise.applyTeamMemberConfigDraft(requireString(teamId, 'teamId', { min: 1, max: 160 }), requireString(agentId, 'agentId', { min: 1, max: 160 }), requireInteger(revision, 'revision', 1, 1_000_000)))
  handle('enterprise:get-work-overview', () => services.enterprise.getWorkOverview())
  handle('enterprise:get-work-run-states', (_event, runIds) => services.enterprise.getWorkRunStates(runIds as string[]))
  handle('enterprise:resolve-work-session', async (_event, sessionReference) => await services.runAttention?.resolveSession(requireString(sessionReference, 'sessionReference', { min: 1, max: 512 })) ?? null)
  handle('enterprise:take-pending-work-open', () => services.runAttention?.takePendingOpen() ?? null)
  handle('enterprise:poll-work-attention', () => { services.runAttention?.pollSoon() })
  handle('enterprise:get-work-run-details', (_event, runId) => services.enterprise.getWorkRunDetails(requireString(runId, 'runId', { min: 1, max: 128 })))
  handle('enterprise:cancel-work', (_event, runId) => services.enterprise.cancelWork(requireString(runId, 'runId', { min: 1, max: 128 })))
  handle('enterprise:get-approval-context', async (_event, approvalId) => approvalContextView(await services.enterprise.getApprovalContext(requireString(approvalId, 'approvalId', { min: 1, max: 128 }))))
  handle('enterprise:pin-returned-approval-context', (_event, approvalId) => {
    if (!services.enterpriseBridge) throw new Error('桌面退回事项能力暂不可用')
    return services.enterpriseBridge.pinReturnedApprovalContext(requireString(approvalId, 'approvalId', { min: 1, max: 128 }))
  })
  handle('enterprise:pin-approval-review-context', (_event, approvalId) => {
    if (!services.enterpriseBridge) throw new Error('桌面审批辅助能力暂不可用')
    return services.enterpriseBridge.pinApprovalReviewContext(requireString(approvalId, 'approvalId', { min: 1, max: 128 }))
  })
  handle('enterprise:pin-work-continuation-context', (_event, rawItem) => {
    if (!services.enterpriseBridge) throw new Error('桌面团队续接能力暂不可用')
    const item = requireRecord(rawItem, 'item')
    rejectUnknownKeys(item, ['id', 'source', 'notificationType', 'workReference', 'runReference', 'sessionReference'], 'item')
    if (item.source === 'forge') return services.enterpriseBridge.pinWorkContinuationContext({
      id: requireString(item.id, 'item.id', { min: 1, max: 128 }),
      source: 'forge',
      ...(item.notificationType !== undefined ? { notificationType: requireString(item.notificationType, 'item.notificationType', { min: 1, max: 128 }) } : {}),
    })
    if (item.source !== 'weave') throw new TypeError('item.source must be weave or forge')
    return services.enterpriseBridge.pinWorkContinuationContext({
      id: requireString(item.id, 'item.id', { min: 1, max: 128 }),
      source: 'weave',
      ...(item.notificationType !== undefined ? { notificationType: requireString(item.notificationType, 'item.notificationType', { min: 1, max: 128 }) } : {}),
      ...(item.workReference !== undefined ? { workReference: requireString(item.workReference, 'item.workReference', { min: 1, max: 512 }) } : {}),
      ...(item.runReference !== undefined ? { runReference: requireString(item.runReference, 'item.runReference', { min: 1, max: 512 }) } : {}),
      ...(item.sessionReference !== undefined ? { sessionReference: requireString(item.sessionReference, 'item.sessionReference', { min: 1, max: 512 }) } : {}),
    })
  })
  handle('enterprise:pin-employee-business-context', (_event, value) => {
    if (!services.enterpriseBridge) throw new Error('本人业务事项暂不可用')
    const record = requireRecord(value, 'record')
    rejectUnknownKeys(record, ['objectName', 'recordId', 'label'], 'record')
    return services.enterpriseBridge.pinEmployeeBusinessContext({
      objectName: requireString(record.objectName, 'objectName', { min: 1, max: 128 }),
      recordId: requireString(record.recordId, 'recordId', { min: 1, max: 128 }),
      label: requireString(record.label, 'label', { min: 1, max: 300 }),
    })
  })
  handle('enterprise:submit-work', (_event, choice, goal) => services.enterprise.submitWork(requireEnterpriseWorkChoice(choice), requireString(goal, 'goal', { min: 1, max: 20_000 })))
  handle('enterprise:complete-human-task', (_event, task, payload) => services.enterprise.completeHumanTask(requireEnterpriseHumanTask(task), requireRecord(payload, 'payload')))

  handle('projects:list', (_event, value) => {
    const harness = requireHarness(value)
    return readProjectCatalog(harness, () => projectsFor(harness).list(), () => [])
  })
  handle('projects:list-files', (_event, root, harness) => projectsFor(requireHarness(harness)).listFiles(root))
  handle('projects:import-text-material', (_event, projectId, workspacePath, name, bytes, harness) => projectsFor(requireHarness(harness)).importTextMaterial(projectId, workspacePath, name, bytes))
  handle('projects:list-checkouts', (_event, projectId, value) => {
    const harness = requireHarness(value)
    return readProjectCatalog<CheckoutCatalog>(harness, () => checkoutsFor(harness).list(projectId), () => services.settings.get().checkoutStrategy === 'worktree' ? { strategy: 'worktree', activePath: '', checkouts: [] } : { strategy: 'branch', activeName: '', checkouts: [] })
  })
  handle('projects:execute-checkout', (_event, projectId, action, harness) => checkoutsFor(requireHarness(harness)).execute(projectId, action))
  handle('projects:add', (_event, harness) => projectsFor(requireHarness(harness)).add())
  handle('projects:grant-inferred', (_event, path, harness) => projectsFor(requireHarness(harness)).grantInferred(path))
  handle('projects:remove', (_event, id, harness) => projectsFor(requireHarness(harness)).remove(id))
  handle('projects:touch', (_event, id, harness) => projectsFor(requireHarness(harness)).touch(id))
  handle('projects:pin', (_event, id, pinned, harness) => projectsFor(requireHarness(harness)).setPinned(id, pinned))
  handle('projects:update-scripts', (_event, id, scripts, harness) => projectsFor(requireHarness(harness)).updateScripts(id, scripts))
  handle('projects:mark-setup-started', (_event, id, setup, harness) => projectsFor(requireHarness(harness)).markSetupStarted(id, setup))
  handle('projects:finish-setup', (_event, id, setup, exitCode, harness) => projectsFor(requireHarness(harness)).finishSetup(id, setup, exitCode))

  handle('sessions:list', (_event, projectPath, includeArchived, harness, force) => sessionsFor(requireHarness(harness)).list(projectPath, includeArchived, force))
  handle('sessions:read', async (_event, filePath) => (await sessionsForPath(filePath)).service.read(filePath))
  handle('sessions:follow-up', async (_event, filePath, message, intent) => {
    const routed = await sessionsForPath(filePath)
    // Daemon-socket follow-up is Prime-only; a Pi session answers
    // exactly like an inactive Prime session instead of a new error shape.
    if (routed.harness !== 'prime') return false
    return routed.service.followUp(filePath, message, intent)
  })
  handle('sessions:rename', async (_event, filePath, title) => (await sessionsForPath(filePath)).service.rename(filePath, title))
  handle('sessions:archive', async (_event, filePath, archived) => {
    const routed = await sessionsForPath(filePath)
    const result = await routed.service.archive(filePath, archived)
    if (archived === true) {
      services.browser.closeForSession(filePath)
      await services.terminals.killForSession(filePath)
    }
    return result
  })

  handle('agent:start', (_event, rawOptions) => {
    const options = requireRecord(rawOptions, 'options')
    const harness = requireHarness(options.harness)
    // The manager start schema rejects unknown keys; the routing field must
    // not reach it.
    const { harness: _harness, ...startOptions } = options
    return agentsFor(harness).start(startOptions)
  })
  handle('agent:command', async (_event, runtimeId, command, deliveryContext) => {
    const id = requireString(runtimeId, 'runtimeId', { min: 1, max: 256 })
    const commandValue = requireRecord(command, 'command')
    const manager = agentsForRuntime(id)
    const delivery = deliveryContext === undefined ? undefined : requireRecord(deliveryContext, 'deliveryContext')
    if (delivery) rejectUnknownKeys(delivery, ['returnedApprovalContextHandle', 'approvalReviewContextHandle', 'workContinuationContextHandle', 'employeeInput'], 'deliveryContext')
    const approvalContextHandle = delivery?.returnedApprovalContextHandle
    const approvalReviewContextHandle = delivery?.approvalReviewContextHandle
    const workContinuationContextHandle = delivery?.workContinuationContextHandle
    if (approvalContextHandle !== undefined && typeof approvalContextHandle !== 'string') throw new TypeError('deliveryContext.returnedApprovalContextHandle must be a string')
    if (approvalReviewContextHandle !== undefined && typeof approvalReviewContextHandle !== 'string') throw new TypeError('deliveryContext.approvalReviewContextHandle must be a string')
    if (workContinuationContextHandle !== undefined && typeof workContinuationContextHandle !== 'string') throw new TypeError('deliveryContext.workContinuationContextHandle must be a string')
    const current = manager.list().find((runtime) => runtime.runtimeId === id)
    if (current?.sessionFile) {
      services.enterpriseBridge?.bindRuntimeSession(id, current.sessionFile)
      services.teamDevelopmentBridge?.bindRuntimeSession(id, current.sessionFile)
    }
    services.teamDevelopmentBridge?.beginEmployeeCommand(id, commandValue.type)
    if (delivery?.employeeInput !== undefined && !['prompt', 'steer', 'follow_up'].includes(commandValue.type as string)) throw new TypeError('Employee input only belongs to an employee message')
    const invalidatesEmployeeTurn = ['prompt', 'steer', 'follow_up', 'abort', 'compact'].includes(commandValue.type as string)
    try {
      await services.enterpriseBridge?.employeeCommand(id, command, approvalContextHandle, workContinuationContextHandle, approvalReviewContextHandle, delivery?.employeeInput)
      await services.teamDevelopmentBridge?.captureTrustedEmployeeCommand(id, commandValue, delivery?.employeeInput)
      return await manager.command(id, command)
    } catch (error) {
      if (invalidatesEmployeeTurn) services.teamDevelopmentBridge?.invalidateEmployeeTurn(id)
      throw error
    }
  })
  handle('agent:stop', (_event, runtimeId) => agentsForRuntime(runtimeId).stop(runtimeId))
  handle('agent:list', () => [...services.agents.list(), ...services.pi.agents.list(), ...services.loom.agents.list()])

  const providerCatalog = (force = false) => services.providers.catalog(force, new Set(services.settings.get().disabledProviders), new Set(services.settings.get().disabledModels))
  const piProviderCatalog = async (force = false) => {
    const disabled = new Set(services.settings.get().piDisabledProviders), models = new Set(services.settings.get().piDisabledModels)
    const native = await services.pi.catalog.catalog(force, disabled, models)
    if (!services.pi.providers) return native
    const credentials = await services.pi.providers.catalog(force, disabled, models)
    const available = new Map(native.providers.map(provider => [provider.id, provider]))
    return { ...native, providers: [...credentials.providers.map(provider => {
      const actual = available.get(provider.id)
      available.delete(provider.id)
      return { ...provider, authMethod: provider.authMethod === 'api_key' ? 'api_key' as const : 'external' as const,
        modelCount: actual?.modelCount ?? 0, availableModelCount: actual?.availableModelCount ?? 0 }
    }), ...available.values()] }
  }
  const providerCatalogs: Record<HarnessId, (force?: boolean) => ReturnType<ModelCatalogProvider['catalog']>> = {
    prime: providerCatalog, pi: piProviderCatalog,
    // Loom runs Prime Work's connected providers and shares their visibility settings.
    loom: (force = false) => services.loom.catalog.catalog(force, new Set(services.settings.get().disabledProviders), new Set(services.settings.get().disabledModels)),
  }
  /** Desktop-owned provider/model visibility settings keys per harness. */
  const disabledProvidersKeys = { prime: 'disabledProviders', pi: 'piDisabledProviders', loom: 'disabledProviders' } as const
  const disabledModelsKeys = { prime: 'disabledModels', pi: 'piDisabledModels', loom: 'disabledModels' } as const
  handle('providers:catalog', (_event, force, harness) => providerCatalogs[requireHarness(harness)](force === true))
  handle('providers:save-api-key', async (_event, providerId, apiKey, harness) => {
    const target = requireHarness(harness)
    const store = target === 'prime' ? services.providers : target === 'pi' ? services.pi.providers : undefined
    if (!store) { requirePrimeProviderAuth(harness); throw new Error('当前助手的模型配置不可用') }
    await store.saveApiKey(providerId, apiKey)
    return providerCatalogs[target](true)
  })
  handle('providers:logout', async (_event, providerId, harness) => {
    const target = requireHarness(harness)
    const store = target === 'prime' ? services.providers : target === 'pi' ? services.pi.providers : undefined
    if (!store) { requirePrimeProviderAuth(harness); throw new Error('当前助手的模型配置不可用') }
    await store.logout(providerId)
    return providerCatalogs[target](true)
  })
  handle('providers:set-enabled', async (_event, providerId, enabled, harness) => {
    const target = requireHarness(harness)
    const id = requireString(providerId, 'providerId', { min: 1, max: 128, trim: true })
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean')
    const catalog = await providerCatalogs[target]()
    if (!catalog.providers.some((provider) => provider.id === id)) throw new Error('Provider was not found')
    const providerSettingsKey = disabledProvidersKeys[target]
    const modelSettingsKey = disabledModelsKeys[target]
    const settings = services.settings.get()
    const disabledProviders = new Set(settings[providerSettingsKey])
    const disabledModels = new Set(settings[modelSettingsKey])
    if (enabled) {
      disabledProviders.delete(id)
      for (const model of catalog.models) if (model.provider === id) disabledModels.delete(model.key)
    } else disabledProviders.add(id)
    await services.settings.update({
      [providerSettingsKey]: [...disabledProviders].sort(),
      [modelSettingsKey]: [...disabledModels].sort(),
    })
    return providerCatalogs[target]()
  })
  handle('providers:set-disabled', async (_event, providerIds, harness) => {
    const target = requireHarness(harness)
    if (!Array.isArray(providerIds) || providerIds.length > 256) throw new TypeError('providerIds must be a bounded array')
    const ids = [...new Set(providerIds.map((value, index) => requireString(value, `providerIds[${index}]`, { min: 1, max: 128, trim: true })))].sort()
    const catalog = await providerCatalogs[target]()
    const known = new Set(catalog.providers.map((provider) => provider.id))
    if (ids.some((id) => !known.has(id))) throw new Error('Provider was not found')
    const providerSettingsKey = disabledProvidersKeys[target]
    const modelSettingsKey = disabledModelsKeys[target]
    const disabledModels = ids.length ? services.settings.get()[modelSettingsKey] : []
    await services.settings.update({ [providerSettingsKey]: ids, [modelSettingsKey]: disabledModels })
    return providerCatalogs[target]()
  })
  handle('providers:set-model-enabled', async (_event, modelKey, enabled, harness) => {
    const target = requireHarness(harness)
    const key = requireString(modelKey, 'modelKey', { min: 3, max: 385, trim: true })
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean')
    const catalog = await providerCatalogs[target]()
    const model = catalog.models.find((candidate) => candidate.key === key)
    if (!model) throw new Error('Model was not found')
    const provider = catalog.providers.find((candidate) => candidate.id === model.provider)
    if (!provider) throw new Error('Provider was not found')
    const providerSettingsKey = disabledProvidersKeys[target]
    const modelSettingsKey = disabledModelsKeys[target]
    const settings = services.settings.get()
    const disabledProviders = new Set(settings[providerSettingsKey])
    const disabledModels = new Set(settings[modelSettingsKey])
    const siblingKeys = catalog.models.filter((candidate) => candidate.provider === model.provider).map((candidate) => candidate.key)
    if (enabled) {
      if (!provider.enabled) {
        disabledProviders.delete(model.provider)
        for (const siblingKey of siblingKeys) if (siblingKey !== key) disabledModels.add(siblingKey)
      }
      disabledModels.delete(key)
    } else {
      disabledModels.add(key)
      if (!siblingKeys.some((siblingKey) => !disabledModels.has(siblingKey))) disabledProviders.add(model.provider)
    }
    await services.settings.update({
      [providerSettingsKey]: [...disabledProviders].sort(),
      [modelSettingsKey]: [...disabledModels].sort(),
    })
    return providerCatalogs[target]()
  })
  handle('providers:start-oauth', (_event, providerId, harness) => {
    requirePrimeProviderAuth(harness)
    return services.providers.startOAuth(providerId)
  })
  handle('providers:respond-oauth', (_event, flowId, promptId, value) => services.providers.respondOAuth(flowId, promptId, value))
  handle('providers:cancel-oauth', (_event, flowId) => services.providers.cancelOAuth(flowId))

  handle('voice:credential-status', () => services.voice.credentialStatus())
  handle('voice:save-api-key', (_event, provider, apiKey) => services.voice.saveApiKey(provider, apiKey))
  handle('voice:delete-api-key', (_event, provider) => services.voice.deleteApiKey(provider))
  handle('voice:create-realtime-call', (_event, request) => services.voice.createRealtimeCall(request))
  handle('voice:transcribe', (_event, request) => services.voice.transcribe(request))
  handle('voice:test-self-hosted', (_event, request) => services.voice.testSelfHosted(request))
  handle('voice:execute-tool', (_event, request, harness) => services.voice.executeTool(request, requireHarness(harness)))

  handle('pets:list', () => services.pets.list())
  handle('pets:sprite', (_event, id) => services.pets.sprite(id))

  handle('terminal:create', (event, options) => services.terminals.create(event.sender, options))
  handle('terminal:bind-session', (event, terminalId, sessionPath) => services.terminals.bindSession(event.sender, terminalId, sessionPath))
  on('terminal:input', (event, terminalId, data) => services.terminals.input(event.sender, terminalId, data))
  on('terminal:resize', (event, terminalId, cols, rows) => services.terminals.resize(event.sender, terminalId, cols, rows))
  on('terminal:set-active-context', (event, terminalId, context) => services.terminals.setActiveContext(event.sender, terminalId, context))
  on('terminal:clear-active-context', (event, terminalId) => services.terminals.clearActiveContext(event.sender, terminalId))
  handle('terminal:kill', (event, terminalId) => services.terminals.kill(event.sender, terminalId))

  handle('git:status', (_event, cwd) => services.git.status(cwd))
  handle('git:diff', (_event, cwd, path, staged) => services.git.diff(cwd, path, staged))
  handle('git:stage', (_event, cwd, paths) => services.git.stage(cwd, paths))
  handle('git:unstage', (_event, cwd, paths) => services.git.unstage(cwd, paths))
  handle('git:restore', (_event, cwd, paths) => services.git.restore(cwd, paths))
  handle('git:commit', (_event, cwd, message) => services.git.commit(cwd, message))

  handle('plugins:list', (_event, projectPath, harness) => pluginsFor(requireHarness(harness)).list(projectPath))
  handle('plugins:install', (_event, source, harness) => pluginsFor(requireHarness(harness)).install(source))
  handle('plugins:install-extension', (_event, input, harness) => pluginsFor(requireHarness(harness)).installExtension(input))
  handle('plugins:set-mcp-support', (_event, enabled, harness) => pluginsFor(requireHarness(harness)).setMcpSupport(enabled))
  handle('plugins:connect-mcp', (_event, input, harness) => pluginsFor(requireHarness(harness)).connectMcp(input))
  handle('plugins:set-mcp-enabled', (_event, input, harness) => pluginsFor(requireHarness(harness)).setMcpEnabled(input))
  handle('plugins:mutate-capability', (_event, input, harness) => pluginsFor(requireHarness(harness)).mutateCapability(input))
  handle('plugins:refresh', (_event, harness) => pluginsFor(requireHarness(harness)).refresh())

  handle('settings:get', () => services.settings.get())
  handle('settings:update', async (_event, patch) => {
    const previous = services.settings.get()
    const patchRecord = requireRecord(patch, 'settings patch')
    if (patchRecord.computerUseEnabled === true && !previous.computerUseEnabled) await services.cuaDriver.requireAvailable()
    const settings = await services.settings.update(patch)
    if (settings.interfaceFontScale !== previous.interfaceFontScale) services.applyInterfaceZoom?.(settings.interfaceFontScale)
    if (settings.askUserEnabled !== previous.askUserEnabled || settings.browserEnabled !== previous.browserEnabled || settings.computerUseEnabled !== previous.computerUseEnabled) {
      await Promise.all([
        services.agents.requestRuntimeEnvironmentRefresh(),
        services.pi.agents.requestRuntimeEnvironmentRefresh(),
        services.loom.agents.requestRuntimeEnvironmentRefresh(),
      ])
    }
    return settings
  })
  handle('settings:reset-browser-data', () => services.settings.resetBrowserData())

  handle('browser:state', () => services.browser.state())
  handle('browser:attach-tab', (_event, tabId, webContentsId) => services.browser.attachTab(tabId, webContentsId))
  handle('browser:select-tab', (_event, tabId) => services.browser.selectTab(tabId))
  handle('browser:close-tab', (_event, tabId) => services.browser.closeTab(tabId))
  handle('browser:set-preview-context', (_event, webContentsId, sessionFile) => services.browser.setPreviewContext(webContentsId, sessionFile))
  handle('browser:navigate-tab', (_event, tabId, action, url) => services.browser.navigateTab(tabId, action, url))

  handle('heartbeats:list', () => services.heartbeats.list())
  handle('heartbeats:manage', (_event, id, action) => services.heartbeats.manage(id, action))

  handle('schedules:list', (_event, harness) => services.schedules.list(requireHarness(harness)))
  handle('schedules:get', (_event, id) => services.schedules.get(id))
  handle('schedules:preview', (_event, timing, count) => services.schedules.preview(timing, count))
  handle('schedules:create', (_event, input, harness) => services.schedules.create(input, 'user', requireHarness(harness)))
  handle('schedules:update', (_event, id, patch) => services.schedules.update(id, patch))
  handle('schedules:pause', (_event, id) => services.schedules.pause(id))
  handle('schedules:resume', (_event, id) => services.schedules.resume(id))
  handle('schedules:delete', (_event, id) => services.schedules.delete(id))
  handle('schedules:run-now', (_event, id) => services.schedules.runNow(id))

  const forwardSessionChange = (change: SessionChangeEvent): void => {
    for (const [id, contents] of authorized) {
      if (contents.isDestroyed()) { authorized.delete(id); continue }
      if (isTrustedRendererUrl(contents.getURL(), expectedRendererUrl)
        && isTrustedRendererUrl(contents.mainFrame.url, expectedRendererUrl)) contents.send('sessions:changed', change)
    }
  }
  const unsubscribeSessionChanges = services.sessions.onDidChange(forwardSessionChange)
  const unsubscribePiSessionChanges = services.pi.sessions.onDidChange(forwardSessionChange)
  const unsubscribeLoomSessionChanges = services.loom.sessions.onDidChange(forwardSessionChange)
  const scheduleSubscription = services.schedules.onDidChange((change) => {
    for (const [id, contents] of authorized) {
      if (contents.isDestroyed()) { authorized.delete(id); continue }
      if (isTrustedRendererUrl(contents.getURL(), expectedRendererUrl)
        && isTrustedRendererUrl(contents.mainFrame.url, expectedRendererUrl)) contents.send('schedules:changed', change)
    }
  })
  const unsubscribeScheduleChanges = typeof scheduleSubscription === 'function' ? scheduleSubscription : () => undefined
  const browserSubscription = services.browser.onDidChange((state) => {
    for (const [id, contents] of authorized) {
      if (contents.isDestroyed()) { authorized.delete(id); continue }
      if (isTrustedRendererUrl(contents.getURL(), expectedRendererUrl)
        && isTrustedRendererUrl(contents.mainFrame.url, expectedRendererUrl)) contents.send('browser:changed', state)
    }
  })
  const unsubscribeBrowserChanges = typeof browserSubscription === 'function' ? browserSubscription : () => undefined
  const pointerSubscription = services.browser.onPointer((event) => {
    for (const [id, contents] of authorized) {
      if (contents.isDestroyed()) { authorized.delete(id); continue }
      if (isTrustedRendererUrl(contents.getURL(), expectedRendererUrl)
        && isTrustedRendererUrl(contents.mainFrame.url, expectedRendererUrl)) contents.send('browser:pointer', event)
    }
  })
  const unsubscribeBrowserPointer = typeof pointerSubscription === 'function' ? pointerSubscription : () => undefined
  const activitySubscription = services.browser.onActivity((event) => {
    for (const [id, contents] of authorized) {
      if (contents.isDestroyed()) { authorized.delete(id); continue }
      if (isTrustedRendererUrl(contents.getURL(), expectedRendererUrl)
        && isTrustedRendererUrl(contents.mainFrame.url, expectedRendererUrl)) contents.send('browser:activity', event)
    }
  })
  const unsubscribeBrowserActivity = typeof activitySubscription === 'function' ? activitySubscription : () => undefined

  const registration: IpcRegistration = {
    whenRendererReady,
    authorize(webContents) { if (!closed) authorized.set(webContents.id, webContents) },
    revoke(webContentsId) { authorized.delete(webContentsId); void services.terminals.killOwner(webContentsId) },
    dispose() {
      if (closed) return
      closed = true
      if (activeIpcRegistration === registration) activeIpcRegistration = null
      authorized.clear()
      unsubscribeSessionChanges()
      unsubscribePiSessionChanges()
      unsubscribeLoomSessionChanges()
      if (typeof unsubscribeScheduleChanges === 'function') unsubscribeScheduleChanges()
      if (typeof unsubscribeBrowserChanges === 'function') unsubscribeBrowserChanges()
      if (typeof unsubscribeBrowserPointer === 'function') unsubscribeBrowserPointer()
      if (typeof unsubscribeBrowserActivity === 'function') unsubscribeBrowserActivity()
      for (const channel of invokeChannels) ipcMain.removeHandler(channel)
      // Event listeners are removed wholesale only for our private fixed channels.
      for (const channel of eventChannels) ipcMain.removeAllListeners(channel)
    },
  }
  activeIpcRegistration = registration
  return registration
}
