import { EnterpriseService } from '../../electron/main/enterprise'

type ServiceOptions = NonNullable<ConstructorParameters<typeof EnterpriseService>[0]>
type Account = { token: string; user: unknown; session?: Record<string, unknown> }

/**
 * Where a test's fetch double says which Forge account approves the desktop in
 * the browser. It answers with what Forge holds for that account —
 * `{ token, user, session? }` — or refuses, which reads as a denied approval.
 */
export const APPROVING_ACCOUNT_PATH = '/__test/approving-account'

const approvers = new WeakMap<EnterpriseService, { email: string }>()

// Plays Forge's side of a device sign-in around a test's own fetch double, so a
// test only states who approves; the exchange itself is covered in
// device-sign-in.test.ts against the real routes.
function browserApproval(inner: typeof fetch, approver: { email: string }): typeof fetch {
  const accounts = new Map<string, Account>()
  let flows = 0
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.pathname === '/api/v1/auth/device/code') {
      flows += 1
      const page = `${url.origin}/_console/auth/device`
      return Response.json({ device_code: `device-code-${flows}`, user_code: 'WXYZ2345', verification_uri: page, verification_uri_complete: `${page}?user_code=WXYZ2345`, expires_in: 1800, interval: 5 })
    }
    if (url.pathname === '/api/v1/auth/device/token') {
      const answer = await inner(new URL(APPROVING_ACCOUNT_PATH, url.origin), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: approver.email }), signal: init?.signal,
      })
      if (!answer.ok) return Response.json({ error: 'access_denied' }, { status: 400 })
      const account = await answer.json() as Account
      accounts.set(account.token, account)
      return Response.json({ access_token: account.token, token_type: 'Bearer', expires_in: 14 * 24 * 60 * 60 })
    }
    if (url.pathname === '/api/v1/auth/get-session') {
      const account = accounts.get(new Headers(init?.headers).get('Authorization')?.replace(/^Bearer /, '') ?? '')
      if (account) {
        return Response.json({ user: account.user, session: {
          activeOrganizationId: 'forge-org', expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(), ...account.session,
        } })
      }
    }
    return inner(input, init)
  }) as typeof fetch
}

/** A service whose Forge runs the browser approval around the test's own fetch double. */
export function newEnterpriseService(options: ServiceOptions = {}): EnterpriseService {
  const approver = { email: 'employee@example.test' }
  const service = new EnterpriseService({
    signInDelay: async () => undefined,
    ...options,
    ...(options.fetch ? { fetch: browserApproval(options.fetch, approver) } : {}),
  })
  approvers.set(service, approver)
  return service
}

/** Signs the desktop in with `email` approving it in the browser. */
export function signInAs(service: EnterpriseService, email: string) {
  const approver = approvers.get(service)
  if (approver) approver.email = email
  return service.signIn()
}
