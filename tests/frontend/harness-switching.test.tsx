// @vitest-environment jsdom

import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from '../../src/components/Sidebar'
import { useAgentEvents } from '../../src/hooks/useAgentEvents'
import { useBootstrap } from '../../src/hooks/useBootstrap'
import { useProviderCatalog } from '../../src/hooks/useProviderCatalog'
import { DEFAULT_SETTINGS } from '../../src/lib/data'
import { AgentSettings } from '../../src/pages/settings/AgentSettings'
import { ProviderSettings } from '../../src/pages/settings/ProviderSettings'
import { SettingsPage } from '../../src/pages/SettingsPage'
import type { AppMeta, AppSettings, HarnessId, PrimeModelCatalog, PrimeWorkApi, ProjectRecord, RuntimeInfo, SessionRecord } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const primeProject: ProjectRecord = {
  id: 'prime-project', harness: 'prime', name: 'Prime project', path: '/prime', folders: ['/prime'], primaryFolder: '/prime', pinned: false,
  createdAt: '2026-01-01T00:00:00.000Z', lastOpenedAt: '2026-01-01T00:00:00.000Z', sessionCount: 1,
}
const primeSession: SessionRecord = {
  id: 'prime-session', harness: 'prime', projectPath: '/prime', filePath: '/prime-sessions/current.jsonl', title: 'Prime session',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'idle', depth: 0,
}
const piProject: ProjectRecord = { ...primeProject, id: 'pi-project', harness: 'pi', name: 'Pi project', path: '/pi', folders: ['/pi'], primaryFolder: '/pi' }
const piSession: SessionRecord = { ...primeSession, id: 'pi-session', harness: 'pi', projectPath: '/pi', filePath: '/pi-sessions/current.jsonl', title: 'Pi session' }
const primeRuntime: RuntimeInfo = { runtimeId: 'prime-runtime', harness: 'prime', cwd: '/prime', sessionFile: primeSession.filePath, isStreaming: false }
const piRuntime: RuntimeInfo = { runtimeId: 'pi-runtime', harness: 'pi', cwd: '/pi', sessionFile: piSession.filePath, isStreaming: false }

const meta: AppMeta = {
  version: '1', platform: 'darwin', homeDir: '/Users/you',
  harnesses: { prime: { path: '/usr/local/bin/prime-agent', version: '0.7.0' }, pi: { path: null, version: null }, loom: { path: null, version: null } },
}
const allDetectedMeta: AppMeta = {
  ...meta,
  harnesses: {
    prime: meta.harnesses.prime,
    pi: { path: '/usr/local/bin/pi', version: '0.84.1' },
    loom: { path: null, version: null },
  },
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

function Probe({ children }: { children?: ReactNode }) { return <>{children}</> }

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function select(element: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(element, value)
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('bootstrap harness switching', () => {
  function makeBridge() {
    const projectsList = vi.fn(async (harness?: HarnessId) => harness === 'pi' ? [piProject] : [primeProject])
    const sessionsList = vi.fn(async (_projectPath?: string, _includeArchived?: boolean, harness?: HarnessId) => harness === 'pi' ? [piSession] : [primeSession])
    const agentList = vi.fn(async () => [primeRuntime, piRuntime])
    const bridge = {
      projects: { list: projectsList },
      sessions: { list: sessionsList, onChanged: () => () => undefined },
      agent: { list: agentList },
      app: { getMeta: async () => meta },
      schedules: { list: async () => [] },
    } as unknown as PrimeWorkApi
    return { bridge, projectsList, sessionsList, agentList }
  }

  it('waits for persisted settings before querying the selected harness', async () => {
    const { bridge, projectsList, sessionsList, agentList } = makeBridge()
    const workspace = makeWorkspace()
    const props = {
      setProjects: vi.fn(),
      setSessions: vi.fn(),
      setSchedules: vi.fn(),
      setScheduleError: vi.fn(),
      runtimeSessionsRef: { current: new Map<string, string>() },
      workspaceRef: workspace.workspaceRef,
      activateWorkspace: workspace.activateWorkspace,
      attachRuntime: workspace.attachRuntime,
      reportError: vi.fn(),
    }
    function BootstrapProbe({ ready }: { ready: boolean }) {
      useBootstrap({ bridge, ready, harness: 'pi', ...props })
      return <Probe />
    }

    await act(async () => { root.render(<BootstrapProbe ready={false} />); await Promise.resolve() })
    expect(projectsList).not.toHaveBeenCalled()
    expect(sessionsList).not.toHaveBeenCalled()
    expect(agentList).not.toHaveBeenCalled()

    await act(async () => { root.render(<BootstrapProbe ready />); await Promise.resolve(); await Promise.resolve() })
    expect(projectsList).toHaveBeenCalledWith('pi')
    expect(sessionsList).toHaveBeenCalledWith(undefined, true, 'pi')
    expect(agentList).toHaveBeenCalledTimes(1)
  })

  function makeWorkspace() {
    const workspaceRef = { current: { generation: 0 } as { generation: number; project?: ProjectRecord; session?: SessionRecord; cwd?: string; sessionFile?: string } }
    const activated: Array<{ project?: ProjectRecord; session?: SessionRecord }> = []
    const attached: RuntimeInfo[] = []
    const activateWorkspace = (project?: ProjectRecord, session?: SessionRecord) => {
      const generation = workspaceRef.current.generation + 1
      workspaceRef.current = { generation, project, session, cwd: project?.primaryFolder, sessionFile: session?.filePath }
      activated.push({ project, session })
      return generation
    }
    const attachRuntime = (runtime?: RuntimeInfo) => { if (runtime) attached.push(runtime) }
    return { workspaceRef, activated, attached, activateWorkspace, attachRuntime }
  }

  it('re-fetches per harness, resets the workspace under a new generation, and attaches only that harness runtime', async () => {
    const { bridge, projectsList, sessionsList } = makeBridge()
    const workspace = makeWorkspace()
    const setProjects = vi.fn()
    const setSessions = vi.fn()
    const setSchedules = vi.fn()
    const setScheduleError = vi.fn()
    const onHarnessSwitch = vi.fn()
    const reportError = vi.fn()
    const runtimeSessionsRef = { current: new Map<string, string>() }
    function BootstrapProbe({ harness }: { harness: HarnessId }) {
      useBootstrap({
        bridge, harness,
        setProjects, setSessions, setSchedules, setScheduleError,
        runtimeSessionsRef, workspaceRef: workspace.workspaceRef,
        activateWorkspace: workspace.activateWorkspace, attachRuntime: workspace.attachRuntime,
        onHarnessSwitch, reportError,
      })
      return <Probe />
    }
    await act(async () => { root.render(<BootstrapProbe harness="prime" />); await Promise.resolve(); await Promise.resolve() })
    expect(projectsList).toHaveBeenLastCalledWith('prime')
    expect(sessionsList).toHaveBeenLastCalledWith(undefined, true, 'prime')
    expect(workspace.activated).toEqual([{ project: primeProject, session: primeSession }])
    expect(onHarnessSwitch).not.toHaveBeenCalled()
    await act(async () => { await Promise.resolve() })
    expect(workspace.attached).toEqual([primeRuntime])

    await act(async () => { root.render(<BootstrapProbe harness="pi" />); await Promise.resolve(); await Promise.resolve() })
    expect(projectsList).toHaveBeenLastCalledWith('pi')
    expect(sessionsList).toHaveBeenLastCalledWith(undefined, true, 'pi')
    expect(onHarnessSwitch).toHaveBeenCalledTimes(1)
    // The switch clears the visible catalog before the new harness loads.
    expect(setProjects).toHaveBeenCalledWith([])
    expect(setSessions).toHaveBeenCalledWith([])
    // Generation-bumping reset first, then the new harness's startup workspace.
    expect(workspace.activated).toEqual([
      { project: primeProject, session: primeSession },
      { project: undefined, session: undefined },
      { project: piProject, session: piSession },
    ])
    await act(async () => { await Promise.resolve() })
    expect(workspace.attached).toEqual([primeRuntime, piRuntime])

    await act(async () => { root.render(<BootstrapProbe harness="prime" />); await Promise.resolve(); await Promise.resolve() })
    expect(projectsList).toHaveBeenLastCalledWith('prime')
    expect(sessionsList).toHaveBeenLastCalledWith(undefined, true, 'prime')
    expect(onHarnessSwitch).toHaveBeenCalledTimes(2)
    expect(workspace.activated).toEqual([
      { project: primeProject, session: primeSession },
      { project: undefined, session: undefined },
      { project: piProject, session: piSession },
      { project: undefined, session: undefined },
      { project: primeProject, session: primeSession },
    ])
    await act(async () => { await Promise.resolve() })
    expect(workspace.attached).toEqual([primeRuntime, piRuntime, primeRuntime])
  })

  it('skips the startup activation when the user changes the workspace mid-fetch', async () => {
    const projects = deferred<ProjectRecord[]>()
    const bridge = {
      projects: { list: vi.fn((harness?: HarnessId) => harness === 'pi' ? projects.promise : Promise.resolve([primeProject])) },
      sessions: { list: async () => [piSession], onChanged: () => () => undefined },
      agent: { list: async () => [] },
      app: { getMeta: async () => meta },
      schedules: { list: async () => [] },
    } as unknown as PrimeWorkApi
    const workspace = makeWorkspace()
    const setProjects = vi.fn()
    const setSessions = vi.fn()
    const setSchedules = vi.fn()
    const setScheduleError = vi.fn()
    const reportError = vi.fn()
    const runtimeSessionsRef = { current: new Map<string, string>() }
    function BootstrapProbe({ harness }: { harness: HarnessId }) {
      useBootstrap({
        bridge, harness,
        setProjects, setSessions, setSchedules, setScheduleError,
        runtimeSessionsRef, workspaceRef: workspace.workspaceRef,
        activateWorkspace: workspace.activateWorkspace, attachRuntime: workspace.attachRuntime,
        reportError,
      })
      return <Probe />
    }
    await act(async () => { root.render(<BootstrapProbe harness="prime" />); await Promise.resolve(); await Promise.resolve() })
    await act(async () => { root.render(<BootstrapProbe harness="pi" />) })
    const activationsBeforeResolve = workspace.activated.length
    // The user activates another workspace while the Pi catalog is in flight.
    act(() => { workspace.activateWorkspace(primeProject) })
    await act(async () => { projects.resolve([piProject]); await projects.promise; await Promise.resolve(); await Promise.resolve() })
    expect(workspace.activated.length).toBe(activationsBeforeResolve + 1)
  })

  it('only refreshes the session catalog for matching sessions:changed events', async () => {
    let onChangedCallback: ((event: { filePath?: string; harness?: HarnessId }) => void) | undefined
    const sessionsList = vi.fn(async (_p?: string, _a?: boolean, harness?: HarnessId) => harness === 'pi' ? [piSession] : [primeSession])
    const bridge = {
      projects: { list: async () => [piProject] },
      sessions: {
        list: sessionsList,
        onChanged: (callback: typeof onChangedCallback) => { onChangedCallback = callback; return () => undefined },
      },
      agent: { list: async () => [] },
      app: { getMeta: async () => meta },
      schedules: { list: async () => [] },
    } as unknown as PrimeWorkApi
    const workspace = makeWorkspace()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const setProjects = vi.fn()
      const setSessions = vi.fn()
      const setSchedules = vi.fn()
      const setScheduleError = vi.fn()
      const reportError = vi.fn()
      const runtimeSessionsRef = { current: new Map<string, string>() }
      function BootstrapProbe() {
        useBootstrap({
          bridge, harness: 'pi',
          setProjects, setSessions, setSchedules, setScheduleError,
          runtimeSessionsRef, workspaceRef: workspace.workspaceRef,
          activateWorkspace: workspace.activateWorkspace, attachRuntime: workspace.attachRuntime,
          reportError,
        })
        return <Probe />
      }
      await act(async () => { root.render(<BootstrapProbe />); await Promise.resolve(); await Promise.resolve() })
      const listCalls = sessionsList.mock.calls.length
      // Prime catalog change (and legacy events without a harness) are ignored.
      act(() => {
        onChangedCallback?.({ filePath: primeSession.filePath, harness: 'prime' })
        onChangedCallback?.({ filePath: primeSession.filePath })
      })
      await act(async () => { vi.advanceTimersByTime(200); await Promise.resolve() })
      expect(sessionsList.mock.calls.length).toBe(listCalls)

      act(() => { onChangedCallback?.({ filePath: piSession.filePath, harness: 'pi' }) })
      await act(async () => { vi.advanceTimersByTime(200); await Promise.resolve() })
      expect(sessionsList.mock.calls.length).toBe(listCalls + 1)
      expect(sessionsList).toHaveBeenLastCalledWith(undefined, true, 'pi')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('bootstrap account scope switching', () => {
  it('keeps the previous local catalog hidden until the signed-in account catalog resolves', async () => {
    const accountProjects = deferred<ProjectRecord[]>()
    const accountSessions = deferred<SessionRecord[]>()
    const accountSession: SessionRecord = { ...primeSession, id: 'employee-session', title: 'Employee session', filePath: '/employee/current.jsonl' }
    let accountScopeActive = false
    const bridge = {
      projects: { list: vi.fn(() => accountScopeActive ? accountProjects.promise : Promise.resolve([primeProject])) },
      sessions: {
        list: vi.fn(() => accountScopeActive ? accountSessions.promise : Promise.resolve([primeSession])),
        onChanged: () => () => undefined,
      },
      agent: { list: async () => [] },
      app: { getMeta: async () => meta },
      schedules: { list: async () => [] },
    } as unknown as PrimeWorkApi
    const workspaceRef = { current: { generation: 0 } as { generation: number; project?: ProjectRecord; session?: SessionRecord; cwd?: string; sessionFile?: string } }
    const activateWorkspace = (project?: ProjectRecord, session?: SessionRecord) => {
      const generation = workspaceRef.current.generation + 1
      workspaceRef.current = { generation, project, session, cwd: project?.primaryFolder, sessionFile: session?.filePath }
      return generation
    }
    const runtimeSessionsRef = { current: new Map<string, string>() }
    const setSchedules = vi.fn()
    const setScheduleError = vi.fn()
    const reportError = vi.fn()
    const attachRuntime = vi.fn()

    function BootstrapProbe({ accountScope }: { accountScope?: string }) {
      const [projects, setProjects] = useState<ProjectRecord[]>([])
      const [sessions, setSessions] = useState<SessionRecord[]>([])
      const { catalogReady } = useBootstrap({
        bridge,
        harness: 'prime',
        accountScope,
        setProjects,
        setSessions,
        setSchedules,
        setScheduleError,
        runtimeSessionsRef,
        workspaceRef,
        activateWorkspace,
        attachRuntime,
        reportError,
      })
      return <div>{catalogReady ? sessions.map((session) => session.title).join(', ') : 'workspace loading'}</div>
    }

    await act(async () => {
      root.render(<BootstrapProbe />)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.textContent).toContain('Prime session')

    accountScopeActive = true
    await act(async () => { root.render(<BootstrapProbe accountScope="organization:employee" />) })
    expect(container.textContent).toBe('workspace loading')
    expect(container.textContent).not.toContain('Prime session')

    await act(async () => {
      accountProjects.resolve([primeProject])
      accountSessions.resolve([accountSession])
      await Promise.all([accountProjects.promise, accountSessions.promise])
      await Promise.resolve()
    })
    expect(container.textContent).toContain('Employee session')
    expect(container.textContent).not.toContain('Prime session')
  })

  it('does not restore the old account catalog when the new account load fails', async () => {
    const newProjects = deferred<ProjectRecord[]>()
    const newSessions = deferred<SessionRecord[]>()
    const failure = new Error('new account unavailable')
    let switched = false
    const bridge = {
      projects: { list: () => switched ? newProjects.promise : Promise.resolve([primeProject]) },
      sessions: { list: () => switched ? newSessions.promise : Promise.resolve([primeSession]), onChanged: () => () => undefined },
      agent: { list: () => switched ? Promise.reject(failure) : Promise.resolve([]) },
      app: { getMeta: () => switched ? Promise.reject(failure) : Promise.resolve(meta) },
      schedules: { list: () => switched ? Promise.reject(failure) : Promise.resolve([]) },
    } as unknown as PrimeWorkApi
    const workspaceRef = { current: { generation: 0 } as { generation: number; project?: ProjectRecord; session?: SessionRecord; cwd?: string; sessionFile?: string } }
    const runtimeSessionsRef = { current: new Map<string, string>() }
    const reportError = vi.fn()
    const setScheduleError = vi.fn()
    const setSchedules = vi.fn()
    const attachRuntime = vi.fn()
    const activateWorkspace = (project?: ProjectRecord, session?: SessionRecord) => {
      const generation = workspaceRef.current.generation + 1
      workspaceRef.current = { generation, project, session, cwd: project?.primaryFolder, sessionFile: session?.filePath }
      return generation
    }
    function BootstrapProbe({ accountScope }: { accountScope?: string }) {
      const [projects, setProjects] = useState<ProjectRecord[]>([])
      const [sessions, setSessions] = useState<SessionRecord[]>([])
      const { catalogReady } = useBootstrap({
        bridge, accountScope, setProjects, setSessions, setSchedules, setScheduleError,
        runtimeSessionsRef, workspaceRef, activateWorkspace, attachRuntime, reportError,
      })
      return <div>{catalogReady ? `${projects.length} projects; ${sessions.map((session) => session.title).join(', ')}` : 'workspace loading'}</div>
    }

    await act(async () => { root.render(<BootstrapProbe />); await Promise.resolve(); await Promise.resolve() })
    expect(container.textContent).toContain('Prime session')

    switched = true
    await act(async () => { root.render(<BootstrapProbe accountScope="organization:employee" />) })
    expect(container.textContent).toBe('workspace loading')
    expect(container.textContent).not.toContain('Prime session')

    await act(async () => {
      newProjects.reject(failure)
      newSessions.reject(failure)
      await Promise.allSettled([newProjects.promise, newSessions.promise])
      await Promise.resolve()
    })
    expect(container.textContent).toBe('0 projects; ')
    expect(reportError).toHaveBeenCalledWith(failure)
    expect(setScheduleError).toHaveBeenCalledWith('new account unavailable')
  })
})

describe('inactive harness event isolation', () => {
  it('does not let a retired runtime finish the session owned by its replacement', async () => {
    let handler!: (payload: { runtimeId: string; event: Record<string, unknown> }) => void
    const bridge = {
      agent: { onEvent: (callback: typeof handler) => { handler = callback; return () => undefined } },
    } as unknown as PrimeWorkApi
    const retiredRuntime = { ...primeRuntime, runtimeId: 'retired-prime-runtime' }
    const currentRuntime = { ...primeRuntime, runtimeId: 'current-prime-runtime' }
    const runtimeIdRef = { current: currentRuntime.runtimeId as string | null }
    const runtimeSessionsRef = { current: new Map([
      [retiredRuntime.runtimeId, primeSession.filePath],
      [currentRuntime.runtimeId, primeSession.filePath],
    ]) }
    const runtimeOwnerRef = { current: { runtimeId: currentRuntime.runtimeId, generation: 1 } }
    const workspaceRef = { current: { generation: 1, project: primeProject, session: primeSession, cwd: primeProject.path, sessionFile: primeSession.filePath } }
    const queueAgentEvent = vi.fn()
    const reconcileTranscriptForEvent = vi.fn()
    let renderedSessions: SessionRecord[] = []
    let renderedRuntime: RuntimeInfo | null = null

    function RuntimeEventsProbe() {
      const [sessions, setSessions] = useState([primeSession])
      const [runtime, setRuntime] = useState<RuntimeInfo | null>(currentRuntime)
      renderedSessions = sessions
      renderedRuntime = runtime
      useAgentEvents({
        bridge,
        runtimeIdRef,
        runtimeSessionsRef,
        runtimeOwnerRef,
        workspaceRef,
        setSessions,
        setRuntime,
        queueAgentEvent,
        reconcileTranscriptForEvent,
        showExtensionUi: vi.fn(),
        clearExtensionUi: vi.fn(),
        refreshGit: vi.fn(async () => undefined),
        refreshGitOnTerminalEvent: false,
        activeSessionVisible: true,
      })
      return <Probe />
    }

    await act(async () => { root.render(<RuntimeEventsProbe />) })
    act(() => { handler({ runtimeId: currentRuntime.runtimeId, event: { type: 'agent_start' } }) })
    expect(renderedSessions[0]).toMatchObject({ status: 'running' })
    expect(renderedRuntime).toMatchObject({ runtimeId: currentRuntime.runtimeId, isStreaming: true })

    // Both runtime ids are still mapped to this file while the old runtime is retiring.
    // Its late terminal event must not overrule the replacement's live turn.
    act(() => { handler({ runtimeId: retiredRuntime.runtimeId, event: { type: 'agent_end' } }) })

    expect(renderedSessions[0]).toMatchObject({ status: 'running' })
    expect(renderedRuntime).toMatchObject({ runtimeId: currentRuntime.runtimeId, isStreaming: true })
    expect(queueAgentEvent).toHaveBeenCalledTimes(1)
    expect(reconcileTranscriptForEvent).toHaveBeenCalledTimes(1)
  })

  it('keeps events from the other harness runtime away from visible state', async () => {
    let handler!: (payload: { runtimeId: string; event: Record<string, unknown> }) => void
    const bridge = {
      agent: { onEvent: (callback: typeof handler) => { handler = callback; return () => undefined } },
    } as unknown as PrimeWorkApi
    const setSessions = vi.fn()
    const setRuntime = vi.fn()
    const queueAgentEvent = vi.fn()
    const reconcileTranscriptForEvent = vi.fn()
    // The workspace shows Pi; the Prime runtime keeps streaming in
    // the background with its session file still registered.
    const runtimeSessionsRef = { current: new Map([[primeRuntime.runtimeId, primeSession.filePath]]) }
    function AgentEventsProbe() {
      useAgentEvents({
        bridge,
        runtimeIdRef: { current: piRuntime.runtimeId },
        runtimeSessionsRef,
        runtimeOwnerRef: { current: { runtimeId: piRuntime.runtimeId, generation: 1 } },
        workspaceRef: { current: { generation: 1, sessionFile: piSession.filePath, cwd: '/pi' } },
        setSessions,
        setRuntime,
        queueAgentEvent,
        reconcileTranscriptForEvent,
        showExtensionUi: vi.fn(),
        clearExtensionUi: vi.fn(),
        refreshGit: vi.fn(async () => undefined),
        refreshGitOnTerminalEvent: true,
        activeSessionVisible: true,
      })
      return <Probe />
    }
    await act(async () => { root.render(<AgentEventsProbe />) })
    act(() => {
      handler({ runtimeId: primeRuntime.runtimeId, event: { type: 'agent_start' } })
      handler({ runtimeId: primeRuntime.runtimeId, event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x' } } })
      handler({ runtimeId: primeRuntime.runtimeId, event: { type: 'agent_end' } })
    })
    // The Prime event leaves the active Pi session unchanged while its mapped
    // background session still receives lifecycle updates.
    for (const [updater] of setSessions.mock.calls) {
      expect((updater as (sessions: SessionRecord[]) => SessionRecord[])([piSession])).toEqual([piSession])
    }
    const backgroundPrimeSession = setSessions.mock.calls.reduce(
      (items, [updater]) => (updater as (sessions: SessionRecord[]) => SessionRecord[])(items),
      [primeSession],
    )
    expect(backgroundPrimeSession[0]).toMatchObject({ status: 'complete' })
    expect(setRuntime).not.toHaveBeenCalled()
    expect(queueAgentEvent).not.toHaveBeenCalled()
    expect(reconcileTranscriptForEvent).not.toHaveBeenCalled()

    // The visible harness's own runtime still updates state.
    act(() => { handler({ runtimeId: piRuntime.runtimeId, event: { type: 'agent_start' } }) })
    expect(setRuntime).toHaveBeenCalled()
    expect(queueAgentEvent).toHaveBeenCalledTimes(1)
  })
})

describe('provider fallback runtime state', () => {
  it('tracks the fallback separately from the selected runtime model', async () => {
    let handler!: (payload: { runtimeId: string; event: Record<string, unknown> }) => void
    const bridge = {
      agent: { onEvent: (callback: typeof handler) => { handler = callback; return () => undefined } },
    } as unknown as PrimeWorkApi
    const setRuntime = vi.fn()
    function AgentEventsProbe() {
      useAgentEvents({
        bridge,
        runtimeIdRef: { current: primeRuntime.runtimeId },
        runtimeSessionsRef: { current: new Map() },
        runtimeOwnerRef: { current: null },
        workspaceRef: { current: { generation: 0, sessionFile: primeSession.filePath, cwd: '/prime' } },
        setSessions: vi.fn(),
        setRuntime,
        queueAgentEvent: vi.fn(),
        reconcileTranscriptForEvent: vi.fn(),
        showExtensionUi: vi.fn(),
        clearExtensionUi: vi.fn(),
        refreshGit: vi.fn(async () => undefined),
        refreshGitOnTerminalEvent: false,
        activeSessionVisible: true,
      })
      return <Probe />
    }

    await act(async () => { root.render(<AgentEventsProbe />) })
    act(() => {
      handler({ runtimeId: primeRuntime.runtimeId, event: { type: 'retry_fallback_applied', from: 'anthropic/claude-opus', to: 'anthropic/claude-sonnet', role: 'fallback' } })
    })

    const update = setRuntime.mock.calls.at(-1)?.[0] as (current: RuntimeInfo) => RuntimeInfo
    const next = update({ ...primeRuntime, model: { provider: 'provider', id: 'vision' } })
    expect(next.model).toEqual({ provider: 'provider', id: 'vision' })
    expect(next.executingModel).toEqual({
      provider: 'anthropic',
      id: 'claude-sonnet',
      label: 'anthropic/claude-sonnet',
      isFallback: true,
    })

    act(() => { handler({ runtimeId: primeRuntime.runtimeId, event: { type: 'retry_fallback_succeeded', model: 'anthropic/claude-sonnet', role: 'fallback' } }) })
    const succeededUpdate = setRuntime.mock.calls.at(-1)?.[0] as (current: RuntimeInfo) => RuntimeInfo
    expect(succeededUpdate(next).executingModel).toEqual(next.executingModel)

    const callsBeforeModelChanged = setRuntime.mock.calls.length
    act(() => { handler({ runtimeId: primeRuntime.runtimeId, event: { type: 'model_changed' } }) })
    expect(setRuntime.mock.calls).toHaveLength(callsBeforeModelChanged)

    act(() => { handler({ runtimeId: primeRuntime.runtimeId, event: { type: 'agent_start' } }) })
    const reset = setRuntime.mock.calls.at(-1)?.[0] as (current: RuntimeInfo) => RuntimeInfo
    expect(reset({ ...next }).executingModel).toBeNull()
  })
})

describe('sidebar brand switcher', () => {
  const noop = () => undefined
  function renderSidebar(onSelectHarness: (harness: HarnessId) => void, activeHarness: HarnessId = 'prime', appMeta = meta) {
    return act(async () => {
      root.render(
        <Sidebar
          projects={[primeProject]}
          sessions={[primeSession]}
          activeView="session"
          activeHarness={activeHarness}
          harnesses={appMeta.harnesses}
          onSelectHarness={onSelectHarness}
          onSelectProject={noop}
          onSelectSession={noop}
          onNavigate={noop}
          onNewSession={noop}
          onAddProject={noop}
          onRemoveProject={noop}
          onClose={noop}
          onOpenPalette={noop}
          onRenameSession={async () => undefined}
          onArchiveSession={async () => undefined}
        />,
      )
    })
  }

  it('lists only harnesses with a detected executable', async () => {
    const onSelectHarness = vi.fn()
    await renderSidebar(onSelectHarness)

    const trigger = container.querySelector<HTMLButtonElement>('.brand-switcher__trigger')
    expect(trigger).not.toBeNull()
    expect(trigger!.getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger!.getAttribute('aria-expanded')).toBe('false')
    expect(trigger!.getAttribute('aria-label')).toContain('Prime Work')

    await click(trigger!)
    const menu = container.querySelector('[role="menu"]')
    expect(menu).not.toBeNull()
    const options = [...menu!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
    expect(options.map((option) => option.textContent)).toEqual(['Prime Work'])
    expect(options[0].getAttribute('aria-checked')).toBe('true')

    await click(options[0])
    expect(onSelectHarness).not.toHaveBeenCalled()
    expect(container.querySelector('[role="menu"]')).toBeNull()
  })

  it('switches to Pi from the brand switcher', async () => {
    const onSelectHarness = vi.fn()
    await renderSidebar(onSelectHarness, 'prime', allDetectedMeta)

    await click(container.querySelector('.brand-switcher__trigger')!)
    const options = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
    await click(options[0])
    expect(onSelectHarness).toHaveBeenCalledWith('pi')
    expect(container.querySelector('[role="menu"]')).toBeNull()
  })

  it('closes on Escape without selecting and shows shared navigation for Pi', async () => {
    const onSelectHarness = vi.fn()
    await renderSidebar(onSelectHarness, 'pi', allDetectedMeta)

    expect([...container.querySelectorAll('nav.sidebar__primary button span')].map((item) => item.textContent)).toEqual(['开始工作', '搜索', '我的工作'])
    expect(container.textContent).not.toContain('Capabilities')

    await click(container.querySelector('.brand-switcher__trigger')!)
    expect(container.querySelector('[role="menu"]')).not.toBeNull()
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(container.querySelector('[role="menu"]')).toBeNull()
    expect(onSelectHarness).not.toHaveBeenCalled()
  })
})

describe('provider catalog per harness', () => {
  const primeCatalog: PrimeModelCatalog = {
    primeVersion: '0.7.0', refreshedAt: '2026-08-06T00:00:00.000Z',
    models: [{ key: 'openai-codex/gpt-5.6', provider: 'openai-codex', id: 'gpt-5.6', name: 'GPT-5.6', reasoning: true, input: ['text'], contextWindow: 400_000, maxTokens: 128_000, availableThinkingLevels: ['low', 'medium', 'high'], fastModeSupported: true, available: true }],
    providers: [{ id: 'openai-codex', name: 'ChatGPT Plus/Pro', authMethod: 'oauth', configured: true, modelCount: 1, availableModelCount: 1, enabled: true }],
  }
  const piCatalog: PrimeModelCatalog = {
    primeVersion: '0.84.1', refreshedAt: '2026-08-06T00:00:00.000Z',
    models: [{ key: 'openai-codex/gpt-5.6-luna', provider: 'openai-codex', id: 'gpt-5.6-luna', name: 'Luna GPT-5.6', reasoning: true, input: ['text', 'image'], contextWindow: 400_000, maxTokens: 128_000, availableThinkingLevels: ['low', 'medium', 'high'], fastModeSupported: false, available: true }],
    providers: [{ id: 'openai-codex', name: 'OpenAI Codex', authMethod: 'external', configured: true, authLabel: 'Credentials managed by the pi CLI', modelCount: 1, availableModelCount: 1, enabled: true }],
  }

  it('waits for persisted settings before loading a provider catalog', async () => {
    const catalog = vi.fn(async () => primeCatalog)
    const bridge = {
      providers: { catalog, onAuthEvent: vi.fn().mockReturnValue(() => undefined) },
    } as unknown as PrimeWorkApi
    const reportError = vi.fn()
    function CatalogProbe({ ready }: { ready: boolean }) {
      useProviderCatalog({ bridge, ready, harness: 'prime', runtime: null, syncRuntime: async () => undefined, reportError })
      return <Probe />
    }

    await act(async () => { root.render(<CatalogProbe ready={false} />); await Promise.resolve() })
    expect(catalog).not.toHaveBeenCalled()
    await act(async () => { root.render(<CatalogProbe ready />); await Promise.resolve() })
    expect(catalog).toHaveBeenCalledWith(false, 'prime')
  })

  it('fetches per harness, caches catalogs, and selects the first usable model on switch', async () => {
    const thirdFetch = deferred<PrimeModelCatalog>()
    const catalogMock = vi.fn()
      .mockResolvedValueOnce(primeCatalog)
      .mockResolvedValueOnce(piCatalog)
      .mockImplementationOnce(() => thirdFetch.promise)
    const bridge = {
      providers: { catalog: catalogMock, onAuthEvent: vi.fn().mockReturnValue(() => undefined) },
    } as unknown as PrimeWorkApi
    let state!: ReturnType<typeof useProviderCatalog>
    const syncRuntime = async () => undefined
    const reportError = vi.fn()
    function CatalogProbe({ harness }: { harness: HarnessId }) {
      state = useProviderCatalog({ bridge, harness, runtime: null, syncRuntime, reportError })
      return <Probe />
    }
    await act(async () => { root.render(<CatalogProbe harness="prime" />); await Promise.resolve() })
    expect(catalogMock).toHaveBeenNthCalledWith(1, false, 'prime')
    expect(state.catalog).toBe(primeCatalog)

    act(() => state.changeModel('openai-codex/gpt-5.6'))
    expect(state.model).toBe('openai-codex/gpt-5.6')

    await act(async () => { root.render(<CatalogProbe harness="pi" />); await Promise.resolve() })
    expect(catalogMock).toHaveBeenNthCalledWith(2, false, 'pi')
    expect(state.catalog).toBe(piCatalog)
    expect(state.model).toBe('openai-codex/gpt-5.6-luna')
    expect(state.fast).toBe(false)

    // Switching back shows the cached prime catalog while the refresh hangs.
    await act(async () => { root.render(<CatalogProbe harness="prime" />) })
    expect(catalogMock).toHaveBeenNthCalledWith(3, false, 'prime')
    expect(state.catalog).toBe(primeCatalog)
    expect(state.model).toBe('openai-codex/gpt-5.6')
  })

  it('resolves a newly available Pi model before the catalog selection effect settles', async () => {
    const emptyPiCatalog: PrimeModelCatalog = { ...piCatalog, models: [], providers: [] }
    const catalogMock = vi.fn((force: boolean, harness?: HarnessId) => {
      if (harness === 'pi' && force) return Promise.resolve(piCatalog)
      if (harness === 'pi') return Promise.resolve(emptyPiCatalog)
      return Promise.resolve(primeCatalog)
    })
    const reportError = vi.fn()
    const bridge = {
      providers: { catalog: catalogMock, onAuthEvent: vi.fn().mockReturnValue(() => undefined) },
    } as unknown as PrimeWorkApi
    let state!: ReturnType<typeof useProviderCatalog>
    function CatalogProbe({ harness }: { harness: HarnessId }) {
      state = useProviderCatalog({ bridge, harness, runtime: null, syncRuntime: async () => undefined, reportError })
      return <Probe />
    }

    await act(async () => { root.render(<CatalogProbe harness="pi" />); await Promise.resolve() })
    expect(state.model).toBe('')

    let selection!: Awaited<ReturnType<typeof state.resolveModelSelection>>
    await act(async () => { selection = await state.resolveModelSelection() })

    expect(catalogMock).toHaveBeenNthCalledWith(1, false, 'pi')
    expect(catalogMock).toHaveBeenNthCalledWith(2, true, 'pi')
    expect(selection).toMatchObject({ model: { key: 'openai-codex/gpt-5.6-luna' }, effort: 'medium', fast: false })
    expect(state.model).toBe('openai-codex/gpt-5.6-luna')
  })

  it('does not apply a late Pi model resolution after switching back to Prime', async () => {
    const latePiCatalog = deferred<PrimeModelCatalog>()
    const emptyPiCatalog: PrimeModelCatalog = { ...piCatalog, models: [], providers: [] }
    const catalogMock = vi.fn((force: boolean, harness?: HarnessId) => {
      if (harness === 'pi' && force) return latePiCatalog.promise
      if (harness === 'pi') return Promise.resolve(emptyPiCatalog)
      return Promise.resolve(primeCatalog)
    })
    const reportError = vi.fn()
    const bridge = {
      providers: { catalog: catalogMock, onAuthEvent: vi.fn().mockReturnValue(() => undefined) },
    } as unknown as PrimeWorkApi
    let state!: ReturnType<typeof useProviderCatalog>
    function CatalogProbe({ harness }: { harness: HarnessId }) {
      state = useProviderCatalog({ bridge, harness, runtime: null, syncRuntime: async () => undefined, reportError })
      return <Probe />
    }

    await act(async () => { root.render(<CatalogProbe harness="pi" />); await Promise.resolve() })
    const pendingResolution = state.resolveModelSelection()
    expect(catalogMock).toHaveBeenLastCalledWith(true, 'pi')

    await act(async () => { root.render(<CatalogProbe harness="prime" />); await Promise.resolve() })
    expect(state.model).toBe('openai-codex/gpt-5.6')
    latePiCatalog.resolve(piCatalog)
    let selection!: Awaited<ReturnType<typeof state.resolveModelSelection>>
    await act(async () => { selection = await pendingResolution })

    expect(selection).toBeUndefined()
    expect(state.catalog).toBe(primeCatalog)
    expect(state.model).toBe('openai-codex/gpt-5.6')
  })

  it('restores a usable remembered model and replaces a stale preference with the first usable model', async () => {
    const alternate = { ...primeCatalog.models[0], key: 'openai-codex/gpt-5.5', id: 'gpt-5.5', name: 'GPT-5.5' }
    const catalog = { ...primeCatalog, models: [primeCatalog.models[0], alternate] }
    const bridge = {
      providers: { catalog: vi.fn(async () => catalog), onAuthEvent: vi.fn().mockReturnValue(() => undefined) },
    } as unknown as PrimeWorkApi
    const rememberModel = vi.fn()
    const reportError = vi.fn()
    let state!: ReturnType<typeof useProviderCatalog>
    function CatalogProbe({ lastSelectedModel }: { lastSelectedModel: string }) {
      state = useProviderCatalog({ bridge, harness: 'prime', runtime: null, lastSelectedModel, rememberModel, syncRuntime: async () => undefined, reportError })
      return <Probe />
    }

    await act(async () => { root.render(<CatalogProbe lastSelectedModel={alternate.key} />); await Promise.resolve() })
    expect(state.model).toBe(alternate.key)
    expect(rememberModel).not.toHaveBeenCalled()

    await act(async () => { root.render(<CatalogProbe key="stale-preference" lastSelectedModel="missing/model" />); await Promise.resolve() })
    expect(state.model).toBe(primeCatalog.models[0].key)
    expect(rememberModel).toHaveBeenLastCalledWith(primeCatalog.models[0].key)
  })

  it('syncs model and thinking level from active session metadata when runtime has no live model', async () => {
    const alternate = { ...primeCatalog.models[0], key: 'openai-codex/gpt-5.5', id: 'gpt-5.5', name: 'GPT-5.5' }
    const catalog = { ...primeCatalog, models: [primeCatalog.models[0], alternate] }
    const bridge = {
      providers: { catalog: vi.fn(async () => catalog), onAuthEvent: vi.fn().mockReturnValue(() => undefined) },
    } as unknown as PrimeWorkApi
    const reportError = vi.fn()
    let state!: ReturnType<typeof useProviderCatalog>
    function CatalogProbe({ activeSession }: { activeSession?: SessionRecord }) {
      state = useProviderCatalog({ bridge, harness: 'prime', runtime: null, activeSession, syncRuntime: async () => undefined, reportError })
      return <Probe />
    }

    const sessionA: SessionRecord = {
      ...primeSession,
      id: 'session-a',
      provider: 'openai-codex',
      model: 'gpt-5.5',
      thinkingLevel: 'low',
    }

    const sessionB: SessionRecord = {
      ...primeSession,
      id: 'session-b',
      provider: 'openai-codex',
      model: primeCatalog.models[0].id,
      thinkingLevel: 'high',
    }

    await act(async () => { root.render(<CatalogProbe activeSession={sessionA} />); await Promise.resolve() })
    expect(state.model).toBe('openai-codex/gpt-5.5')
    expect(state.effort).toBe('low')

    await act(async () => { root.render(<CatalogProbe activeSession={sessionB} />); await Promise.resolve() })
    expect(state.model).toBe(primeCatalog.models[0].key)
    expect(state.effort).toBe('high')

    await act(async () => { root.render(<CatalogProbe activeSession={sessionA} />); await Promise.resolve() })
    expect(state.model).toBe('openai-codex/gpt-5.5')
    expect(state.effort).toBe('low')

    await act(async () => { root.render(<CatalogProbe activeSession={sessionB} />); await Promise.resolve() })
    expect(state.model).toBe(primeCatalog.models[0].key)
    expect(state.effort).toBe('high')
  })

  it('keeps an unsent selection per tab and prefers it over session metadata', async () => {
    const alternate = { ...primeCatalog.models[0], key: 'openai-codex/gpt-5.5', id: 'gpt-5.5', name: 'GPT-5.5' }
    const catalog = { ...primeCatalog, models: [primeCatalog.models[0], alternate] }
    const bridge = {
      providers: { catalog: vi.fn(async () => catalog), onAuthEvent: vi.fn().mockReturnValue(() => undefined) },
    } as unknown as PrimeWorkApi
    const reportError = vi.fn()
    let state!: ReturnType<typeof useProviderCatalog>
    function CatalogProbe({ activeSession }: { activeSession?: SessionRecord }) {
      state = useProviderCatalog({ bridge, harness: 'prime', runtime: null, activeSession, syncRuntime: async () => undefined, reportError })
      return <Probe />
    }

    const sessionA: SessionRecord = {
      ...primeSession,
      id: 'session-a',
      provider: 'openai-codex',
      model: 'gpt-5.5',
      thinkingLevel: 'low',
    }
    const sessionB: SessionRecord = {
      ...primeSession,
      id: 'session-b',
      provider: 'openai-codex',
      model: primeCatalog.models[0].id,
      thinkingLevel: 'high',
    }

    await act(async () => { root.render(<CatalogProbe activeSession={sessionA} />); await Promise.resolve() })
    expect(state.model).toBe('openai-codex/gpt-5.5')
    expect(state.effort).toBe('low')

    act(() => state.changeModel(primeCatalog.models[0].key))
    act(() => state.changeEffort('high'))
    await act(async () => { root.render(<CatalogProbe activeSession={sessionB} />); await Promise.resolve() })
    expect(state.model).toBe(primeCatalog.models[0].key)
    expect(state.effort).toBe('high')

    await act(async () => { root.render(<CatalogProbe activeSession={sessionA} />); await Promise.resolve() })
    expect(state.model).toBe(primeCatalog.models[0].key)
    expect(state.effort).toBe('high')

    await act(async () => { root.render(<CatalogProbe activeSession={undefined} />); await Promise.resolve() })
    act(() => state.changeModel('openai-codex/gpt-5.5'))
    await act(async () => { root.render(<CatalogProbe activeSession={sessionB} />); await Promise.resolve() })
    await act(async () => { root.render(<CatalogProbe activeSession={undefined} />); await Promise.resolve() })
    expect(state.model).toBe('openai-codex/gpt-5.5')
  })

  it('prefers the live runtime model over session metadata', async () => {
    const alternate = { ...primeCatalog.models[0], key: 'openai-codex/gpt-5.5', id: 'gpt-5.5', name: 'GPT-5.5' }
    const catalog = { ...primeCatalog, models: [primeCatalog.models[0], alternate] }
    const bridge = {
      providers: { catalog: vi.fn(async () => catalog), onAuthEvent: vi.fn().mockReturnValue(() => undefined) },
    } as unknown as PrimeWorkApi
    const reportError = vi.fn()
    let state!: ReturnType<typeof useProviderCatalog>
    function CatalogProbe({ runtime, activeSession }: { runtime: RuntimeInfo | null; activeSession?: SessionRecord }) {
      state = useProviderCatalog({ bridge, harness: 'prime', runtime, activeSession, syncRuntime: async () => undefined, reportError })
      return <Probe />
    }

    const sessionB: SessionRecord = {
      ...primeSession,
      id: 'session-b',
      provider: 'openai-codex',
      model: primeCatalog.models[0].id,
      thinkingLevel: 'high',
    }

    await act(async () => {
      root.render(<CatalogProbe
        activeSession={sessionB}
        runtime={{ ...primeRuntime, model: { provider: 'openai-codex', id: 'gpt-5.5' }, thinkingLevel: 'low' }}
      />)
      await Promise.resolve()
    })
    expect(state.model).toBe('openai-codex/gpt-5.5')
    expect(state.effort).toBe('low')
  })

  it('does not revert a selection when the catalog refreshes for the same session', async () => {
    const alternate = { ...primeCatalog.models[0], key: 'openai-codex/gpt-5.5', id: 'gpt-5.5', name: 'GPT-5.5' }
    const catalog = { ...primeCatalog, models: [primeCatalog.models[0], alternate] }
    const catalogMock = vi.fn()
      .mockResolvedValueOnce(catalog)
      .mockImplementation(async (force: boolean) => force ? { ...catalog } : catalog)
    const bridge = {
      providers: { catalog: catalogMock, onAuthEvent: vi.fn().mockReturnValue(() => undefined) },
    } as unknown as PrimeWorkApi
    const reportError = vi.fn()
    let state!: ReturnType<typeof useProviderCatalog>
    function CatalogProbe({ activeSession }: { activeSession?: SessionRecord }) {
      state = useProviderCatalog({ bridge, harness: 'prime', runtime: null, activeSession, syncRuntime: async () => undefined, reportError })
      return <Probe />
    }

    const sessionA: SessionRecord = {
      ...primeSession,
      id: 'session-a',
      provider: 'openai-codex',
      model: 'gpt-5.5',
      thinkingLevel: 'low',
    }

    await act(async () => { root.render(<CatalogProbe activeSession={sessionA} />); await Promise.resolve() })
    act(() => state.changeModel(primeCatalog.models[0].key))
    await act(async () => { await state.refresh(true) })
    expect(state.model).toBe(primeCatalog.models[0].key)
  })
})

describe('harness settings surfaces', () => {
  it('follows a changed initial section while the settings page stays mounted', async () => {
    const noop = () => undefined
    const noopAsync = async () => undefined
    const renderSettings = (initialSection: 'general' | 'agent', initialSectionRequestId = 0) => (
      <SettingsPage
        settings={DEFAULT_SETTINGS}
        meta={meta}
        providerCatalog={null}
        voice={null}
        initialSection={initialSection}
        initialSectionRequestId={initialSectionRequestId}
        onClose={noop}
        onUpdate={noop}
        onResetBrowser={noop}
        onOpenDocs={noop}
        onRefreshProviders={noopAsync}
        onRefreshHarnesses={noopAsync}
        onSaveProviderApiKey={noopAsync}
        onLogoutProvider={noopAsync}
        onSetProviderEnabled={noopAsync}
        onSetAllProvidersEnabled={noopAsync}
        onSetAllProvidersDisabled={noopAsync}
        onSetModelEnabled={noopAsync}
        onStartProviderOAuth={noopAsync}
        onEnterpriseCancelSignIn={async () => undefined} onEnterpriseReopenSignIn={async () => undefined} onEnterpriseSignIn={noopAsync}
        onEnterpriseSignOut={noopAsync}
      />
    )

    await act(async () => { root.render(renderSettings('general')) })
    expect(container.querySelector('h1')?.textContent).toBe('General')
    await act(async () => { root.render(renderSettings('agent')); await Promise.resolve() })
    expect(container.querySelector('h1')?.textContent).toBe('Harness')
    expect(container.querySelector('.settings-nav .is-active')?.textContent).toContain('运行环境')

    await click([...container.querySelectorAll<HTMLButtonElement>('.settings-nav button')].find((button) => button.textContent?.includes('常规'))!)
    expect(container.querySelector('h1')?.textContent).toBe('General')
    await act(async () => { root.render(renderSettings('agent', 1)); await Promise.resolve() })
    expect(container.querySelector('h1')?.textContent).toBe('Harness')
  })

  it('offers only Prime and Pi as harness settings and omits retired OMP controls', async () => {
    const onUpdate = vi.fn()
    const onRefreshHarnesses = vi.fn(async () => undefined)
    const primeSettings: AppSettings = { ...DEFAULT_SETTINGS, activeHarness: 'prime' }
    await act(async () => { root.render(<AgentSettings settings={primeSettings} meta={meta} onUpdate={onUpdate} onRefreshHarnesses={onRefreshHarnesses} />) })
    expect(container.textContent).toContain('Default harness')
    expect(container.textContent).not.toContain('OMP')
    expect(container.textContent).toContain('Prime Agent is ready')
    expect(container.textContent).toContain('Pi not detected')
    expect([...container.querySelectorAll<HTMLSelectElement>('select')[0].options].map((option) => option.textContent)).toEqual(['Prime Work'])

    const refresh = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Refresh harnesses'))!
    await click(refresh)
    expect(onRefreshHarnesses).toHaveBeenCalledTimes(1)

    await act(async () => { root.render(<AgentSettings settings={primeSettings} meta={allDetectedMeta} onUpdate={onUpdate} onRefreshHarnesses={onRefreshHarnesses} />) })
    const harnessSelect = container.querySelector<HTMLSelectElement>('select')!
    await select(harnessSelect!, 'pi')
    expect(onUpdate).toHaveBeenCalledWith({ activeHarness: 'pi' })

    const piSettings: AppSettings = { ...DEFAULT_SETTINGS, activeHarness: 'pi' }
    await act(async () => { root.render(<AgentSettings settings={piSettings} meta={allDetectedMeta} onUpdate={onUpdate} onRefreshHarnesses={onRefreshHarnesses} />) })
    expect(container.textContent).not.toContain('OMP')
    const selects = [...container.querySelectorAll<HTMLSelectElement>('select')]
    expect(selects).toHaveLength(1)
    expect([...selects[0].options].map((option) => option.textContent)).toEqual(['Prime Work', 'Pi Work'])
  })

  it('renders a harness discovery problem in its runtime card', async () => {
    const onUpdate = vi.fn()
    const onRefreshHarnesses = vi.fn(async () => undefined)
    const problemMeta: AppMeta = {
      ...meta,
      harnesses: {
        ...meta.harnesses,
        pi: { path: null, version: null, problem: { path: '/Users/you/.local/bin/pi', reason: 'exited with code 1: Node.js is too old' } },
      },
    }

    await act(async () => {
      root.render(<AgentSettings settings={{ ...DEFAULT_SETTINGS, activeHarness: 'prime' }} meta={problemMeta} onUpdate={onUpdate} onRefreshHarnesses={onRefreshHarnesses} />)
    })

    const piCard = [...container.querySelectorAll('.runtime-card')].find((card) => card.textContent?.includes('Pi not detected'))
    expect(piCard?.querySelector('small')?.getAttribute('title')).toBe('/Users/you/.local/bin/pi: exited with code 1: Node.js is too old')
    expect(container.textContent).toContain('/Users/you/.local/bin/pi: exited with code 1: Node.js is too old')
  })

  it('renders Pi provider visibility toggles while keeping credentials CLI-owned', async () => {
    const catalog: PrimeModelCatalog = {
      primeVersion: '0.84.1', refreshedAt: '2026-08-06T00:00:00.000Z',
      models: [{ key: 'openai-codex/gpt-5.6-luna', provider: 'openai-codex', id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', reasoning: true, input: ['text'], contextWindow: 272_000, maxTokens: 128_000, availableThinkingLevels: ['low', 'high'], fastModeSupported: true, available: true }],
      providers: [
        { id: 'openai-codex', name: 'OpenAI Codex', authMethod: 'external', configured: true, modelCount: 1, availableModelCount: 1, enabled: true },
        { id: 'anthropic', name: 'Anthropic', authMethod: 'external', configured: true, modelCount: 0, availableModelCount: 0, enabled: true },
      ],
    }
    const noopAsync = async () => undefined
    const onSetEnabled = vi.fn(async () => undefined)
    await act(async () => {
      root.render(<ProviderSettings harness="pi" catalog={catalog} onRefresh={noopAsync} onSaveApiKey={noopAsync} onLogout={noopAsync} onSetEnabled={onSetEnabled} onSetAllEnabled={noopAsync} onSetAllDisabled={noopAsync} onSetModelEnabled={noopAsync} onStartOAuth={noopAsync} onOpenDocs={() => undefined} />)
    })

    expect(container.textContent).toContain('Pi catalogue')
    expect(container.textContent).toContain('Credentials managed by the pi CLI')
    const toggles = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    expect(toggles).toHaveLength(2)
    const buttonLabels = [...container.querySelectorAll('button')].map((button) => button.textContent ?? '')
    expect(buttonLabels.some((text) => text.includes('Hide all'))).toBe(true)
    expect(buttonLabels.some((text) => text.includes('Credential setup'))).toBe(true)
    for (const label of ['Connect', 'Reconnect', 'Add key', 'Replace key', 'Disable all', 'Enable all']) {
      expect(buttonLabels.some((text) => text.includes(label))).toBe(false)
    }

    // Toggling a provider only asks the desktop app to hide it; auth stays with the pi CLI.
    await click(toggles[0])
    expect(onSetEnabled).toHaveBeenCalledWith('openai-codex', false)
  })
})
