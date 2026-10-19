// Signs the desktop in without a password: Forge shows the employee a page in
// their browser, and the desktop waits for the session that approval releases.

export const DEVICE_CLIENT_ID = 'xiaoman-desktop'

export interface PendingDeviceSignIn { userCode: string; verificationUri: string; expiresAt: string }

export interface DeviceSignInRequest {
  fetch: typeof fetch
  forgeUrl: URL
  signal: AbortSignal
  /** Throws once this sign-in is no longer the current one. */
  assertCurrent(): void
  /** Shows the employee the code and the page that is waiting for them. */
  onPending(pending: PendingDeviceSignIn): Promise<void>
  openExternal?(url: string): Promise<void>
  delay?(milliseconds: number, signal: AbortSignal): Promise<void>
}

export const CANCELLED_SIGN_IN = '已取消登录'

function text(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value : undefined }
function record(value: unknown): Record<string, unknown> | undefined { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined }

export function waitFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error(CANCELLED_SIGN_IN)); return }
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve() }, milliseconds)
    const cancel = () => { clearTimeout(timer); reject(new Error(CANCELLED_SIGN_IN)) }
    signal.addEventListener('abort', cancel, { once: true })
  })
}

async function post(request: DeviceSignInRequest, path: string, body: Record<string, string>): Promise<Response> {
  try {
    return await request.fetch(new URL(path, request.forgeUrl), {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
    })
  } catch (error) {
    if (request.signal.aborted) throw new Error(CANCELLED_SIGN_IN)
    throw error
  }
}

// A session released in the same moment the employee cancelled belongs to nobody; ask Forge to end it.
function discard(request: DeviceSignInRequest, token: string): void {
  void request.fetch(new URL('/api/v1/auth/sign-out', request.forgeUrl), {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: '{}', redirect: 'error', signal: AbortSignal.timeout(15_000),
  }).then((response) => response.body?.cancel(), () => undefined)
}

/** Runs one device authorization and returns the native session token Forge issued for it. */
export async function deviceSignIn(request: DeviceSignInRequest): Promise<string> {
  const started = await post(request, '/api/v1/auth/device/code', { client_id: DEVICE_CLIENT_ID })
  request.assertCurrent()
  if (!started.ok) {
    const refusal = record(await started.json().catch(() => undefined))
    request.assertCurrent()
    if (started.status === 404) throw new Error('这个 Forge 还没有启用设备登录，请联系管理员')
    if (text(refusal?.error) === 'invalid_client') throw new Error('这个 Forge 不接受从桌面登录，请联系管理员')
    throw new Error('Forge 登录服务暂时不可用')
  }
  const code = record(await started.json().catch(() => undefined))
  request.assertCurrent()
  const deviceCode = text(code?.device_code), userCode = text(code?.user_code)
  const address = text(code?.verification_uri_complete) ?? text(code?.verification_uri)
  if (!deviceCode || !userCode || !address) throw new Error('Forge 返回了无法识别的登录确认信息')
  let page: URL
  try { page = new URL(address) } catch { throw new Error('Forge 返回了无法识别的登录确认信息') }
  // Only this Forge may ask the employee to approve a sign-in to it.
  if (page.origin !== request.forgeUrl.origin) throw new Error('登录确认页不属于当前 Forge，已停止登录')
  const lifetime = typeof code?.expires_in === 'number' && code.expires_in > 0 ? code.expires_in : 600
  let interval = typeof code?.interval === 'number' && code.interval >= 0 ? code.interval : 5
  const deadline = Date.now() + lifetime * 1000
  await request.onPending({ userCode, verificationUri: page.toString(), expiresAt: new Date(deadline).toISOString() })
  request.assertCurrent()
  // The page can be opened again from the sign-in screen if the browser did not come up.
  await request.openExternal?.(page.toString()).catch(() => undefined)

  const delay = request.delay ?? waitFor
  for (;;) {
    await delay(interval * 1000, request.signal)
    request.assertCurrent()
    if (request.signal.aborted) throw new Error(CANCELLED_SIGN_IN)
    if (Date.now() >= deadline) throw new Error('登录确认已过期，请重新登录')
    const polled = await post(request, '/api/v1/auth/device/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode, client_id: DEVICE_CLIENT_ID })
    const answer = record(await polled.json().catch(() => undefined))
    const token = polled.ok ? text(answer?.access_token) : undefined
    if (request.signal.aborted) {
      if (token) discard(request, token)
      throw new Error(CANCELLED_SIGN_IN)
    }
    request.assertCurrent()
    if (polled.ok) {
      if (!token) throw new Error('Forge 返回了无法识别的登录结果')
      return token
    }
    const reason = text(answer?.error) ?? text(record(answer?.error)?.code) ?? ''
    if (reason === 'authorization_pending') continue
    if (reason === 'slow_down' || polled.status === 429) { interval += 5; continue }
    if (reason === 'access_denied') throw new Error('已在浏览器中拒绝这次登录')
    if (reason === 'expired_token') throw new Error('登录确认已过期，请重新登录')
    throw new Error('Forge 登录服务暂时不可用')
  }
}
