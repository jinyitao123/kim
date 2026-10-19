import { contextBridge, ipcRenderer } from 'electron'
import type { ActionConfirmationEvent, AgentBrowserActivityEvent, AgentBrowserPointerEvent, AgentBrowserState, AppUpdateState, EnterpriseEnvironmentStatus, EnterpriseSession, OperationPromptEvent, SecretPromptEvent, PrimeEventEnvelope, PrimeWorkApi, ProviderAuthEvent, ScheduleChangeEvent, SessionChangeEvent, TerminalDataEvent, TerminalExitEvent } from '../../src/types/api'

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function')
  const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
    if (typeof payload === 'object' && payload !== null) callback(payload as T)
  }
  ipcRenderer.on(channel, listener)
  return () => { ipcRenderer.removeListener(channel, listener) }
}

function subscribeSignal(channel: string, callback: () => void): () => void {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function')
  const listener = (): void => callback()
  ipcRenderer.on(channel, listener)
  return () => { ipcRenderer.removeListener(channel, listener) }
}

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args).catch((error: unknown) => {
    if (!(error instanceof Error)) throw error
    const match = /^Error invoking remote method '[^']+': ([A-Za-z_$][\w$]*): ([\s\S]*)$/.exec(error.message)
    if (!match) throw error
    console.error('Electron IPC invocation failed:', error)
    const unwrapped = new Error(match[2])
    Object.setPrototypeOf(unwrapped, Object.getPrototypeOf(error))
    unwrapped.name = error.name
    Object.defineProperty(unwrapped, 'cause', { value: error, configurable: true })
    throw unwrapped
  })
}

const api: PrimeWorkApi = {
  app: {
    getMeta: () => invoke('app:get-meta'),
    refreshHarnesses: () => invoke('app:refresh-harnesses'),
    openExternal: (url) => invoke('app:open-external', url),
    revealPath: (path) => invoke('app:reveal-path', path),
    popupMenu: (menu, x, y) => invoke('app:popup-menu', menu, x, y),
    setTitleBarTheme: (theme) => invoke('app:set-title-bar-theme', theme),
    onOpenSettings: (callback) => subscribeSignal('app:open-settings', callback),
  },
  updates: {
    getState: () => invoke('updates:get-state'),
    check: () => invoke('updates:check'),
    downloadAndInstall: () => invoke('updates:download-and-install'),
    onChanged: (callback) => subscribe<AppUpdateState>('updates:changed', callback),
  },
  enterprise: {
    importConnection: () => invoke('enterprise:import-connection'),
    restartConnection: () => invoke('enterprise:restart-connection'),
    teamWorkspace: (command) => invoke('enterprise:team-workspace', command),
    updateTeamDevelopment: (runtimeId, input) => invoke('enterprise:update-team-development', runtimeId, input),
    invalidateTeamDevelopmentTurn: (runtimeId) => invoke('enterprise:invalidate-team-development-turn', runtimeId),
    getTeamDevelopmentProposal: (runtimeId) => invoke('enterprise:get-team-development-proposal', runtimeId),
    getTeamDevelopmentState: (runtimeId) => invoke('enterprise:get-team-development-state', runtimeId),
    getTeamDevelopmentStateForSession: (sessionFile) => invoke('enterprise:get-team-development-state-for-session', sessionFile),
    invalidateHandoff: (runtimeId) => invoke('enterprise:invalidate-handoff', runtimeId),
    getStatus: () => invoke<EnterpriseEnvironmentStatus[]>('enterprise:get-status'),
    getFeishuStatus: () => invoke('enterprise:feishu-status'),
    createFeishuLinkCode: () => invoke('enterprise:feishu-link-code'),
    unlinkFeishu: () => invoke('enterprise:feishu-unlink'),
    getSession: () => invoke<EnterpriseSession>('enterprise:get-session'),
    signIn: () => invoke<EnterpriseSession>('enterprise:sign-in'),
    cancelSignIn: () => invoke<EnterpriseSession>('enterprise:cancel-sign-in'),
    reopenSignIn: () => invoke<void>('enterprise:reopen-sign-in'),
    signOut: () => invoke<EnterpriseSession>('enterprise:sign-out'),
    onSessionChanged: (callback) => subscribe<EnterpriseSession>('enterprise:session-changed', callback),
    onSecretPrompt: (callback) => subscribe<SecretPromptEvent>('enterprise:secret-prompt', callback),
    answerSecretPrompt: (id, value) => invoke<void>('enterprise:answer-secret-prompt', id, value),
    onActionConfirmation: (callback) => subscribe<ActionConfirmationEvent>('enterprise:action-confirmation', callback),
    answerActionConfirmation: (id, confirmed) => invoke<void>('enterprise:answer-action-confirmation', id, confirmed),
    onOperationPrompt: (callback) => subscribe<OperationPromptEvent>('enterprise:operation-prompt', callback),
    answerOperationPrompt: (id, confirmed) => invoke<void>('enterprise:answer-operation-prompt', id, confirmed),
    getDevelopmentOverview: () => invoke('enterprise:get-development-overview'),
    getBusinessCapabilityCatalog: () => invoke('enterprise:get-business-capability-catalog'),
    createDevelopmentTeam: (input) => invoke('enterprise:create-development-team', input),
    updateDevelopmentTeam: (input) => invoke('enterprise:update-development-team', input),
    createDevelopmentTeamMember: (input) => invoke('enterprise:create-development-team-member', input),
    removeDevelopmentTeamMember: (teamId, memberId) => invoke('enterprise:remove-development-team-member', teamId, memberId),
    createDevelopmentWorkflow: (input) => invoke('enterprise:create-development-workflow', input),
    createDevelopmentWorkflowDraft: (workflowId) => invoke('enterprise:create-development-workflow-draft', workflowId),
    updateDevelopmentWorkflowDraft: (input) => invoke('enterprise:update-development-workflow-draft', input),
    validateDevelopmentWorkflow: (workflowId, version) => invoke('enterprise:validate-development-workflow', workflowId, version),
    publishDevelopmentWorkflow: (workflowId, version) => invoke('enterprise:publish-development-workflow', workflowId, version),
    archiveDevelopmentWorkflow: (workflowId) => invoke('enterprise:archive-development-workflow', workflowId),
    getTeamMemberConfigDraft: (teamId, agentId) => invoke('enterprise:get-team-member-config-draft', teamId, agentId),
    saveTeamMemberConfigDraft: (draft) => invoke('enterprise:save-team-member-config-draft', draft),
    applyTeamMemberConfigDraft: (teamId, agentId, revision) => invoke('enterprise:apply-team-member-config-draft', teamId, agentId, revision),
    getWorkOverview: () => invoke('enterprise:get-work-overview'),
    getWorkRunStates: (runIds) => invoke('enterprise:get-work-run-states', runIds),
    getWorkRunDetails: (runId) => invoke('enterprise:get-work-run-details', runId),
    cancelWork: (runId) => invoke('enterprise:cancel-work', runId),
    getApprovalContext: (approvalId) => invoke('enterprise:get-approval-context', approvalId),
    pinReturnedApprovalContext: (approvalId) => invoke('enterprise:pin-returned-approval-context', approvalId),
    pinApprovalReviewContext: (approvalId) => invoke('enterprise:pin-approval-review-context', approvalId),
    pinWorkContinuationContext: (item) => invoke('enterprise:pin-work-continuation-context', item),
    pinEmployeeBusinessContext: (record) => invoke('enterprise:pin-employee-business-context', record),
    submitWork: (choice, goal) => invoke('enterprise:submit-work', choice, goal),
    completeHumanTask: (task, payload) => invoke('enterprise:complete-human-task', task, payload),
  },
  projects: {
    list: (harness) => invoke('projects:list', harness),
    listFiles: (root, harness) => invoke('projects:list-files', root, harness),
    importTextMaterial: (projectId, workspacePath, name, bytes, harness) => invoke('projects:import-text-material', projectId, workspacePath, name, bytes, harness),
    listCheckouts: (projectId, harness) => invoke('projects:list-checkouts', projectId, harness),
    executeCheckout: (projectId, action, harness) => invoke('projects:execute-checkout', projectId, action, harness),
    add: (harness) => invoke('projects:add', harness),
    grantInferred: (path, harness) => invoke('projects:grant-inferred', path, harness),
    remove: (id, harness) => invoke('projects:remove', id, harness),
    touch: (id, harness) => invoke('projects:touch', id, harness),
    setPinned: (id, pinned, harness) => invoke('projects:pin', id, pinned, harness),
    updateScripts: (id, scripts, harness) => invoke('projects:update-scripts', id, scripts, harness),
    markSetupStarted: (id, setup, harness) => invoke('projects:mark-setup-started', id, setup, harness),
    finishSetup: (id, setup, exitCode, harness) => invoke('projects:finish-setup', id, setup, exitCode, harness),
  },
  sessions: {
    list: (projectPath, includeArchived, harness, force) => invoke('sessions:list', projectPath, includeArchived, harness, force),
    read: (filePath) => invoke('sessions:read', filePath),
    followUp: (filePath, message, intent) => invoke('sessions:follow-up', filePath, message, intent),
    rename: (filePath, title) => invoke('sessions:rename', filePath, title),
    archive: (filePath, archived) => invoke('sessions:archive', filePath, archived),
    onChanged: (callback) => subscribe<SessionChangeEvent>('sessions:changed', callback),
  },
  agent: {
    start: (options) => invoke('agent:start', options),
    command: (runtimeId, command, deliveryContext) => invoke('agent:command', runtimeId, command, deliveryContext),
    stop: (runtimeId) => invoke('agent:stop', runtimeId),
    list: () => invoke('agent:list'),
    onEvent: (callback) => subscribe<PrimeEventEnvelope>('agent:event', callback),
  },
  providers: {
    catalog: (force, harness) => invoke('providers:catalog', force, harness),
    saveApiKey: (providerId, apiKey, harness) => invoke('providers:save-api-key', providerId, apiKey, harness),
    logout: (providerId, harness) => invoke('providers:logout', providerId, harness),
    setEnabled: (providerId, enabled, harness) => invoke('providers:set-enabled', providerId, enabled, harness),
    setDisabled: (providerIds, harness) => invoke('providers:set-disabled', providerIds, harness),
    setModelEnabled: (modelKey, enabled, harness) => invoke('providers:set-model-enabled', modelKey, enabled, harness),
    startOAuth: (providerId) => invoke('providers:start-oauth', providerId),
    respondOAuth: (flowId, promptId, value) => invoke('providers:respond-oauth', flowId, promptId, value),
    cancelOAuth: (flowId) => invoke('providers:cancel-oauth', flowId),
    onAuthEvent: (callback) => subscribe<ProviderAuthEvent>('providers:auth-event', callback),
  },
  voice: {
    credentialStatus: () => invoke('voice:credential-status'),
    saveApiKey: (provider, apiKey) => invoke('voice:save-api-key', provider, apiKey),
    deleteApiKey: (provider) => invoke('voice:delete-api-key', provider),
    createRealtimeCall: (request) => invoke('voice:create-realtime-call', request),
    transcribe: (request) => invoke('voice:transcribe', request),
    testSelfHosted: (request) => invoke('voice:test-self-hosted', request),
    executeTool: (request, harness) => invoke('voice:execute-tool', request, harness),
  },
  pets: {
    list: () => invoke('pets:list'),
    sprite: (id) => invoke('pets:sprite', id),
  },
  terminal: {
    create: (options) => invoke('terminal:create', options),
    bindSession: (terminalId, sessionPath) => invoke('terminal:bind-session', terminalId, sessionPath),
    input: (terminalId, data) => { ipcRenderer.send('terminal:input', terminalId, data) },
    resize: (terminalId, cols, rows) => { ipcRenderer.send('terminal:resize', terminalId, cols, rows) },
    setActiveContext: (terminalId, context) => { ipcRenderer.send('terminal:set-active-context', terminalId, context) },
    clearActiveContext: (terminalId) => { ipcRenderer.send('terminal:clear-active-context', terminalId) },
    kill: (terminalId) => invoke('terminal:kill', terminalId),
    onData: (callback) => subscribe<TerminalDataEvent>('terminal:data', callback),
    onExit: (callback) => subscribe<TerminalExitEvent>('terminal:exit', callback),
  },
  git: {
    status: (cwd) => invoke('git:status', cwd),
    diff: (cwd, path, staged) => invoke('git:diff', cwd, path, staged),
    stage: (cwd, paths) => invoke('git:stage', cwd, paths),
    unstage: (cwd, paths) => invoke('git:unstage', cwd, paths),
    restore: (cwd, paths) => invoke('git:restore', cwd, paths),
    commit: (cwd, message) => invoke('git:commit', cwd, message),
  },
  plugins: {
    list: (projectPath, harness) => invoke('plugins:list', projectPath, harness),
    install: (source, harness) => invoke('plugins:install', source, harness),
    installExtension: (input, harness) => invoke('plugins:install-extension', input, harness),
    setMcpSupport: (enabled, harness) => invoke('plugins:set-mcp-support', enabled, harness),
    connectMcp: (input, harness) => invoke('plugins:connect-mcp', input, harness),
    setMcpEnabled: (input, harness) => invoke('plugins:set-mcp-enabled', input, harness),
    mutateCapability: (input, harness) => invoke('plugins:mutate-capability', input, harness),
    refresh: (harness) => invoke('plugins:refresh', harness),
  },
  settings: {
    get: () => invoke('settings:get'),
    update: (patch) => invoke('settings:update', patch),
    resetBrowserData: () => invoke('settings:reset-browser-data'),
  },
  browser: {
    state: () => invoke('browser:state'),
    attachTab: (tabId, webContentsId) => invoke('browser:attach-tab', tabId, webContentsId),
    selectTab: (tabId) => invoke('browser:select-tab', tabId),
    closeTab: (tabId) => invoke('browser:close-tab', tabId),
    setPreviewContext: (webContentsId, sessionFile) => invoke('browser:set-preview-context', webContentsId, sessionFile),
    navigateTab: (tabId, action, url) => invoke('browser:navigate-tab', tabId, action, url),
    onChanged: (callback) => subscribe<AgentBrowserState>('browser:changed', callback),
    onPointer: (callback) => subscribe<AgentBrowserPointerEvent>('browser:pointer', callback),
    onActivity: (callback) => subscribe<AgentBrowserActivityEvent>('browser:activity', callback),
  },
  heartbeats: {
    list: () => invoke('heartbeats:list'),
    manage: (id, action) => invoke('heartbeats:manage', id, action),
  },
  schedules: {
    list: (harness) => invoke('schedules:list', harness),
    get: (id) => invoke('schedules:get', id),
    preview: (timing, count) => invoke('schedules:preview', timing, count),
    create: (input, harness) => invoke('schedules:create', input, harness),
    update: (id, patch) => invoke('schedules:update', id, patch),
    pause: (id) => invoke('schedules:pause', id),
    resume: (id) => invoke('schedules:resume', id),
    delete: (id) => invoke('schedules:delete', id),
    runNow: (id) => invoke('schedules:run-now', id),
    onChanged: (callback) => subscribe<ScheduleChangeEvent>('schedules:changed', callback),
  },
}

for (const domain of Object.values(api)) Object.freeze(domain)
contextBridge.exposeInMainWorld('prime', Object.freeze(api))
