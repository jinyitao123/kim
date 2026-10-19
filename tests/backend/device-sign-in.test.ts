import { mkdtemp, readdir, readFile, rm, stat, writeFile, chmod, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EnterpriseService } from '../../electron/main/enterprise'
import { createSessionTokenStore, type SessionTokenStore } from '../../electron/main/enterprise/session-token-store'

const FORGE = 'http://forge.example.test', WEAVE = 'http://weave.example.test'
const environment = { WORKBENCH_FORGE_URL: FORGE, WORKBENCH_WEAVE_URL: WEAVE }
const PAGE = `${FORGE}/_console/auth/device?user_code=WXYZ2345`

type Poll = Response | Error | Promise<Response>
interface ForgeDouble {
  /** What each poll of the pending code answers, in order; the last one repeats. */
  polls?: Poll[]
  code?: Response
  nativeSession?: () => Response | Promise<Response>
  exchange?: () => Response | Promise<Response>
}

const pending = () => Response.json({ error: 'authorization_pending' }, { status: 400 })
const released = (token = 'native-desktop-session') => Response.json({ access_token: token, token_type: 'Bearer', expires_in: 1209600 })
const nativeSession = (session: Record<string, unknown> = { activeOrganizationId: 'forge-org', expiresAt: new Date(Date.now() + 1209600_000).toISOString() }) =>
  Response.json({ user: { id: 'forge-1', email: 'employee@example.test', name: 'Employee' }, session })
const weaveBinding = () => Response.json({ token: 'weave-session', expiresIn: 1209600, subject: { id: 'weave-1', externalId: 'forge-1', email: 'employee@example.test', name: 'Employee' }, organization: { id: 'default', name: 'Default' }, issuer: 'forge:test-deployment', permissions: ['teams:use'] })

function forge(double: ForgeDouble = {}) {
  const calls: Array<{ path: string; body?: Record<string, unknown>; authorization: string | null }> = []
  const polls = [...(double.polls ?? [released()])]
  const fetcher = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({ path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined, authorization: new Headers(init?.headers).get('Authorization') })
    if (url.origin === FORGE && url.pathname === '/api/v1/auth/device/code') {
      return double.code?.clone() ?? Response.json({ device_code: 'device-code', user_code: 'WXYZ2345', verification_uri: `${FORGE}/_console/auth/device`, verification_uri_complete: PAGE, expires_in: 1800, interval: 5 })
    }
    if (url.origin === FORGE && url.pathname === '/api/v1/auth/device/token') {
      const next = polls.length > 1 ? polls.shift()! : polls[0]!
      if (next instanceof Error) throw next
      return next instanceof Response ? next.clone() : next
    }
    if (url.origin === FORGE && url.pathname === '/api/v1/auth/get-session') return (double.nativeSession ?? nativeSession)()
    if (url.origin === FORGE && url.pathname === '/api/v1/auth/sign-out') return Response.json({ success: true })
    if (url.origin === WEAVE && url.pathname === '/v1/auth/external/exchange') return (double.exchange ?? weaveBinding)()
    return Response.json({}, { status: 404 })
  }) as unknown as typeof fetch
  return { fetch: fetcher, calls, paths: () => calls.map((call) => call.path) }
}

function memoryStore(initial?: string) {
  const saved: { token?: string } = { token: initial }
  const store = {
    get token() { return saved.token },
    set token(token: string | undefined) { saved.token = token },
    read: vi.fn(async (): Promise<string | undefined> => saved.token),
    write: vi.fn(async (token: string): Promise<void> => { saved.token = token }),
    clear: vi.fn(async (): Promise<void> => { saved.token = undefined }),
  }
  return store satisfies SessionTokenStore
}

const noWait = async () => undefined

describe('desktop sign-in through a browser approval', () => {
  it('shows the code, opens the approval page, and signs in once the browser approves', async () => {
    const double = forge({ polls: [pending(), Response.json({ error: 'slow_down' }, { status: 400 }), released()] })
    const waits: number[] = [], opened: string[] = [], store = memoryStore()
    const changes: Array<{ status: string; code?: string }> = []
    const service = new EnterpriseService({
      fetch: double.fetch, environment, tokenStore: store,
      openExternal: async (url) => { opened.push(url) },
      signInDelay: async (milliseconds) => { waits.push(milliseconds) },
    })
    service.setSessionScopeChangeHandler(async (session) => { changes.push({ status: session.status, code: session.signIn?.userCode }) })

    const session = await service.signIn()

    expect(session).toMatchObject({ status: 'signed-in', storage: 'private-file', user: { id: 'forge-1', email: 'employee@example.test' }, organization: { id: 'default' } })
    expect(session.signIn).toBeUndefined()
    expect(opened).toEqual([PAGE])
    // The employee sees the code before anything is released, and it is gone once they are in.
    expect(changes).toEqual([{ status: 'signed-out', code: undefined }, { status: 'signed-out', code: 'WXYZ2345' }, { status: 'signed-in', code: undefined }])
    // Forge sets the pace, and asks for a slower one once.
    expect(waits).toEqual([5000, 5000, 10000])
    expect(double.calls[0]).toMatchObject({ path: '/api/v1/auth/device/code', body: { client_id: 'xiaoman-desktop' } })
    expect(double.calls[1]?.body).toEqual({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: 'device-code', client_id: 'xiaoman-desktop' })
    // Only the native session is kept; neither the Weave session nor the account is written down.
    expect(store.token).toBe('native-desktop-session')
    expect(store.write).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(session)).not.toContain('native-desktop-session')
    expect((await service.authorizationHeaders()).get('Authorization')).toBe('Bearer weave-session')
  })

  it.each([
    ['access_denied', '已在浏览器中拒绝这次登录'],
    ['expired_token', '登录确认已过期，请重新登录'],
  ])('stops waiting when Forge answers %s', async (error, message) => {
    const double = forge({ polls: [pending(), Response.json({ error }, { status: 400 })] }), store = memoryStore()
    const service = new EnterpriseService({ fetch: double.fetch, environment, tokenStore: store, signInDelay: noWait })
    await expect(service.signIn()).rejects.toThrow(message)
    await expect(service.getSession()).resolves.toEqual(expect.objectContaining({ status: 'signed-out' }))
    expect((await service.getSession()).signIn).toBeUndefined()
    expect(store.write).not.toHaveBeenCalled()
    expect(double.paths()).not.toContain('/v1/auth/external/exchange')
  })

  it.each([
    [Response.json({}, { status: 404 }), '这个 Forge 还没有启用设备登录，请联系管理员'],
    [Response.json({ error: 'invalid_client' }, { status: 400 }), '这个 Forge 不接受从桌面登录，请联系管理员'],
    [Response.json({ device_code: 'device-code', user_code: 'WXYZ2345', verification_uri: 'http://elsewhere.example.test/auth/device', expires_in: 1800, interval: 5 }), '登录确认页不属于当前 Forge，已停止登录'],
  ])('does not start a sign-in Forge cannot or should not carry out', async (code, message) => {
    const double = forge({ code }), opened: string[] = []
    const service = new EnterpriseService({ fetch: double.fetch, environment, openExternal: async (url) => { opened.push(url) }, signInDelay: noWait })
    await expect(service.signIn()).rejects.toThrow(message)
    expect(opened).toEqual([])
    expect(double.paths()).toEqual(['/api/v1/auth/device/code'])
  })

  it('cancels the wait, and an approval that arrives afterwards signs nobody in', async () => {
    let releasePoll!: (response: Response) => void
    const late = new Promise<Response>((resolve) => { releasePoll = resolve })
    const double = forge({ polls: [late] }), store = memoryStore()
    let polling!: () => void
    const reachedPoll = new Promise<void>((resolve) => { polling = resolve })
    const service = new EnterpriseService({ fetch: double.fetch, environment, tokenStore: store, signInDelay: async () => { polling() } })

    const signingIn = service.signIn()
    const refused = expect(signingIn).rejects.toThrow('已取消登录')
    await reachedPoll
    await vi.waitFor(() => expect(double.paths()).toContain('/api/v1/auth/device/token'))
    await expect(service.cancelSignIn()).resolves.toMatchObject({ status: 'signed-out' })
    releasePoll(released())
    await refused

    await expect(service.getSession()).resolves.toMatchObject({ status: 'signed-out' })
    expect((await service.getSession()).signIn).toBeUndefined()
    expect(store.token).toBeUndefined()
    expect(double.paths()).not.toContain('/api/v1/auth/get-session')
    await expect(service.authorizationHeaders()).rejects.toThrow('请先登录')
    // The session Forge released at that moment has no owner here, so Forge is asked to end it.
    await vi.waitFor(() => expect(double.calls.at(-1)).toMatchObject({ path: '/api/v1/auth/sign-out', authorization: 'Bearer native-desktop-session' }))
  })

  it('opens the approval page again only while a sign-in is waiting for it', async () => {
    let releasePoll!: (response: Response) => void
    const double = forge({ polls: [new Promise<Response>((resolve) => { releasePoll = resolve })] }), opened: string[] = []
    const service = new EnterpriseService({ fetch: double.fetch, environment, openExternal: async (url) => { opened.push(url) }, signInDelay: noWait })
    await expect(service.reopenSignIn()).rejects.toThrow('当前没有等待确认的登录')

    const signingIn = service.signIn()
    await vi.waitFor(() => expect(double.paths()).toContain('/api/v1/auth/device/token'))
    await service.reopenSignIn()
    expect(opened).toEqual([PAGE, PAGE])
    releasePoll(released())
    await signingIn
    await expect(service.reopenSignIn()).rejects.toThrow('当前没有等待确认的登录')
  })

  it('refuses an account whose session carries no organization instead of choosing one', async () => {
    const double = forge({ nativeSession: () => nativeSession({ activeOrganizationId: null }) }), store = memoryStore()
    const service = new EnterpriseService({ fetch: double.fetch, environment, tokenStore: store, signInDelay: noWait })
    await expect(service.signIn()).rejects.toThrow('这个账号还没有可用的组织')
    expect(store.token).toBeUndefined()
    expect(double.paths()).not.toContain('/v1/auth/external/exchange')
  })

  it('signs in for this run only when the session cannot be saved', async () => {
    const double = forge(), store = memoryStore()
    store.write.mockRejectedValueOnce(new Error('disk full'))
    const service = new EnterpriseService({ fetch: double.fetch, environment, tokenStore: store, signInDelay: noWait })
    await expect(service.signIn()).resolves.toMatchObject({ status: 'signed-in', storage: 'session-only' })
  })
})

describe('desktop sign-in kept across restarts', () => {
  it('picks up the saved session without the browser, and reads the account and permissions afresh', async () => {
    const double = forge(), store = memoryStore('native-desktop-session'), opened: string[] = []
    const service = new EnterpriseService({ fetch: double.fetch, environment, tokenStore: store, openExternal: async (url) => { opened.push(url) } })

    await expect(service.restoreSession()).resolves.toMatchObject({ status: 'signed-in', storage: 'private-file', user: { email: 'employee@example.test' }, permissions: ['teams:use'] })

    expect(opened).toEqual([])
    expect(double.paths()).toEqual(['/api/v1/auth/get-session', '/v1/auth/external/exchange'])
    expect(double.calls.every((call) => call.authorization === 'Bearer native-desktop-session')).toBe(true)
    expect(store.write).not.toHaveBeenCalled()
    expect(store.token).toBe('native-desktop-session')
  })

  it('forgets a saved session Forge no longer honours', async () => {
    const double = forge({ nativeSession: () => Response.json({}, { status: 401 }) }), store = memoryStore('revoked-session')
    const service = new EnterpriseService({ fetch: double.fetch, environment, tokenStore: store })
    const session = await service.restoreSession()
    expect(session).toMatchObject({ status: 'signed-out' })
    expect(session.message).toBeUndefined()
    expect(store.token).toBeUndefined()
  })

  it('treats a session with no account behind it as ended', async () => {
    const double = forge({ nativeSession: () => Response.json(null) }), store = memoryStore('orphaned-session')
    const service = new EnterpriseService({ fetch: double.fetch, environment, tokenStore: store })
    await expect(service.restoreSession()).resolves.toMatchObject({ status: 'signed-out' })
    expect(store.token).toBeUndefined()
  })

  it('keeps the saved session when the services cannot be reached, and says so', async () => {
    const double = forge({ nativeSession: () => { throw new TypeError('fetch failed') } }), store = memoryStore('native-desktop-session')
    const service = new EnterpriseService({ fetch: double.fetch, environment, tokenStore: store })
    await expect(service.restoreSession()).resolves.toMatchObject({ status: 'signed-out', message: '暂时连不上企业服务；恢复后重新打开，或重新登录' })
    expect(store.token).toBe('native-desktop-session')
    expect(store.clear).not.toHaveBeenCalled()
  })

  it('keeps the saved session and names the reason when Weave will not admit the account', async () => {
    const double = forge({ exchange: () => Response.json({}, { status: 403 }) }), store = memoryStore('native-desktop-session')
    const service = new EnterpriseService({ fetch: double.fetch, environment, tokenStore: store })
    await expect(service.restoreSession()).resolves.toMatchObject({ status: 'signed-out', message: '当前账号无法进入 Weave' })
    expect(store.token).toBe('native-desktop-session')
  })

  it('answers who is signed in only after the saved session has been checked', async () => {
    let answer!: (response: Response) => void
    const double = forge({ nativeSession: () => new Promise<Response>((resolve) => { answer = resolve }) }), store = memoryStore('native-desktop-session')
    const service = new EnterpriseService({ fetch: double.fetch, environment, tokenStore: store })
    const restoring = service.restoreSession()
    const asked = service.getSession()
    await vi.waitFor(() => expect(double.paths()).toContain('/api/v1/auth/get-session'))
    answer(nativeSession())
    await expect(asked).resolves.toMatchObject({ status: 'signed-in' })
    await restoring
  })

  it('removes the saved session on sign-out, on a new sign-in, and when Forge rejects it mid-use', async () => {
    const double = forge(), store = memoryStore()
    const service = new EnterpriseService({ fetch: double.fetch, environment, tokenStore: store, signInDelay: noWait })
    await service.signIn()
    expect(store.token).toBe('native-desktop-session')

    await service.signOut()
    expect(store.token).toBeUndefined()
    expect(double.calls.at(-1)).toMatchObject({ path: '/api/v1/auth/sign-out', authorization: 'Bearer native-desktop-session' })

    store.token = 'left-by-an-earlier-run'
    const next = forge({ polls: [Response.json({ error: 'access_denied' }, { status: 400 })] })
    const replaced = new EnterpriseService({ fetch: next.fetch, environment, tokenStore: store, signInDelay: noWait })
    await expect(replaced.signIn()).rejects.toThrow('已在浏览器中拒绝这次登录')
    expect(store.token).toBeUndefined()
  })
})

describe('saved session token', () => {
  const directories: string[] = []
  const directory = async () => { const path = await mkdtemp(join(tmpdir(), 'gooeypi-session-token-')); directories.push(path); return path }
  afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

  it('leaves a legacy encrypted session untouched instead of decrypting it at startup', async () => {
    const path = await directory(), legacy = join(path, 'enterprise-session.bin')
    await writeFile(legacy, 'legacy-encrypted-fixture', { mode: 0o600 })
    await expect(createSessionTokenStore(path, FORGE).read()).resolves.toBeUndefined()
    expect(await readFile(legacy, 'utf8')).toBe('legacy-encrypted-fixture')
  })

  it('saves only the native token in a private file and reads it back', async () => {
    const path = await directory(), store = createSessionTokenStore(path, FORGE)
    await expect(store.read()).resolves.toBeUndefined()
    await store.write('native-desktop-session')
    expect(await readdir(path)).toEqual(['enterprise-session.json'])
    const saved = await readFile(join(path, 'enterprise-session.json'))
    expect(JSON.parse(saved.toString('utf8'))).toEqual({ version: 1, origin: FORGE, token: 'native-desktop-session' })
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o700)
    if (process.platform !== 'win32') expect((await stat(join(path, 'enterprise-session.json'))).mode & 0o777).toBe(0o600)
    await expect(createSessionTokenStore(path, FORGE).read()).resolves.toBe('native-desktop-session')
    await store.clear()
    expect(await readdir(path)).toEqual([])
    await expect(store.clear()).resolves.toBeUndefined()
  })

  it('does not follow a session symlink or touch its target', async () => {
    const path = await directory(), other = await directory()
    const target = join(other, 'unrelated.json')
    await writeFile(target, 'unrelated private data')
    await symlink(target, join(path, 'enterprise-session.json'))
    await expect(createSessionTokenStore(path, FORGE).read()).resolves.toBeUndefined()
    expect(await readFile(target, 'utf8')).toBe('unrelated private data')
    expect(await readdir(path)).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('discards a session readable by other users', async () => {
    const path = await directory(), store = createSessionTokenStore(path, FORGE)
    await store.write('native-desktop-session')
    await chmod(join(path, 'enterprise-session.json'), 0o644)
    await expect(store.read()).resolves.toBeUndefined()
    expect(await readdir(path)).toEqual([])
  })

  it('rejects oversized tokens and discards oversized saved files', async () => {
    const path = await directory(), store = createSessionTokenStore(path, FORGE)
    await expect(store.write('x'.repeat(8192))).rejects.toThrow('Invalid session token')
    expect(await readdir(path)).toEqual([])
    await writeFile(join(path, 'enterprise-session.json'), 'x'.repeat(8193), { mode: 0o600 })
    await expect(store.read()).resolves.toBeUndefined()
    expect(await readdir(path)).toEqual([])
  })

  it('discards a token saved for another Forge', async () => {
    const path = await directory()
    await createSessionTokenStore(path, FORGE).write('native-desktop-session')
    await expect(createSessionTokenStore(path, 'https://other-forge.example.test').read()).resolves.toBeUndefined()
    expect(await readdir(path)).toEqual([])
  })

  it('discards a file it cannot read back', async () => {
    const path = await directory(), store = createSessionTokenStore(path, FORGE)
    await writeFile(join(path, 'enterprise-session.json'), 'not what was written')
    await expect(store.read()).resolves.toBeUndefined()
    expect(await readdir(path)).toEqual([])
  })
})
