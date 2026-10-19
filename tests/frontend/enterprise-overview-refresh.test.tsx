// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import App from '../../src/App'
import { DEFAULT_SETTINGS } from '../../src/lib/data'
import type { EnterpriseSession, EnterpriseWorkOverview, PrimeWorkApi, WorkspaceView } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
vi.mock('../../src/components/Sidebar', () => ({ Sidebar: ({ onNavigate, pendingWorkCount }: { onNavigate(view: WorkspaceView): void; pendingWorkCount?: number }) => <nav>
  <button type="button" onClick={() => onNavigate('activity')}>工作入口</button>
  <button type="button" onClick={() => onNavigate('session')}>返回会话</button>
  <output data-testid="pending-count">{pendingWorkCount ?? 'unknown'}</output>
</nav> }))

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const signedIn = (id: string): EnterpriseSession => ({ version: '1', status: 'signed-in', environment: { origin: 'http://forge.example.test', secure: false }, storage: 'session-only', user: { id, weaveUserId: id, name: id, email: `${id}@example.test` }, organization: { id: 'org', name: 'Test organization' }, permissions: ['teams:use'] })
const overview = (title: string, count = 1): EnterpriseWorkOverview => ({ loadedAt: '2026-10-02T00:00:00Z', choices: [], tasks: [], runs: [],
  items: Array.from({ length: count }, (_, index) => ({ id: `${title}-${index}`, title, kind: 'revision_required', status: 'pending', actionable: true, read: false, source: 'forge', createdAt: '2026-10-02T00:00:00Z' })),
  reads: { runs: { status: 'loaded' }, teamChoices: { status: 'loaded' }, weaveTasks: { status: 'loaded' }, forgeApprovals: { status: 'loaded' }, notifications: { status: 'loaded' } } })

let root: Root, container: HTMLDivElement
let publish: (session: EnterpriseSession) => void
let requests: Array<ReturnType<typeof deferred<EnterpriseWorkOverview>>>
let read: ReturnType<typeof vi.fn<() => Promise<EnterpriseWorkOverview>>>

beforeEach(() => {
  requests = []
  read = vi.fn(() => { const request = deferred<EnterpriseWorkOverview>(); requests.push(request); return request.promise })
  const noopSubscription = () => () => undefined
  const meta = { version: 'test', platform: 'linux', homeDir: '/home/test', harnesses: { prime: { path: '/usr/bin/prime', version: 'test' }, pi: { path: null, version: null } } }
  let settings = { ...DEFAULT_SETTINGS, activeHarness: 'prime' as const, inspectorOpen: false }
  const bridge = {
    app: { getMeta: async () => meta, refreshHarnesses: async () => ({ meta, settings }), setTitleBarTheme: async () => true, onOpenSettings: noopSubscription },
    enterprise: { getSession: async () => signedIn('alice'), onSessionChanged: (callback: typeof publish) => { publish = callback; return () => undefined }, getWorkOverview: read, onSecretPrompt: noopSubscription, answerSecretPrompt: async () => undefined, onOperationPrompt: noopSubscription, answerOperationPrompt: async () => undefined, onActionConfirmation: noopSubscription, answerActionConfirmation: async () => undefined },
    settings: { get: async () => settings, update: async (patch: Partial<typeof settings>) => { settings = { ...settings, ...patch }; return settings } },
    updates: { getState: async () => ({ phase: 'idle' }), onChanged: noopSubscription },
    projects: { list: async () => [] }, sessions: { list: async () => [], read: async () => [], onChanged: noopSubscription },
    agent: { list: async () => [], onEvent: noopSubscription }, pets: { list: async () => [] },
    providers: { catalog: async () => ({ models: [], providers: [] }), onAuthEvent: noopSubscription }, plugins: { list: async () => ({ skills: [], warnings: [] }) },
    browser: { state: async () => ({ tabs: [] }), onChanged: noopSubscription, onPointer: noopSubscription, onActivity: noopSubscription, setPreviewContext: async () => true },
    schedules: { list: async () => [], onChanged: noopSubscription }, heartbeats: { list: async () => [] }, git: { status: async () => ({ isRepo: false, files: [] }) },
  } as unknown as PrimeWorkApi
  Object.defineProperty(window, 'prime', { configurable: true, value: bridge })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); Object.defineProperty(window, 'prime', { configurable: true, value: undefined }); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const render = async () => { await import('../../src/pages/EnterpriseWorkPage'); await act(async () => root.render(<App />)); await act(async () => {}) }
const click = async (text: string) => { await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === text)!.click()) }
const settle = async (index: number, title: string, count = 1) => { await act(async () => requests[index].resolve(overview(title, count))) }

it('loads on sign-in and re-enters My Work with a fresh read despite a cached overview, without a loading loop', async () => {
  await render()
  expect(read).toHaveBeenCalledOnce()
  await settle(0, 'cached', 1)
  expect(container.querySelector('output')?.textContent).toBe('1')
  await click('工作入口')
  expect(read).toHaveBeenCalledTimes(2)
  await settle(1, 'current', 2)
  expect(container.textContent).toContain('current')
  expect(container.querySelector('output')?.textContent).toBe('2')
  await act(async () => {})
  expect(read).toHaveBeenCalledTimes(2)
  await click('返回会话'); await click('工作入口')
  expect(read).toHaveBeenCalledTimes(3)
  await settle(2, 'latest', 3)
})

it('coalesces foreground visibility, focus and repeated refresh requests synchronously', async () => {
  await render(); await settle(0, 'initial')
  await act(async () => {
    window.dispatchEvent(new Event('blur'))
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
  })
  expect(read).toHaveBeenCalledTimes(2)
  await click('工作入口')
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[aria-label="刷新工作"]')!.click()
    container.querySelector<HTMLButtonElement>('[aria-label="刷新工作"]')!.click()
  })
  expect(read).toHaveBeenCalledTimes(2)
  await settle(1, 'foreground', 2)
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(read).toHaveBeenCalledTimes(2)
})

it('refreshes a re-published identity and stops reading once signed out', async () => {
  await render(); await settle(0, 'initial')
  const session = signedIn('alice')
  await act(async () => publish(session))
  expect(read).toHaveBeenCalledTimes(2)
  await settle(1, 'renewed')
  await act(async () => publish(session))
  expect(read).toHaveBeenCalledTimes(3)
  await act(async () => publish({ ...session, status: 'signed-out', user: undefined }))
  await settle(2, 'late-after-signout', 9)
  await act(async () => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')) })
  expect(read).toHaveBeenCalledTimes(3)
  expect(container.textContent).not.toContain('late-after-signout')
})

it.each(['resolve', 'reject'] as const)('discards an old-account %s and does not release the new account request fence', async (outcome) => {
  await render(); await settle(0, 'alice-cache')
  await click('工作入口')
  await act(async () => publish(signedIn('bob')))
  expect(read).toHaveBeenCalledTimes(3)
  expect(container.textContent).not.toContain('alice-cache')
  await act(async () => {
    if (outcome === 'resolve') requests[1].resolve(overview('alice-late', 7))
    else requests[1].reject(new Error('alice-late-error'))
  })
  expect(container.textContent).not.toContain('alice-late')
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="刷新工作"]')!.click())
  expect(read).toHaveBeenCalledTimes(3)
  await settle(2, 'bob-current', 2)
  expect(container.textContent).toContain('bob-current')
  expect(container.querySelector('output')?.textContent).toBe('2')
})
