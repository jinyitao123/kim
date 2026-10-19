import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => ({
  api: undefined as unknown,
  contextBridge: { exposeInMainWorld: vi.fn((_name: string, api: unknown) => { electronMocks.api = api }) },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn(), send: vi.fn() },
}))

vi.mock('electron', () => ({ contextBridge: electronMocks.contextBridge, ipcRenderer: electronMocks.ipcRenderer }))

await import('../../electron/preload/index')

type BridgeApi = Record<string, Record<string, (...args: unknown[]) => unknown>>

const INVOKE_CASES: Array<[domain: string, method: string, channel: string, args: unknown[], expectedArgs?: unknown[]]> = [
  ['app', 'getMeta', 'app:get-meta', []],
  ['app', 'refreshHarnesses', 'app:refresh-harnesses', []],
  ['app', 'openExternal', 'app:open-external', ['https://example.com']],
  ['app', 'revealPath', 'app:reveal-path', ['/repo/file']],
  ['app', 'popupMenu', 'app:popup-menu', ['file', 10, 20]],
  ['app', 'setTitleBarTheme', 'app:set-title-bar-theme', ['dark']],
  ['updates', 'getState', 'updates:get-state', []],
  ['updates', 'check', 'updates:check', []],
  ['updates', 'downloadAndInstall', 'updates:download-and-install', []],
  ['projects', 'list', 'projects:list', ['omp']],
  ['projects', 'listFiles', 'projects:list-files', ['/repo', 'omp']],
  ['projects', 'listCheckouts', 'projects:list-checkouts', ['project-id', 'omp']],
  ['projects', 'executeCheckout', 'projects:execute-checkout', ['project-id', { strategy: 'branch', operation: 'switch', branch: 'feature' }, 'omp']],
  ['projects', 'add', 'projects:add', ['omp']],
  ['projects', 'grantInferred', 'projects:grant-inferred', ['/repo', 'omp']],
  ['projects', 'remove', 'projects:remove', ['project-id', 'omp']],
  ['projects', 'touch', 'projects:touch', ['project-id', 'omp']],
  ['projects', 'setPinned', 'projects:pin', ['project-id', true, 'omp']],
  ['projects', 'updateScripts', 'projects:update-scripts', ['project-id', { setup: 'npm install', run: 'npm run dev' }, 'omp']],
  ['projects', 'markSetupStarted', 'projects:mark-setup-started', ['project-id', 'npm install', 'omp']],
  ['projects', 'finishSetup', 'projects:finish-setup', ['project-id', 'npm install', 0, 'omp']],
  ['sessions', 'list', 'sessions:list', ['/repo', true, 'omp', true]],
  ['sessions', 'read', 'sessions:read', ['/session.jsonl']],
  ['sessions', 'followUp', 'sessions:follow-up', ['/session.jsonl', 'next', 'queue']],
  ['sessions', 'rename', 'sessions:rename', ['/session.jsonl', 'Title']],
  ['sessions', 'archive', 'sessions:archive', ['/session.jsonl', true]],
  ['agent', 'start', 'agent:start', [{ cwd: '/repo' }]],
  ['agent', 'command', 'agent:command', ['runtime', { type: 'abort' }, undefined]],
  ['agent', 'command', 'agent:command', ['runtime', { type: 'prompt', message: 'full runtime input' }, { employeeInput: { text: 'employee input', materials: [] } }]],
  ['agent', 'stop', 'agent:stop', ['runtime']],
  ['agent', 'list', 'agent:list', []],
  ['providers', 'catalog', 'providers:catalog', [true, 'omp']],
  ['providers', 'saveApiKey', 'providers:save-api-key', ['openai', 'secret'], ['openai', 'secret', undefined]],
  ['providers', 'saveApiKey', 'providers:save-api-key', ['openai', 'secret', 'pi']],
  ['providers', 'logout', 'providers:logout', ['openai'], ['openai', undefined]],
  ['providers', 'logout', 'providers:logout', ['openai', 'pi']],
  ['providers', 'setEnabled', 'providers:set-enabled', ['openai', false, 'omp']],
  ['providers', 'setDisabled', 'providers:set-disabled', [['openai'], 'omp']],
  ['providers', 'setModelEnabled', 'providers:set-model-enabled', ['openai/model', true, 'omp']],
  ['providers', 'startOAuth', 'providers:start-oauth', ['openai']],
  ['providers', 'respondOAuth', 'providers:respond-oauth', ['flow', 'prompt', 'value']],
  ['providers', 'cancelOAuth', 'providers:cancel-oauth', ['flow']],
  ['voice', 'credentialStatus', 'voice:credential-status', []],
  ['voice', 'saveApiKey', 'voice:save-api-key', ['openai', 'secret']],
  ['voice', 'deleteApiKey', 'voice:delete-api-key', ['openai']],
  ['voice', 'createRealtimeCall', 'voice:create-realtime-call', [{ mode: 'transcription', sdp: 'sdp' }]],
  ['voice', 'transcribe', 'voice:transcribe', [{ provider: 'openai', audioBase64: 'audio' }]],
  ['voice', 'testSelfHosted', 'voice:test-self-hosted', [{ url: 'https://voice.example' }]],
  ['voice', 'executeTool', 'voice:execute-tool', [{ name: 'list_projects', arguments: {} }, 'omp']],
  ['terminal', 'create', 'terminal:create', [{ cwd: '/repo' }]],
  ['terminal', 'bindSession', 'terminal:bind-session', ['terminal', '/session.jsonl']],
  ['terminal', 'kill', 'terminal:kill', ['terminal']],
  ['git', 'status', 'git:status', ['/repo']],
  ['git', 'diff', 'git:diff', ['/repo', 'file.ts', true]],
  ['git', 'stage', 'git:stage', ['/repo', ['file.ts']]],
  ['git', 'unstage', 'git:unstage', ['/repo', ['file.ts']]],
  ['git', 'restore', 'git:restore', ['/repo', ['file.ts']]],
  ['git', 'commit', 'git:commit', ['/repo', 'message']],
  ['plugins', 'list', 'plugins:list', ['/repo', 'omp']],
  ['plugins', 'install', 'plugins:install', ['npm:example', 'omp']],
  ['plugins', 'installExtension', 'plugins:install-extension', [{ source: '/extension.ts', scope: 'user' }, 'omp']],
  ['plugins', 'setMcpSupport', 'plugins:set-mcp-support', [true, 'pi']],
  ['plugins', 'connectMcp', 'plugins:connect-mcp', [{ name: 'docs' }, 'omp']],
  ['plugins', 'setMcpEnabled', 'plugins:set-mcp-enabled', [{ name: 'docs', enabled: true }, 'omp']],
  ['plugins', 'mutateCapability', 'plugins:mutate-capability', [{ kind: 'mcp', action: 'remove' }, 'omp']],
  ['plugins', 'refresh', 'plugins:refresh', ['omp']],
  ['enterprise', 'teamWorkspace', 'enterprise:team-workspace', [{ type: 'open' }]],
  ['enterprise', 'updateTeamDevelopment', 'enterprise:update-team-development', ['runtime', { teamId: 'team', revision: 1 }]],
  ['enterprise', 'invalidateTeamDevelopmentTurn', 'enterprise:invalidate-team-development-turn', ['runtime']],
  ['enterprise', 'getTeamDevelopmentProposal', 'enterprise:get-team-development-proposal', ['runtime']],
  ['enterprise', 'getTeamDevelopmentState', 'enterprise:get-team-development-state', ['runtime']],
  ['enterprise', 'getTeamDevelopmentStateForSession', 'enterprise:get-team-development-state-for-session', ['/session.jsonl']],
  ['enterprise', 'invalidateHandoff', 'enterprise:invalidate-handoff', ['runtime']],
  ['enterprise', 'importConnection', 'enterprise:import-connection', []],
  ['enterprise', 'restartConnection', 'enterprise:restart-connection', []],
  ['enterprise', 'getStatus', 'enterprise:get-status', []],
  ['enterprise', 'getFeishuStatus', 'enterprise:feishu-status', []],
  ['enterprise', 'createFeishuLinkCode', 'enterprise:feishu-link-code', []],
  ['enterprise', 'unlinkFeishu', 'enterprise:feishu-unlink', []],
  ['enterprise', 'getSession', 'enterprise:get-session', []],
  ['enterprise', 'signIn', 'enterprise:sign-in', []],
  ['enterprise', 'cancelSignIn', 'enterprise:cancel-sign-in', []],
  ['enterprise', 'reopenSignIn', 'enterprise:reopen-sign-in', []],
  ['enterprise', 'signOut', 'enterprise:sign-out', []],
  ['enterprise', 'answerSecretPrompt', 'enterprise:answer-secret-prompt', ['prompt-1', null]],
  ['enterprise', 'answerActionConfirmation', 'enterprise:answer-action-confirmation', ['confirmation-1', true]],
  ['enterprise', 'answerOperationPrompt', 'enterprise:answer-operation-prompt', ['prompt-1', true]],
  ['enterprise', 'getDevelopmentOverview', 'enterprise:get-development-overview', []],
  ['enterprise', 'getBusinessCapabilityCatalog', 'enterprise:get-business-capability-catalog', []],
  ['enterprise', 'createDevelopmentTeam', 'enterprise:create-development-team', [{ name: '测试团队' }]],
  ['enterprise', 'updateDevelopmentTeam', 'enterprise:update-development-team', [{ teamId: 'team', objective: '整理测试反馈' }]],
  ['enterprise', 'createDevelopmentTeamMember', 'enterprise:create-development-team-member', [{ teamId: 'team', name: '整理员' }]],
  ['enterprise', 'removeDevelopmentTeamMember', 'enterprise:remove-development-team-member', ['team', 'member']],
  ['enterprise', 'createDevelopmentWorkflow', 'enterprise:create-development-workflow', [{ teamId: 'team', name: '单流程' }]],
  ['enterprise', 'createDevelopmentWorkflowDraft', 'enterprise:create-development-workflow-draft', ['workflow']],
  ['enterprise', 'updateDevelopmentWorkflowDraft', 'enterprise:update-development-workflow-draft', [{ workflowId: 'workflow', document: {} }]],
  ['enterprise', 'validateDevelopmentWorkflow', 'enterprise:validate-development-workflow', ['workflow', 1]],
  ['enterprise', 'publishDevelopmentWorkflow', 'enterprise:publish-development-workflow', ['workflow', 1]],
  ['enterprise', 'archiveDevelopmentWorkflow', 'enterprise:archive-development-workflow', ['workflow']],
  ['enterprise', 'getTeamMemberConfigDraft', 'enterprise:get-team-member-config-draft', ['team', 'member']],
  ['enterprise', 'saveTeamMemberConfigDraft', 'enterprise:save-team-member-config-draft', [{ teamId: 'team', agentId: 'member', revision: 1 }]],
  ['enterprise', 'applyTeamMemberConfigDraft', 'enterprise:apply-team-member-config-draft', ['team', 'member', 1]],
  ['enterprise', 'getWorkOverview', 'enterprise:get-work-overview', []],
  ['enterprise', 'getWorkRunStates', 'enterprise:get-work-run-states', [['run-current', 'run-previous']]],
  ['enterprise', 'getWorkRunDetails', 'enterprise:get-work-run-details', ['run-current']],
  ['enterprise', 'cancelWork', 'enterprise:cancel-work', ['run-original']],
  ['enterprise', 'getApprovalContext', 'enterprise:get-approval-context', ['approval']],
  ['enterprise', 'pinReturnedApprovalContext', 'enterprise:pin-returned-approval-context', ['approval']],
  ['enterprise', 'pinApprovalReviewContext', 'enterprise:pin-approval-review-context', ['approval']],
  ['enterprise', 'pinWorkContinuationContext', 'enterprise:pin-work-continuation-context', [{ id: 'message' }]],
  ['enterprise', 'pinEmployeeBusinessContext', 'enterprise:pin-employee-business-context', [{ objectName: 'sales_contract', recordId: 'contract', label: '合同' }]],
  ['enterprise', 'submitWork', 'enterprise:submit-work', [{ teamId: 'team' }, '只读分析']],
  ['enterprise', 'completeHumanTask', 'enterprise:complete-human-task', [{ runId: 'run-original', interactionId: 'task', inputRevisionID: 'input-original', workbenchSessionID: 'session-original' }, { decision: 'approved' }]],
  ['projects', 'importTextMaterial', 'projects:import-text-material', ['project', '/workspace/material.md', 'material.md', new Uint8Array([1]), 'pi']],
  ['settings', 'get', 'settings:get', []],
  ['settings', 'update', 'settings:update', [{ theme: 'dark' }]],
  ['settings', 'resetBrowserData', 'settings:reset-browser-data', []],
  ['browser', 'state', 'browser:state', []],
  ['browser', 'attachTab', 'browser:attach-tab', ['tab', 7]],
  ['browser', 'selectTab', 'browser:select-tab', ['tab']],
  ['browser', 'closeTab', 'browser:close-tab', ['tab']],
  ['browser', 'setPreviewContext', 'browser:set-preview-context', [7, '/session.jsonl']],
  ['browser', 'navigateTab', 'browser:navigate-tab', ['tab', 'navigate', 'https://example.com']],
  ['heartbeats', 'list', 'heartbeats:list', []],
  ['heartbeats', 'manage', 'heartbeats:manage', ['heartbeat', 'pause']],
  ['schedules', 'list', 'schedules:list', ['omp']],
  ['schedules', 'get', 'schedules:get', ['schedule']],
  ['schedules', 'preview', 'schedules:preview', [{ kind: 'once', at: '2026-08-26T00:00:00Z' }, 3]],
  ['schedules', 'create', 'schedules:create', [{ prompt: 'work' }, 'omp']],
  ['schedules', 'update', 'schedules:update', ['schedule', { title: 'Updated' }]],
  ['schedules', 'pause', 'schedules:pause', ['schedule']],
  ['schedules', 'resume', 'schedules:resume', ['schedule']],
  ['schedules', 'delete', 'schedules:delete', ['schedule']],
  ['schedules', 'runNow', 'schedules:run-now', ['schedule']],
]

const SUBSCRIPTION_CASES: Array<[domain: string, method: string, channel: string]> = [
  ['updates', 'onChanged', 'updates:changed'],
  ['enterprise', 'onSessionChanged', 'enterprise:session-changed'],
  ['enterprise', 'onSecretPrompt', 'enterprise:secret-prompt'],
  ['enterprise', 'onActionConfirmation', 'enterprise:action-confirmation'],
  ['enterprise', 'onOperationPrompt', 'enterprise:operation-prompt'],
  ['sessions', 'onChanged', 'sessions:changed'],
  ['agent', 'onEvent', 'agent:event'],
  ['providers', 'onAuthEvent', 'providers:auth-event'],
  ['terminal', 'onData', 'terminal:data'],
  ['terminal', 'onExit', 'terminal:exit'],
  ['browser', 'onChanged', 'browser:changed'],
  ['browser', 'onPointer', 'browser:pointer'],
  ['browser', 'onActivity', 'browser:activity'],
  ['schedules', 'onChanged', 'schedules:changed'],
]

describe('preload bridge contract', () => {
  beforeEach(() => {
    electronMocks.ipcRenderer.invoke.mockReset()
    electronMocks.ipcRenderer.invoke.mockResolvedValue(undefined)
    electronMocks.ipcRenderer.on.mockReset()
    electronMocks.ipcRenderer.removeListener.mockReset()
    electronMocks.ipcRenderer.send.mockReset()
  })

  it('exposes the main-process Settings signal with a removable listener', () => {
    const api = electronMocks.api as { app: { onOpenSettings(callback: () => void): () => void } }
    expect(() => (api.app.onOpenSettings as unknown as (callback: unknown) => unknown)(undefined)).toThrow('callback must be a function')
    const callback = vi.fn()
    const unsubscribe = api.app.onOpenSettings(callback)
    const listener = electronMocks.ipcRenderer.on.mock.calls[0]?.[1] as (() => void) | undefined

    expect(electronMocks.ipcRenderer.on).toHaveBeenCalledWith('app:open-settings', expect.any(Function))
    listener?.()
    expect(callback).toHaveBeenCalledOnce()
    unsubscribe()
    expect(electronMocks.ipcRenderer.removeListener).toHaveBeenCalledWith('app:open-settings', listener)
  })

  it('freezes the exposed API and every domain', () => {
    const api = electronMocks.api as BridgeApi
    expect(electronMocks.contextBridge.exposeInMainWorld).toHaveBeenCalledWith('prime', api)
    expect(Object.isFrozen(api)).toBe(true)
    for (const domain of Object.values(api)) expect(Object.isFrozen(domain)).toBe(true)
  })

  it.each(INVOKE_CASES)('routes %s.%s through fixed channel %s', async (domain, method, channel, args, expectedArgs) => {
    const api = electronMocks.api as BridgeApi
    await api[domain][method](...args)
    expect(electronMocks.ipcRenderer.invoke).toHaveBeenCalledWith(channel, ...(expectedArgs ?? args))
  })

  it('forwards the complete run lookup batch and returns its read-only projection without mutation or side effects', async () => {
    const api = electronMocks.api as BridgeApi
    const runIds = Object.freeze(['run-current', 'run-missing', 'run-current'])
    const projection = Object.freeze({
      runs: Object.freeze([Object.freeze({ runId: 'run-current', status: 'failed', isCurrent: true, businessResult: 'action_failed' })]),
      missing: Object.freeze(['run-missing']),
    })
    electronMocks.ipcRenderer.invoke.mockResolvedValueOnce(projection)

    await expect(api.enterprise.getWorkRunStates(runIds)).resolves.toBe(projection)

    expect(electronMocks.ipcRenderer.invoke).toHaveBeenCalledExactlyOnceWith('enterprise:get-work-run-states', runIds)
    expect(electronMocks.ipcRenderer.invoke.mock.calls[0]?.[1]).toBe(runIds)
    expect(electronMocks.ipcRenderer.send).not.toHaveBeenCalled()
    expect(electronMocks.ipcRenderer.on).not.toHaveBeenCalled()
  })

  it.each([
    ['input', 'terminal:input', ['terminal', 'text']],
    ['resize', 'terminal:resize', ['terminal', 120, 40]],
    ['setActiveContext', 'terminal:set-active-context', ['terminal', { label: 'shell', content: 'output' }]],
    ['clearActiveContext', 'terminal:clear-active-context', ['terminal']],
  ] as const)('sends terminal.%s through fixed channel %s', (method, channel, args) => {
    const api = electronMocks.api as BridgeApi
    api.terminal[method](...args)
    expect(electronMocks.ipcRenderer.send).toHaveBeenCalledWith(channel, ...args)
  })

  it.each(SUBSCRIPTION_CASES)('validates and filters %s.%s payloads', (domain, method, channel) => {
    const api = electronMocks.api as BridgeApi
    const callback = vi.fn()
    expect(() => api[domain][method](undefined)).toThrow('callback must be a function')
    const unsubscribe = api[domain][method](callback) as () => void
    const listener = electronMocks.ipcRenderer.on.mock.calls.at(-1)?.[1] as ((event: unknown, payload: unknown) => void)
    const payload = { ok: true }

    expect(electronMocks.ipcRenderer.on).toHaveBeenLastCalledWith(channel, listener)
    listener({}, payload)
    listener({}, 'ignored')
    listener({}, null)
    expect(callback).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith(payload)
    unsubscribe()
    expect(electronMocks.ipcRenderer.removeListener).toHaveBeenCalledWith(channel, listener)
  })


  it('unwraps recognized Electron invoke errors while retaining diagnostics and error type', async () => {
    const original = new TypeError("Error invoking remote method 'voice:transcribe': TypeError: Invalid voice URL")
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    electronMocks.ipcRenderer.invoke.mockRejectedValueOnce(original)
    const api = electronMocks.api as { voice: { transcribe(request: unknown): Promise<unknown> } }

    const rejection = api.voice.transcribe({})
    await expect(rejection).rejects.toMatchObject({ message: 'Invalid voice URL' })
    await rejection.catch((error: unknown) => {
      expect(error).toBeInstanceOf(TypeError)
      expect(error).not.toBe(original)
      expect((error as Error).cause).toBe(original)
    })
    expect(errorSpy).toHaveBeenCalledWith('Electron IPC invocation failed:', original)
    errorSpy.mockRestore()
  })

  it('leaves unrecognized Error messages untouched', async () => {
    const original = new Error("Error invoking remote method 'settings:update': malformed")
    electronMocks.ipcRenderer.invoke.mockRejectedValueOnce(original)
    const api = electronMocks.api as { settings: { update(patch: unknown): Promise<unknown> } }

    await expect(api.settings.update({})).rejects.toBe(original)
  })

  it('leaves non-Error rejections untouched', async () => {
    const original = { reason: 'raw rejection' }
    electronMocks.ipcRenderer.invoke.mockRejectedValueOnce(original)
    const api = electronMocks.api as { settings: { update(patch: unknown): Promise<unknown> } }

    await expect(api.settings.update({})).rejects.toBe(original)
  })
})
