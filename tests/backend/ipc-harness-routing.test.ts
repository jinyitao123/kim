import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => ({
  app: {},
  ipcMain: {
    removeHandler: vi.fn(),
    handle: vi.fn(),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
  },
  shell: { openExternal: vi.fn(), showItemInFolder: vi.fn() },
}))

vi.mock('electron', () => electronMocks)

import { registerIpc, type IpcRegistration } from '../../electron/main/ipc'
import { ProjectAccountScopeChangedError } from '../../electron/main/projects'

const EXPECTED_URL = 'prime-work://app/'
const PRIME_SESSION = '/home/user/.prime/agent/sessions/session.jsonl'
const ARCHIVED_OMP_SESSION = '/home/user/.omp/agent/sessions/bucket/session.jsonl'
const PI_SESSION = '/home/user/.pi/agent/sessions/--home-user-project--/session.jsonl'

function serviceStub(): Record<string, unknown> {
  return new Proxy({}, { get: () => vi.fn(async () => undefined) })
}

interface Harness {
  invoke(channel: string, ...args: unknown[]): unknown
  services: ReturnType<typeof buildServices>
  registration: IpcRegistration
}

function buildServices() {
  const settingsState = { disabledProviders: ['blocked'], disabledModels: [], piDisabledProviders: ['anthropic'], piDisabledModels: [] }
  const catalog = (from: string, disabled: ReadonlySet<string> = new Set(), disabledModels: ReadonlySet<string> = new Set()) => {
    const models = [
      { key: 'anthropic/claude', provider: 'anthropic', id: 'claude' },
      { key: 'openai/gpt', provider: 'openai', id: 'gpt' },
      { key: 'openai/gpt-mini', provider: 'openai', id: 'gpt-mini' },
    ]
    const providerEnabled = (id: string) => !disabled.has(id) && models.some((model) => model.provider === id && !disabledModels.has(model.key))
    return {
      from,
      models: models.map((model) => ({ ...model, enabled: providerEnabled(model.provider) && !disabledModels.has(model.key) })),
      providers: ['anthropic', 'openai'].map((id) => ({ id, enabled: providerEnabled(id) })),
    }
  }
  const primeSessionGate = vi.fn(async (path: unknown) => {
    if (path === PRIME_SESSION) return path
    throw new TypeError('Session path is outside the Prime session directory')
  })
  const piSessionGate = vi.fn(async (path: unknown) => {
    if (path === PI_SESSION) return path
    throw new TypeError('Session path is outside the Prime session directory')
  })
  return {
    meta: { version: '0.0.0-test' },
    refreshHarnesses: vi.fn(async () => ({ meta: { version: '0.0.0-refreshed' }, settings: settingsState })),
    projects: { ...serviceStub(), list: vi.fn(async () => ['prime-projects']), grantInferred: vi.fn(async () => 'prime-grant') },
    checkouts: {
      prime: { list: vi.fn(async () => 'prime-checkouts'), execute: vi.fn(async () => 'prime-checkout') },
      pi: { list: vi.fn(async () => 'pi-checkouts'), execute: vi.fn(async () => 'pi-checkout') },
      loom: { list: vi.fn(async () => 'loom-checkouts'), execute: vi.fn(async () => 'loom-checkout') },
    },
    sessions: {
      ...serviceStub(),
      onDidChange: vi.fn(() => () => undefined),
      requireSessionPath: primeSessionGate,
      list: vi.fn(async () => ['prime-sessions']),
      read: vi.fn(async () => ['prime-transcript']),
      followUp: vi.fn(async () => true),
      rename: vi.fn(async () => true),
      archive: vi.fn(async () => true),
    },
    agents: {
      ...serviceStub(),
      has: vi.fn((id: string) => id === 'prime-runtime'),
      start: vi.fn(async (options: unknown) => ({ started: 'prime', options })),
      command: vi.fn(async () => ({ ok: 'prime' })),
      stop: vi.fn(async () => true),
      list: vi.fn(() => [{ runtimeId: 'prime-runtime', harness: 'prime' }]),
    },
    terminals: { ...serviceStub(), killForSession: vi.fn(async () => undefined) },
    git: serviceStub(),
    plugins: { ...serviceStub(), list: vi.fn(async () => 'prime-plugins'), install: vi.fn(async () => undefined), installExtension: vi.fn(async () => undefined), setMcpSupport: vi.fn(async () => undefined), connectMcp: vi.fn(async () => undefined), setMcpEnabled: vi.fn(async () => undefined), refresh: vi.fn(async () => 'prime-plugins') },
    providers: { ...serviceStub(), catalog: vi.fn(async (_force, disabled, disabledModels) => catalog('prime', disabled, disabledModels)), saveApiKey: vi.fn(async () => undefined) },
    settings: {
      ...serviceStub(),
      get: vi.fn(() => settingsState),
      update: vi.fn(async (patch: Partial<typeof settingsState>) => { Object.assign(settingsState, patch); return settingsState }),
    },
    heartbeats: serviceStub(),
    schedules: { ...serviceStub(), onDidChange: vi.fn(() => () => undefined), list: vi.fn(() => 'scheduled'), create: vi.fn(async () => 'created') },
    browser: { ...serviceStub(), closeForSession: vi.fn(() => true), onDidChange: vi.fn(() => vi.fn()), onPointer: vi.fn(() => vi.fn()), onActivity: vi.fn(() => vi.fn()) },
    pi: {
      plugins: { ...serviceStub(), list: vi.fn(async () => 'pi-plugins'), install: vi.fn(async () => undefined), installExtension: vi.fn(async () => undefined), setMcpSupport: vi.fn(async () => undefined), connectMcp: vi.fn(async () => undefined), setMcpEnabled: vi.fn(async () => undefined), refresh: vi.fn(async () => 'pi-plugins') },
      projects: { ...serviceStub(), list: vi.fn(async () => ['pi-projects']), grantInferred: vi.fn(async () => 'pi-grant') },
      sessions: {
        ...serviceStub(),
        onDidChange: vi.fn(() => () => undefined),
        requireSessionPath: piSessionGate,
        list: vi.fn(async () => ['pi-sessions']),
        read: vi.fn(async () => ['pi-transcript']),
        followUp: vi.fn(async () => true),
        rename: vi.fn(async () => false),
        archive: vi.fn(async () => true),
      },
      agents: {
        ...serviceStub(),
        has: vi.fn((id: string) => id === 'pi-runtime'),
        start: vi.fn(async (options: unknown) => ({ started: 'pi', options })),
        command: vi.fn(async () => ({ ok: 'pi' })),
        stop: vi.fn(async () => true),
        list: vi.fn(() => [{ runtimeId: 'pi-runtime', harness: 'pi' }]),
      },
      catalog: {
        catalog: vi.fn(async (_force, disabled, disabledModels) => catalog('pi', disabled, disabledModels)),
      },
    },
    // Loom owns no runtimes or sessions in these tests.
    loom: {
      plugins: { ...serviceStub(), list: vi.fn(async () => 'loom-plugins'), refresh: vi.fn(async () => 'loom-plugins') },
      projects: { ...serviceStub(), list: vi.fn(async () => ['loom-projects']) },
      sessions: {
        ...serviceStub(),
        onDidChange: vi.fn(() => () => undefined),
        requireSessionPath: vi.fn(async () => { throw new TypeError('Session path is outside the Loom session directory') }),
        list: vi.fn(async () => ['loom-sessions']),
      },
      agents: { ...serviceStub(), has: vi.fn(() => false), list: vi.fn(() => []) },
      catalog: {
        catalog: vi.fn(async (_force, disabled, disabledModels) => catalog('loom', disabled, disabledModels)),
      },
    },
  }
}

describe('harness-aware IPC routing', () => {
  let harness: Harness

  beforeEach(() => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    electronMocks.ipcMain.handle.mockReset()
    electronMocks.ipcMain.on.mockReset()
    electronMocks.ipcMain.handle.mockImplementation((channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, listener)
    })
    const services = buildServices()
    const registration = registerIpc(services as never, EXPECTED_URL)
    const mainFrame = { url: EXPECTED_URL }
    const sender = { id: 1, isDestroyed: () => false, getURL: () => EXPECTED_URL, mainFrame }
    registration.authorize(sender as never)
    const event = { sender, senderFrame: mainFrame }
    harness = {
      invoke: (channel, ...args) => handlers.get(channel)!(event, ...args),
      services,
      registration,
    }
  })

  afterEach(() => {
    harness.registration.dispose()
  })

  it('exposes harness refresh through the fixed authorized app channel', async () => {
    await expect(harness.invoke('app:refresh-harnesses')).resolves.toMatchObject({ meta: { version: '0.0.0-refreshed' } })
    expect(harness.services.refreshHarnesses).toHaveBeenCalledTimes(1)
  })

  it('rejects harness values outside the strict enum on every routed channel', async () => {
    for (const channel of ['projects:list', 'projects:add']) {
      await expect(async () => harness.invoke(channel, 'codex')).rejects.toThrow('Invalid harness')
    }
    await expect(async () => harness.invoke('sessions:list', undefined, false, 'OMP')).rejects.toThrow('Invalid harness')
    await expect(async () => harness.invoke('sessions:list', undefined, false, 'omp')).rejects.toThrow('Invalid harness')
    await expect(async () => harness.invoke('providers:catalog', false, { harness: 'omp' })).rejects.toThrow('Invalid harness')
    await expect(async () => harness.invoke('agent:start', { cwd: '/tmp', harness: 1 })).rejects.toThrow('Invalid harness')
    await expect(async () => harness.invoke('projects:list', 'Pi')).rejects.toThrow('Invalid harness')
    await expect(async () => harness.invoke('sessions:list', undefined, false, 'PI')).rejects.toThrow('Invalid harness')
    expect(harness.services.agents.start).not.toHaveBeenCalled()
  })

  it('routes agent:start by harness and strips the routing field before the manager sees it', async () => {
    await expect(harness.invoke('agent:start', { cwd: '/work', harness: 'pi' })).resolves.toEqual({ started: 'pi', options: { cwd: '/work' } })
    expect(harness.services.pi.agents.start).toHaveBeenCalledWith({ cwd: '/work' })
    expect(harness.services.agents.start).not.toHaveBeenCalled()

    await expect(harness.invoke('agent:start', { cwd: '/work' })).resolves.toEqual({ started: 'prime', options: { cwd: '/work' } })
    expect(harness.services.agents.start).toHaveBeenCalledWith({ cwd: '/work' })
  })

  it('routes agent:command and agent:stop by runtime ownership, defaulting unknown ids to prime', async () => {
    await expect(harness.invoke('agent:command', 'pi-runtime', { type: 'abort' })).resolves.toEqual({ ok: 'pi' })
    expect(harness.services.pi.agents.command).toHaveBeenCalledWith('pi-runtime', { type: 'abort' })

    await expect(harness.invoke('agent:command', 'prime-runtime', { type: 'abort' })).resolves.toEqual({ ok: 'prime' })
    expect(harness.services.agents.command).toHaveBeenCalledWith('prime-runtime', { type: 'abort' })

    // An id neither manager owns lands on the Prime manager, preserving its
    // exact requireRuntime error semantics.
    await harness.invoke('agent:command', 'missing-runtime', { type: 'abort' })
    expect(harness.services.agents.command).toHaveBeenCalledWith('missing-runtime', { type: 'abort' })

    await expect(harness.invoke('agent:stop', 'pi-runtime')).resolves.toBe(true)
    expect(harness.services.pi.agents.stop).toHaveBeenCalledWith('pi-runtime')
  })

  it('passes captured employee input only to the Host and never adds it to the runtime command', async () => {
    const order: string[] = []
    const employeeCommand = vi.fn(async () => { order.push('enterprise-command') })
    const bindEnterpriseSession = vi.fn(() => { order.push('enterprise-bind') })
    const bindDevelopmentSession = vi.fn(() => { order.push('development-bind') })
    const beginEmployeeCommand = vi.fn((_runtimeId: string, type: string) => { order.push(`begin:${type}`) })
    const captureTrustedEmployeeCommand = vi.fn(async () => { order.push('capture') })
    harness.services.pi.agents.list.mockReturnValue([{ runtimeId: 'pi-runtime', harness: 'pi', sessionFile: PI_SESSION } as never])
    Object.assign(harness.services, {
      enterpriseBridge: { bindRuntimeSession: bindEnterpriseSession, employeeCommand },
      teamDevelopmentBridge: { bindRuntimeSession: bindDevelopmentSession, beginEmployeeCommand, captureTrustedEmployeeCommand },
    })
    const command = { type: 'prompt', message: '完整运行提示' }
    const employeeInput = { text: '员工原文', materials: [] }
    await harness.invoke('agent:command', 'pi-runtime', command, { employeeInput })
    expect(employeeCommand).toHaveBeenCalledWith('pi-runtime', command, undefined, undefined, undefined, employeeInput)
    expect(bindEnterpriseSession).toHaveBeenCalledWith('pi-runtime', PI_SESSION)
    expect(bindDevelopmentSession).toHaveBeenCalledWith('pi-runtime', PI_SESSION)
    expect(beginEmployeeCommand).toHaveBeenCalledWith('pi-runtime', 'prompt')
    expect(captureTrustedEmployeeCommand).toHaveBeenCalledWith('pi-runtime', command, employeeInput)
    expect(order).toEqual(['enterprise-bind', 'development-bind', 'begin:prompt', 'enterprise-command', 'capture'])
    expect(harness.services.pi.agents.command).toHaveBeenCalledWith('pi-runtime', command)
    await expect(harness.invoke('agent:command', 'pi-runtime', { type: 'abort' }, { employeeInput })).rejects.toThrow('Employee input only belongs')
    expect(employeeCommand).toHaveBeenCalledOnce()
    expect(beginEmployeeCommand).toHaveBeenLastCalledWith('pi-runtime', 'abort')
  })

  it('routes UI context invalidation to the runtime-bound team development bridge', async () => {
    const invalidateEmployeeTurn = vi.fn()
    Object.assign(harness.services, { teamDevelopmentBridge: { invalidateEmployeeTurn } })
    await harness.invoke('enterprise:invalidate-team-development-turn', 'pi-runtime')
    expect(invalidateEmployeeTurn).toHaveBeenCalledWith('pi-runtime')
    expect(() => harness.invoke('enterprise:invalidate-team-development-turn', '')).toThrow('runtimeId')
  })

  it('concatenates all managers for agent:list', () => {
    expect(harness.invoke('agent:list')).toEqual([
      { runtimeId: 'prime-runtime', harness: 'prime' },
      { runtimeId: 'pi-runtime', harness: 'pi' },
    ])
  })

  it('passes Forge business notifications through the existing read-only Host context binding', async () => {
    const binding = { handle: 'business-context', context: { kind: 'business', materialStatus: 'available', materials: [{ name: '合同正文.docx' }, { name: '技术协议.pdf' }] } }
    const pinWorkContinuationContext = vi.fn(async () => binding)
    Object.assign(harness.services, { enterpriseBridge: { pinWorkContinuationContext } })
    const item = { id: 'business-notice', source: 'forge', notificationType: 'forge.business.completed' }
    await expect(harness.invoke('enterprise:pin-work-continuation-context', item)).resolves.toBe(binding)
    expect(pinWorkContinuationContext).toHaveBeenCalledExactlyOnceWith(item)
  })

  it('opens employee business records only through the Host binding and rejects injected authority', async () => {
    const binding = { handle: 'employee-context', prompt: '只读当前记录' }
    const pinEmployeeBusinessContext = vi.fn(async () => binding)
    Object.assign(harness.services, { enterpriseBridge: { pinEmployeeBusinessContext } })
    const record = { objectName: 'forge_sales_contract', recordId: 'contract-1', label: '合同' }
    await expect(harness.invoke('enterprise:pin-employee-business-context', record)).resolves.toBe(binding)
    expect(pinEmployeeBusinessContext).toHaveBeenCalledExactlyOnceWith(record)
    expect(() => harness.invoke('enterprise:pin-employee-business-context', { ...record, actorId: 'another-user' })).toThrow()
    expect(pinEmployeeBusinessContext).toHaveBeenCalledOnce()
  })

  it('preserves Weave continuation references and rejects unknown sources or injected business authority', async () => {
    const pinWorkContinuationContext = vi.fn(async () => ({ handle: 'team-context' }))
    Object.assign(harness.services, { enterpriseBridge: { pinWorkContinuationContext } })
    const item = { id: 'team-notice', source: 'weave', notificationType: 'weave.team_run.result', workReference: 'input-1', runReference: 'run-1', sessionReference: 'session-1' }
    await harness.invoke('enterprise:pin-work-continuation-context', item)
    expect(pinWorkContinuationContext).toHaveBeenCalledExactlyOnceWith(item)
    for (const invalid of [
      { id: 'business-notice', source: 'unknown' },
      { id: 'business-notice' },
      { id: '', source: 'forge' },
      { id: 'business-notice', source: 'forge', recordId: 'another-contract' },
      { id: 'business-notice', source: 'forge', authorizedBusinessCapabilityIDs: ['approve'] },
    ]) expect(() => harness.invoke('enterprise:pin-work-continuation-context', invalid)).toThrow()
    expect(pinWorkContinuationContext).toHaveBeenCalledOnce()
  })

  it.each(['请先登录', '业务记录不可见', '当前 Forge 消息不是可续接的业务结果'])('propagates business context refusal without a fallback: %s', async (message) => {
    const pinWorkContinuationContext = vi.fn(async () => { throw new Error(message) })
    Object.assign(harness.services, { enterpriseBridge: { pinWorkContinuationContext } })
    await expect(harness.invoke('enterprise:pin-work-continuation-context', { id: 'business-notice', source: 'forge' })).rejects.toThrow(message)
    expect(pinWorkContinuationContext).toHaveBeenCalledExactlyOnceWith({ id: 'business-notice', source: 'forge' })
  })

  it('routes sessions:list and projects channels by the harness argument, defaulting to prime', async () => {
    await expect(harness.invoke('sessions:list', undefined, false)).resolves.toEqual(['prime-sessions'])
    await expect(harness.invoke('sessions:list', undefined, false, 'pi')).resolves.toEqual(['pi-sessions'])
    await expect(harness.invoke('projects:list')).resolves.toEqual(['prime-projects'])
    await expect(harness.invoke('projects:list', 'pi')).resolves.toEqual(['pi-projects'])
    expect(harness.services.projects.grantInferred).not.toHaveBeenCalled()
    await expect(harness.invoke('projects:grant-inferred', '/somewhere', 'pi')).resolves.toBe('pi-grant')
    expect(harness.services.pi.projects.grantInferred).toHaveBeenCalledWith('/somewhere')
    await expect(harness.invoke('projects:list-checkouts', 'project', 'pi')).resolves.toBe('pi-checkouts')
    await expect(harness.invoke('projects:execute-checkout', 'project', { strategy: 'branch', operation: 'switch', branch: 'feature' }, 'pi')).resolves.toBe('pi-checkout')
    expect(harness.services.checkouts.pi.list).toHaveBeenCalledWith('project')
    expect(harness.services.checkouts.pi.execute).toHaveBeenCalledWith('project', { strategy: 'branch', operation: 'switch', branch: 'feature' })
  })

  it('cancels old-account catalogs without rejecting IPC, and still rejects real read failures', async () => {
    harness.services.projects.list.mockRejectedValueOnce(new ProjectAccountScopeChangedError())
    await expect(harness.invoke('projects:list')).resolves.toEqual([])
    harness.services.checkouts.pi.list.mockRejectedValueOnce(new ProjectAccountScopeChangedError())
    await expect(harness.invoke('projects:list-checkouts', 'project', 'pi')).resolves.toMatchObject({ checkouts: [] })
    harness.services.projects.list.mockRejectedValueOnce(new Error('catalog unavailable'))
    await expect(harness.invoke('projects:list')).rejects.toThrow('catalog unavailable')
  })

  it('discards a successful checkout catalog completed after the account changed', async () => {
    let finish!: (value: string) => void
    harness.services.checkouts.pi.list.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve }))
    Reflect.set(harness.services.pi.projects, 'scopeRevision', 1)
    const response = harness.invoke('projects:list-checkouts', 'project', 'pi')
    Reflect.set(harness.services.pi.projects, 'scopeRevision', 2)
    finish('old-account-checkouts')
    await expect(response).resolves.toMatchObject({ checkouts: [] })
  })

  it('routes plugin catalog, installation, and MCP configuration by harness', async () => {
    await harness.invoke('plugins:set-mcp-support', true, 'pi')
    expect(harness.services.pi.plugins.setMcpSupport).toHaveBeenCalledWith(true)
    await harness.invoke('plugins:list', '/repo', 'pi')
    expect(harness.services.pi.plugins.list).toHaveBeenCalledWith('/repo')
    await harness.invoke('plugins:install', 'npm:example', 'pi')
    expect(harness.services.pi.plugins.install).toHaveBeenCalledWith('npm:example')
    await harness.invoke('plugins:connect-mcp', { name: 'docs' }, 'pi')
    expect(harness.services.pi.plugins.connectMcp).toHaveBeenCalledWith({ name: 'docs' })
    await harness.invoke('plugins:refresh', 'pi')
    expect(harness.services.pi.plugins.refresh).toHaveBeenCalledOnce()

    await expect(async () => harness.invoke('plugins:list', undefined, 'OMP')).rejects.toThrow('Invalid harness')
  })

  it('routes session file operations by which harness root authorizes the path', async () => {
    await expect(harness.invoke('sessions:read', PRIME_SESSION)).resolves.toEqual(['prime-transcript'])
    expect(harness.services.sessions.read).toHaveBeenCalledWith(PRIME_SESSION)
    await expect(harness.invoke('sessions:read', PI_SESSION)).resolves.toEqual(['pi-transcript'])
    expect(harness.services.pi.sessions.read).toHaveBeenCalledWith(PI_SESSION)
    await expect(async () => harness.invoke('sessions:read', ARCHIVED_OMP_SESSION)).rejects.toThrow(/outside the (Prime|Pi) session directory/)

    // A path neither root contains fails with the Prime service's own error.
    await expect(async () => harness.invoke('sessions:read', '/etc/passwd')).rejects.toThrow('outside the Prime session directory')

    await expect(harness.invoke('sessions:rename', PI_SESSION, 'Title')).resolves.toBe(false)
    expect(harness.services.pi.sessions.rename).toHaveBeenCalledWith(PI_SESSION, 'Title')
    await expect(harness.invoke('sessions:archive', PI_SESSION, true)).resolves.toBe(true)
    expect(harness.services.pi.sessions.archive).toHaveBeenCalledWith(PI_SESSION, true)
    expect(harness.services.browser.closeForSession).toHaveBeenCalledWith(PI_SESSION)
    expect(harness.services.terminals.killForSession).toHaveBeenCalledWith(PI_SESSION)

    harness.services.browser.closeForSession.mockClear()
    harness.services.terminals.killForSession.mockClear()
    await expect(harness.invoke('sessions:archive', PI_SESSION, false)).resolves.toBe(true)
    expect(harness.services.browser.closeForSession).not.toHaveBeenCalled()
    expect(harness.services.terminals.killForSession).not.toHaveBeenCalled()
  })

  it('answers follow-up for an idle Pi session with the not-running result instead of the daemon path', async () => {
    await expect(harness.invoke('sessions:follow-up', PI_SESSION, 'hello', 'queue')).resolves.toBe(false)
    expect(harness.services.pi.sessions.followUp).not.toHaveBeenCalled()

    await expect(harness.invoke('sessions:follow-up', PRIME_SESSION, 'hello', 'queue')).resolves.toBe(true)
    expect(harness.services.sessions.followUp).toHaveBeenCalledWith(PRIME_SESSION, 'hello', 'queue')
  })

  it('routes providers:catalog with independent desktop visibility per harness', async () => {
    await expect(harness.invoke('providers:catalog', true)).resolves.toMatchObject({ from: 'prime' })
    expect(harness.services.providers.catalog).toHaveBeenCalledWith(true, new Set(['blocked']), new Set())

    await expect(harness.invoke('providers:catalog', true, 'pi')).resolves.toMatchObject({ from: 'pi' })
    expect(harness.services.pi.catalog.catalog).toHaveBeenCalledWith(true, new Set(['anthropic']), new Set())
  })

  it('does not register MCP-specific authentication or credential cleanup channels', () => {
    expect(electronMocks.ipcMain.handle).not.toHaveBeenCalledWith('providers:start-mcp-oauth', expect.any(Function))
    expect(electronMocks.ipcMain.handle).not.toHaveBeenCalledWith('providers:logout-mcp', expect.any(Function))
  })

  it('stores Pi provider visibility in Pi-specific desktop settings', async () => {
    await expect(harness.invoke('providers:set-enabled', 'openai', false, 'pi')).resolves.toMatchObject({
      from: 'pi',
      providers: [{ id: 'anthropic', enabled: false }, { id: 'openai', enabled: false }],
    })
    expect(harness.services.settings.update).toHaveBeenCalledWith({ piDisabledProviders: ['anthropic', 'openai'], piDisabledModels: [] })

    await expect(harness.invoke('providers:set-disabled', ['openai'], 'pi')).resolves.toMatchObject({
      from: 'pi',
      providers: [{ id: 'anthropic', enabled: true }, { id: 'openai', enabled: false }],
    })
    expect(harness.services.settings.update).toHaveBeenLastCalledWith({ piDisabledProviders: ['openai'], piDisabledModels: [] })
  })

  it('keeps Pi provider and model visibility synchronized in both directions', async () => {
    await expect(harness.invoke('providers:set-enabled', 'openai', false, 'pi')).resolves.toMatchObject({
      providers: [{ id: 'anthropic', enabled: false }, { id: 'openai', enabled: false }],
      models: [
        { key: 'anthropic/claude', enabled: false },
        { key: 'openai/gpt', enabled: false },
        { key: 'openai/gpt-mini', enabled: false },
      ],
    })

    await expect(harness.invoke('providers:set-model-enabled', 'openai/gpt', true, 'pi')).resolves.toMatchObject({
      providers: [{ id: 'anthropic', enabled: false }, { id: 'openai', enabled: true }],
      models: [
        { key: 'anthropic/claude', enabled: false },
        { key: 'openai/gpt', enabled: true },
        { key: 'openai/gpt-mini', enabled: false },
      ],
    })
    expect(harness.services.settings.update).toHaveBeenLastCalledWith({ piDisabledProviders: ['anthropic'], piDisabledModels: ['openai/gpt-mini'] })

    await expect(harness.invoke('providers:set-model-enabled', 'openai/gpt', false, 'pi')).resolves.toMatchObject({
      providers: [{ id: 'anthropic', enabled: false }, { id: 'openai', enabled: false }],
      models: [
        { key: 'anthropic/claude', enabled: false },
        { key: 'openai/gpt', enabled: false },
        { key: 'openai/gpt-mini', enabled: false },
      ],
    })
    expect(harness.services.settings.update).toHaveBeenLastCalledWith({ piDisabledProviders: ['anthropic', 'openai'], piDisabledModels: ['openai/gpt', 'openai/gpt-mini'] })

    await expect(harness.invoke('providers:set-enabled', 'openai', true, 'pi')).resolves.toMatchObject({
      providers: [{ id: 'anthropic', enabled: false }, { id: 'openai', enabled: true }],
      models: [
        { key: 'anthropic/claude', enabled: false },
        { key: 'openai/gpt', enabled: true },
        { key: 'openai/gpt-mini', enabled: true },
      ],
    })
    expect(harness.services.settings.update).toHaveBeenLastCalledWith({ piDisabledProviders: ['anthropic'], piDisabledModels: [] })
  })

  it.each([
    ['pi', 'Pi'],
  ] as const)('rejects provider credential mutations aimed at the %s harness', async (harnessId, agentName) => {
    for (const [channel, args] of [
      ['providers:save-api-key', ['openai', 'key']],
      ['providers:logout', ['openai']],
      ['providers:start-oauth', ['openai']],
    ] as const) {
      await expect(async () => harness.invoke(channel, ...args, harnessId), channel).rejects.toThrow(`${agentName} provider authentication is managed by the ${harnessId} CLI`)
    }
    expect(harness.services.providers.saveApiKey).not.toHaveBeenCalled()
  })

  it('routes Pi key changes only to its private credential store and preserves the native model catalogue', async () => {
    const store = { saveApiKey: vi.fn(), logout: vi.fn(), catalog: vi.fn(async () => ({ providers: [{ id: 'deepseek', authMethod: 'api_key', configured: false }], models: [] })) }
    Object.assign(harness.services.pi, { providers: store })
    await harness.invoke('providers:save-api-key', 'deepseek', 'private-pi-fixture-key', 'pi')
    expect(store.saveApiKey).toHaveBeenCalledWith('deepseek', 'private-pi-fixture-key')
    expect(harness.services.providers.saveApiKey).not.toHaveBeenCalled()
    const catalogue = await harness.invoke('providers:catalog', true, 'pi') as { providers: Array<{ id: string; availableModelCount: number }>; models: unknown[] }
    expect(catalogue.providers.find(provider => provider.id === 'deepseek')?.availableModelCount).toBe(0)
    expect(catalogue.models).toHaveLength(3)
    await harness.invoke('providers:logout', 'deepseek', 'pi')
    expect(store.logout).toHaveBeenCalledWith('deepseek')
    await expect(async () => harness.invoke('providers:start-oauth', 'openai', 'pi')).rejects.toThrow('Pi provider authentication')
  })

  it('rejects Loom credential mutations without changing the Pi or Prime stores', async () => {
    const piStore = { saveApiKey: vi.fn(), logout: vi.fn() }
    const primeLogout = vi.fn()
    Object.assign(harness.services.pi, { providers: piStore })
    Object.assign(harness.services.providers, { logout: primeLogout })
    for (const [channel, args] of [
      ['providers:save-api-key', ['openai', 'fixture-key']],
      ['providers:logout', ['openai']],
      ['providers:start-oauth', ['openai']],
    ] as const) {
      await expect(async () => harness.invoke(channel, ...args, 'loom')).rejects.toThrow('Loom uses the providers connected for Prime Work')
    }
    expect(piStore.saveApiKey).not.toHaveBeenCalled()
    expect(piStore.logout).not.toHaveBeenCalled()
    expect(harness.services.providers.saveApiKey).not.toHaveBeenCalled()
    expect(primeLogout).not.toHaveBeenCalled()
  })

  it.each(['prime', 'pi'] as const)('routes schedules channels with the %s harness argument', async (harnessId) => {
    expect(harness.invoke('schedules:list', harnessId)).toBe('scheduled')
    expect(harness.services.schedules.list).toHaveBeenCalledWith(harnessId)
    await expect(harness.invoke('schedules:create', { prompt: 'p' }, harnessId)).resolves.toBe('created')
    expect(harness.services.schedules.create).toHaveBeenCalledWith({ prompt: 'p' }, 'user', harnessId)
  })
})
