import { delegationResponse, fixedSource } from './task-delegation-fixture'
import type { ForgeTaskScope } from '../../electron/main/enterprise/task-handoff'
import { createHash } from 'node:crypto'
import { freezeMaterials, makeFrozenTextMaterial } from '../../electron/main/enterprise/materials'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { approvalContextView, WorkRegistrationRejectedError } from '../../electron/main/enterprise'
import { newEnterpriseService, signInAs } from '../helpers/browser-sign-in'
import type { BusinessRecordRead } from '../../electron/main/enterprise/business-records'
import { digest } from '../../electron/main/enterprise/handoff-store'
import { employeeBusinessRequestDigest } from '../../electron/main/enterprise/employee-business-contract'
import type { EmployeeBusinessRequest } from '../../src/types/employee-business'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

afterEach(() => { vi.unstubAllGlobals() })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function workOverviewFetch(route: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined) {
  return vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/__test/approving-account')) {
      const { email } = JSON.parse(String(init?.body)) as { email: string }
      return Response.json({ token: `forge-token-${email}`, user: { id: email, email, name: email }, session: { activeOrganizationId: 'forge-org' } })
    }
    if (url.endsWith('/v1/auth/external/exchange')) {
      const email = new Headers(init?.headers).get('Authorization')?.replace('Bearer forge-token-', '') ?? 'unknown'
      return Response.json({ token: `weave-token-${email}`, subject: { id: `weave-${email}`, externalId: email, email, name: email }, organization: { id: 'default' }, issuer: 'forge:test-deployment', permissions: ['teams:use'] })
    }
    const routed = await route(url, init)
    if (routed) return routed
    if (url.endsWith('/v1/workbench/dispatch-inputs/prepare')) return Response.json({ input_revision_id: (JSON.parse(String(init?.body)) as { registration_id: string }).registration_id })
    if (url.endsWith('/api/v1/apps/forge/task-delegations')) {
      const body = JSON.parse(String(init?.body)) as { scope: ForgeTaskScope }
      return Response.json(delegationResponse(body.scope, new Headers(init?.headers).get('Authorization')!.replace('Bearer forge-token-', '')))
    }
    return Response.json({}, { status: 404 })
  }) as typeof fetch
}

function legacyNativeTools(id: unknown): Response {
  return Response.json({ jsonrpc: '2.0', id, result: { tools: [{ name: 'run_action', inputSchema: {
    type: 'object', properties: { actionName: { type: 'string' }, objectName: { type: 'string' }, recordId: { type: 'string' }, params: { type: 'object' } },
    required: ['actionName', 'objectName'], additionalProperties: false,
  } }] } })
}

function notificationResponse(value: { success?: boolean; notifications?: unknown[]; data?: { notifications?: unknown[] } }, init?: ResponseInit): Response {
  return Response.json({ version: '1', notifications: value.notifications ?? value.data?.notifications ?? [], next_cursor: null, has_more: false }, init)
}

function runLookup(source: { workReference: string; runReference: string; sessionReference: string },
  businessResult: 'completed' | 'needs_input' | 'action_failed' | 'action_unknown' | undefined = 'needs_input', isCurrent = true, status = 'succeeded') {
  return { runId: source.runReference, inputRevisionId: source.workReference, workbenchSessionId: source.sessionReference, status,
    isCurrent, ...(businessResult ? { businessResult } : {}), actionCounts: { succeeded: businessResult === 'completed' ? 1 : 0, failed: 0, unknown: 0 } }
}

describe('EnterpriseService', () => {
  it('keeps a fourteen-day server session through day thirteen and expires on day fourteen', async () => {
    const started = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(started)
    const baseFetch = workOverviewFetch(() => undefined)
    const fetchWithLifetime: typeof fetch = async (input, init) => {
      const response = await baseFetch(input, init)
      return String(input).endsWith('/v1/auth/external/exchange')
        ? Response.json({ ...await response.json(), expiresIn: 1209600 }) : response
    }
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchWithLifetime })
    try {
      await signInAs(service, 'member@example.test')
      clock.mockReturnValue(started + 13 * 24 * 60 * 60 * 1000)
      expect((await service.getSession()).status).toBe('signed-in')
      clock.mockReturnValue(started + 14 * 24 * 60 * 60 * 1000)
      expect((await service.getSession()).status).toBe('signed-out')
    } finally { clock.mockRestore() }
  })

  it('uses the employee session for current context, execution and operation lookup without creating a team grant', async () => {
    const calls: string[] = []
    const record = { objectName: 'forge_sales_contract', recordId: 'contract-1', label: '合同' }
    const context = { version: '1', contextId: '10000000-0000-4000-8000-000000000001', contextVersion: 'a'.repeat(64), recordVersion: '1', expiresAt: new Date(Date.now() + 60_000).toISOString(), readOnly: true, record, source: { kind: 'record' as const }, actions: [] }
    const request: EmployeeBusinessRequest = { version: '1', contextId: context.contextId, contextVersion: context.contextVersion, opKey: '20000000-0000-4000-8000-000000000002', employeeMessage: { sessionId: 'session', messageId: 'message', sha256: 'b'.repeat(64) }, action_ref: 1, values: {} }
    const operation = { version: '1', operationId: request.opKey, contextId: context.contextId, requestDigest: employeeBusinessRequestDigest(request), status: 'succeeded', repeated: false, updatedAt: new Date().toISOString() }
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: workOverviewFetch((url, init) => {
      calls.push(url)
      if (!url.includes('/business-actions/')) return undefined
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer forge-token-employee@example.test')
      if (url.includes('/context?')) { expect(url).toContain('objectName=forge_sales_contract&recordId=contract-1&sourceKind=record'); return Response.json(context) }
      if (url.endsWith('/execute')) { expect(JSON.parse(String(init?.body))).toEqual(request); return Response.json(operation) }
      if (url.endsWith(`/operations/${request.opKey}`)) { expect(init?.method).toBeUndefined(); return Response.json(operation) }
      return undefined
    }) })
    await signInAs(service, 'employee@example.test')
    expect(await service.getEmployeeBusinessContext({ record, source: { kind: 'record' } })).toEqual(context)
    expect(await service.executeEmployeeBusinessAction(request)).toEqual(operation)
    expect(await service.getEmployeeBusinessOperation(request.opKey)).toEqual(operation)
    expect(calls.some((url) => url.includes('/task-delegations') || url.includes('/dispatch-inputs'))).toBe(false)
  })
  it('binds Weave to the account that approved the desktop and keeps nothing without a token store', async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input)
      if (url === 'http://forge.example.test/__test/approving-account') {
        expect(JSON.parse(String(init?.body))).toEqual({ email: 'developer@example.test' })
        return Response.json({ token: 'forge-secret-token', user: { id: 'forge-1', email: 'developer@example.test', name: 'Developer' } })
      }
      if (url === 'http://weave.example.test/v1/auth/external/exchange') {
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer forge-secret-token')
        return Response.json({ token: 'weave-secret-token', subject: { id: 'weave-1', externalId: 'forge-1', email: 'developer@example.test', name: 'Developer' }, organization: { id: 'default' }, issuer: 'forge:test-deployment', permissions: ['teams:use', 'teams:develop'] })
      }
      return Response.json({}, { status: 404 })
    }) as typeof fetch
    const service = newEnterpriseService({
      environment: { WORKBENCH_FORGE_URL: 'http://forge.example.test', WORKBENCH_WEAVE_URL: 'http://weave.example.test' }, fetch: fetchMock,
    })
    const scopeChanges: Array<{ status: string; generation: number; phase: string }> = []
    service.setSessionScopeChangeHandler(async (changed, generation, phase) => { scopeChanges.push({ status: changed.status, generation, phase }) })

    const session = await signInAs(service, 'developer@example.test')
    expect(session).toMatchObject({ status: 'signed-in', storage: 'session-only', user: { id: 'forge-1', email: 'developer@example.test' }, organization: { id: 'default' }, identitySource: { kind: 'forge-account', issuer: 'forge:test-deployment' }, permissions: ['teams:use', 'teams:develop'] })
    expect(JSON.stringify(session)).not.toContain('secret-token')
    expect(service.accountKeyForSession(session)).toBe(await service.accountKey())
    // The middle change carries the confirmation code while the browser approval is awaited.
    expect(scopeChanges.map(({ status, phase }) => [status, phase])).toEqual([['signed-out', 'sign-in-start'], ['signed-out', 'signed-out'], ['signed-in', 'signed-in']])
    expect(new Set(scopeChanges.map(({ generation }) => generation)).size).toBe(1)
    const activeGeneration = scopeChanges[2]?.generation
    expect(activeGeneration).toBeDefined()
    expect(service.isSessionGenerationCurrent(activeGeneration ?? -1)).toBe(true)
    expect((await service.authorizationHeaders()).get('Authorization')).toBe('Bearer weave-secret-token')
    await expect(service.signOut()).resolves.toMatchObject({ status: 'signed-out' })
    expect(scopeChanges.at(-1)).toMatchObject({ status: 'signed-out', phase: 'signed-out' })
    await expect(service.authorizationHeaders()).rejects.toThrow('请先登录')
  })

  it('invokes only the generic Forge MCP run_action tool and preserves the native receipt', async () => {
    const args = {
      actionName: 'action_from_current_item_metadata', objectName: 'forge_case_record', recordId: 'record-current',
      params: { approvalRequestId: 'request-current', itemVersion: 'item-version-current', sourceMaterialVersion: 'a'.repeat(64), comment: '员工本轮意见' },
    }
    const receipt = {
      decision: 'approve', status: 'pending', requestId: 'request-current', recordId: 'record-current',
      itemVersion: 'item-version-current', sourceMaterialVersion: 'a'.repeat(64),
      resumed: false, autoRejected: false, alreadyApplied: false,
    }
    const calls: Array<{ url: string; authorization?: string; body?: Record<string, unknown> }> = []
    const fetchMock = workOverviewFetch((url, init) => {
      if (url === 'http://forge/api/v1/mcp') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        calls.push({ url, authorization: new Headers(init?.headers).get('Authorization') ?? undefined, body })
        if (body.method === 'tools/list') return legacyNativeTools(body.id)
        return Response.json({ jsonrpc: '2.0', id: body.id, result: { structuredContent: receipt } })
      }
      return undefined
    })
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
    await signInAs(service, 'reviewer@example.test')
    const currentAssertions = vi.fn(async () => undefined)

    await expect(service.runNativeMcpAction(args, currentAssertions, false, async () => undefined)).resolves.toEqual({ status: 'returned', result: receipt })
    expect(currentAssertions).toHaveBeenCalledTimes(3)
    expect(calls.filter(call => call.body?.method === 'tools/call')).toEqual([{
      url: 'http://forge/api/v1/mcp', authorization: 'Bearer forge-token-reviewer@example.test',
      body: expect.objectContaining({ method: 'tools/call', params: { name: 'run_action', arguments: args } }),
    }])
  })

  it('keeps ambiguous MCP errors unknown and preserves explicit native rejection codes', async () => {
    const responses = [
      Response.json({ jsonrpc: '2.0', id: 'action-1', result: { isError: true, structuredContent: { code: 'APPROVAL_ACTION_IN_DOUBT' } } }),
      Response.json({ jsonrpc: '2.0', id: 'action-2', result: { isError: true, structuredContent: { code: 'APPROVAL_ACTION_STALE' } } }),
    ]
    const fetchMock = workOverviewFetch((url, init) => {
      if (url !== 'http://forge/api/v1/mcp') return undefined
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return body.method === 'tools/list' ? legacyNativeTools(body.id) : responses.shift()
    })
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
    await signInAs(service, 'reviewer@example.test')
    const args = { actionName: 'metadata_action', objectName: 'forge_case_record', recordId: 'record-1', params: { approvalRequestId: 'request-1', itemVersion: 'round-1', sourceMaterialVersion: 'b'.repeat(64), comment: '意见' } }
    const assertCurrent = async () => undefined

    await expect(service.runNativeMcpAction(args, assertCurrent, false, async () => undefined)).resolves.toMatchObject({ status: 'unknown', code: 'APPROVAL_ACTION_IN_DOUBT' })
    await expect(service.runNativeMcpAction(args, assertCurrent, false, async () => undefined)).resolves.toMatchObject({ status: 'rejected', code: 'APPROVAL_ACTION_STALE' })
  })

  it('reads native approval action history through the existing request route', async () => {
    const actions = [{ id: 'history-1', request_id: 'request-current', action: 'approve', actor_id: 'reviewer', comment: '当前意见', created_at: '2026-09-30T08:00:00Z' }]
    const calls: Array<{ url: string; authorization?: string }> = []
    const fetchMock = workOverviewFetch((url, init) => {
      if (url.endsWith('/api/v1/approvals/requests/request-current/actions')) {
        calls.push({ url, authorization: new Headers(init?.headers).get('Authorization') ?? undefined })
        return Response.json({ data: actions })
      }
      return undefined
    })
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
    await signInAs(service, 'reviewer@example.test')

    await expect(service.getApprovalActionHistory('request-current')).resolves.toEqual(actions)
    expect(calls).toEqual([{ url: 'http://forge/api/v1/approvals/requests/request-current/actions', authorization: 'Bearer forge-token-reviewer@example.test' }])
  })

  it.each([401, 403])('separates Forge item denial from session invalidation for HTTP %i', async (status) => {
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: workOverviewFetch((url) => {
      if (url.endsWith('/api/v1/approvals/requests/denied/actions')) return Response.json({}, { status })
      if (url.endsWith('/v1/teams?status=active')) return Response.json([])
      return undefined
    }) })
    await signInAs(service, 'employee@example.test')
    await expect(service.getApprovalActionHistory('denied')).rejects.toThrow(status === 401 ? '登录已失效' : '当前账号没有读取审批动作历史的权限')
    expect((await service.getSession()).status).toBe(status === 401 ? 'signed-out' : 'signed-in')
    if (status === 403) await expect(service.getTeamCatalog()).resolves.toEqual([])
  })

  it('keeps concurrent allowed reads and the employee session when another Forge or Weave item is forbidden', async () => {
    const denied = deferred<Response>(), allowed = deferred<Response>()
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: workOverviewFetch((url) => {
      if (url.endsWith('/api/v1/approvals/requests/denied/actions')) return denied.promise
      if (url.endsWith('/api/v1/approvals/requests/allowed/actions')) return allowed.promise
      if (url.endsWith('/v1/teams?status=active')) return Response.json({}, { status: 403 })
      return undefined
    }) })
    await signInAs(service, 'employee@example.test')
    const deniedRead = service.getApprovalActionHistory('denied'), allowedRead = service.getApprovalActionHistory('allowed')
    const expectedDenial = expect(deniedRead).rejects.toThrow('当前账号没有读取审批动作历史的权限')
    denied.resolve(Response.json({}, { status: 403 })); await expectedDenial
    allowed.resolve(Response.json({ data: [{ action: 'approve', comment: '本人可读意见' }] }))
    await expect(allowedRead).resolves.toEqual([{ action: 'approve', comment: '本人可读意见' }])
    await expect(service.getTeamCatalog()).rejects.toThrow('当前账号没有读取该团队信息的权限')
    expect((await service.getSession()).status).toBe('signed-in')
    expect((await service.authorizationHeaders()).get('Authorization')).toBe('Bearer weave-token-employee@example.test')
  })

  it.each(['forge', 'weave'])('discards delayed %s 403 after an account switch without touching the replacement session', async (provider) => {
    const old = deferred<Response>(), started = deferred<void>()
    const fetchMock = workOverviewFetch((url, init) => {
      const token = new Headers(init?.headers).get('Authorization')
      const endpoint = provider === 'forge' ? '/api/v1/approvals/requests/request/actions' : '/v1/teams?status=active'
      if (url.endsWith(endpoint) && token?.endsWith('-alice@example.test')) { started.resolve(); return old.promise }
      if (url.endsWith(endpoint)) return Response.json(provider === 'forge' ? { data: [] } : [])
      return undefined
    })
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
    await signInAs(service, 'alice@example.test')
    const read = provider === 'forge' ? () => service.getApprovalActionHistory('request') : () => service.getTeamCatalog()
    const previous = read(), rejected = expect(previous).rejects.toThrow('账号已切换')
    await started.promise; await signInAs(service, 'bob@example.test')
    old.resolve(Response.json({}, { status: 403 })); await rejected
    expect((await service.getSession()).user?.email).toBe('bob@example.test')
    await expect(read()).resolves.toEqual([])
  })

  it.each([200, 401, 503])('revokes the old Forge native session on active sign-out, keeping HTTP %i honest', async (status) => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: workOverviewFetch((url, init) => {
      if (url.endsWith('/api/v1/auth/sign-out')) { requests.push({ url, init }); return Response.json({}, { status }) }
      return undefined
    }) })
    await signInAs(service, 'employee@example.test')
    const result = await service.signOut()
    expect(result.status).toBe('signed-out')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.init?.method).toBe('POST')
    expect(requests[0]?.init?.body).toBe('{}')
    expect(new Headers(requests[0]?.init?.headers).get('Authorization')).toBe('Bearer forge-token-employee@example.test')
    if (status === 503) expect(result.message).toContain('远端会话吊销尚未确认')
    else expect(result.message).toBeUndefined()
    expect((await service.getSession()).status).toBe('signed-out')
  })

  it('clears locally on sign-out network failure and never reports remote revocation as confirmed', async () => {
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: workOverviewFetch((url) => {
      if (url.endsWith('/api/v1/auth/sign-out')) throw new Error('network disconnected')
      return undefined
    }) })
    await signInAs(service, 'employee@example.test')
    expect(await service.signOut()).toMatchObject({ status: 'signed-out', message: expect.stringContaining('吊销尚未确认') })
    await expect(service.authorizationHeaders()).rejects.toThrow('请先登录')
  })

  it('does not send native logout for a 401 read and does not let a delayed logout replace a new login', async () => {
    const waiting = deferred<Response>(), started = deferred<void>()
    let signouts = 0
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: workOverviewFetch((url) => {
      if (url.endsWith('/api/v1/approvals/requests/expired/actions')) return Response.json({}, { status: 401 })
      if (url.endsWith('/api/v1/auth/sign-out')) { signouts++; started.resolve(); return waiting.promise }
      return undefined
    }) })
    await signInAs(service, 'alice@example.test')
    await expect(service.getApprovalActionHistory('expired')).rejects.toThrow('登录已失效')
    expect(signouts).toBe(0)
    await signInAs(service, 'alice@example.test')
    const logout = service.signOut(); await started.promise
    expect((await service.getSession()).status).toBe('signed-out')
    await signInAs(service, 'bob@example.test')
    waiting.resolve(Response.json({}, { status: 503 }))
    expect(await logout).toMatchObject({ status: 'signed-in', user: { email: 'bob@example.test' } })
    expect((await service.getSession()).user?.email).toBe('bob@example.test')
    expect((await service.authorizationHeaders()).get('Authorization')).toBe('Bearer weave-token-bob@example.test')
  })

  it('discards an old account 401 without signing out the account that replaced it', async () => {
    const oldUnauthorized = deferred<Response>(), oldSuccess = deferred<Response>()
    const unauthorizedStarted = deferred<void>(), successStarted = deferred<void>()
    let oldReadCount = 0
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/__test/approving-account')) {
        const email = (JSON.parse(String(init?.body)) as { email: string }).email
        return Response.json({ token: `forge-token-${email}`, user: { id: email, email, name: email } })
      }
      if (url.endsWith('/v1/auth/external/exchange')) {
        const email = new Headers(init?.headers).get('Authorization')?.replace('Bearer forge-token-', '') ?? 'unknown'
        return Response.json({ token: `weave-token-${email}`, subject: { id: `weave-${email}`, externalId: email, email, name: email }, organization: { id: 'default' }, issuer: 'forge:test-deployment', permissions: ['teams:use'] })
      }
      if (url.endsWith('/v1/teams?status=active') && new Headers(init?.headers).get('Authorization') === 'Bearer weave-token-a@example.test') {
        oldReadCount++
        if (oldReadCount === 1) { unauthorizedStarted.resolve(); return oldUnauthorized.promise }
        successStarted.resolve()
        return oldSuccess.promise
      }
      if (url.endsWith('/v1/teams?status=active')) return Response.json({ teams: [] })
      return Response.json({}, { status: 404 })
    }) as typeof fetch
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge.example.test', WORKBENCH_WEAVE_URL: 'http://weave.example.test' }, fetch: fetchMock })
    await signInAs(service, 'a@example.test')
    const previousUnauthorizedRead = service.getTeamCatalog()
    const previousSuccessfulRead = service.getTeamCatalog()
    await Promise.all([unauthorizedStarted.promise, successStarted.promise])
    await signInAs(service, 'b@example.test')
    oldUnauthorized.resolve(Response.json({}, { status: 401 }))
    oldSuccess.resolve(Response.json({ teams: [{ id: 'team-a', name: 'A', objective: 'A', status: 'active' }] }))

    await expect(previousUnauthorizedRead).rejects.toThrow('账号已切换')
    await expect(previousSuccessfulRead).rejects.toThrow('账号已切换')
    await expect(service.getSession()).resolves.toMatchObject({ status: 'signed-in', user: { id: 'b@example.test' } })
    expect((await service.authorizationHeaders()).get('Authorization')).toBe('Bearer weave-token-b@example.test')
  })

  it('does not let a delayed earlier sign-in overwrite the account that logged in later', async () => {
    const delayedExchange = deferred<Response>(), started = deferred<void>()
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/__test/approving-account')) {
        const email = (JSON.parse(String(init?.body)) as { email: string }).email
        return Response.json({ token: `forge-token-${email}`, user: { id: email, email, name: email } })
      }
      if (url.endsWith('/v1/auth/external/exchange')) {
        const email = new Headers(init?.headers).get('Authorization')?.replace('Bearer forge-token-', '') ?? 'unknown'
        if (email === 'a@example.test') { started.resolve(); return delayedExchange.promise }
        return Response.json({ token: `weave-token-${email}`, subject: { id: `weave-${email}`, externalId: email, email, name: email }, organization: { id: 'default' }, issuer: 'forge:test-deployment', permissions: ['teams:use'] })
      }
      return Response.json({}, { status: 404 })
    }) as typeof fetch
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge.example.test', WORKBENCH_WEAVE_URL: 'http://weave.example.test' }, fetch: fetchMock })
    const earlierLogin = signInAs(service, 'a@example.test')
    await started.promise
    await signInAs(service, 'b@example.test')
    delayedExchange.resolve(Response.json({ token: 'weave-token-a@example.test', subject: { id: 'weave-a', externalId: 'a@example.test', email: 'a@example.test', name: 'A' }, organization: { id: 'default' }, issuer: 'forge:test-deployment', permissions: ['teams:use'] }))

    await expect(earlierLogin).rejects.toThrow('账号已切换')
    await expect(service.getSession()).resolves.toMatchObject({ status: 'signed-in', user: { id: 'b@example.test' } })
    expect((await service.authorizationHeaders()).get('Authorization')).toBe('Bearer weave-token-b@example.test')
  })

  it('does not keep a partial session when the approval is denied in the browser', async () => {
    const service = newEnterpriseService({
      environment: { WORKBENCH_FORGE_URL: 'http://forge.example.test', WORKBENCH_WEAVE_URL: 'http://weave.example.test' },
      fetch: (async () => Response.json({}, { status: 401 })) as typeof fetch,
    })
    await expect(signInAs(service, 'member@example.test')).rejects.toThrow('已在浏览器中拒绝这次登录')
    await expect(service.getSession()).resolves.toMatchObject({ status: 'signed-out' })
  })

  it('keeps tokens in memory without a token store and leaves legacy encrypted session files untouched', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gooeypi-enterprise-session-only-'))
    const sessionPath = join(directory, 'enterprise-session.json')
    const legacyContents = JSON.stringify({
      version: 3,
      expiresAt: Date.now() + 60 * 60 * 1000,
      weaveToken: 'legacy-encrypted-weave-token',
      forgeToken: 'legacy-encrypted-forge-token',
      session: { version: '1', status: 'signed-in', permissions: ['teams:use'] },
    })
    await writeFile(sessionPath, legacyContents, { encoding: 'utf8', mode: 0o600 })
    const codec = {
      available: vi.fn(() => true),
      encrypt: vi.fn(() => { throw new Error('legacy session encryption must not be used') }),
      decrypt: vi.fn(() => { throw new Error('legacy session decryption must not be used') }),
    }
    const fetcher = (async (input: URL | RequestInfo) => String(input).includes('approving-account')
      ? Response.json({ token: 'forge-secret', user: { id: 'forge-1', email: 'member@example.test', name: 'Member' }, session: { activeOrganizationId: 'forge-org' } })
      : Response.json({ token: 'weave-secret', expiresIn: 3600, subject: { id: 'weave-1', externalId: 'forge-1', email: 'member@example.test', name: 'Member' }, organization: { id: 'default' }, issuer: 'forge:test-deployment', permissions: ['teams:use'] })) as typeof fetch
    const legacyOptions = Object.assign(
      { environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetcher },
      { sessionPath, sessionCodec: codec },
    )
    try {
      const service = newEnterpriseService(legacyOptions)
      const session = await signInAs(service, 'member@example.test')
      expect(session).toMatchObject({ status: 'signed-in', storage: 'session-only', user: { id: 'forge-1' } })
      expect(JSON.stringify(session)).not.toContain('secret')
      expect((await service.authorizationHeaders()).get('Authorization')).toBe('Bearer weave-secret')

      await service.signOut()
      const reopened = newEnterpriseService(legacyOptions)
      await expect(reopened.getSession()).resolves.toMatchObject({ status: 'signed-out' })
      await expect(reopened.authorizationHeaders()).rejects.toThrow('请先登录')
      expect(codec.available).not.toHaveBeenCalled()
      expect(codec.encrypt).not.toHaveBeenCalled()
      expect(codec.decrypt).not.toHaveBeenCalled()
      expect(await readFile(sessionPath, 'utf8')).toBe(legacyContents)
      expect(await readdir(directory)).toEqual(['enterprise-session.json'])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('filters employee-only actions from the canonical developer catalog', async () => {
    const capabilities = [
      { id: 'forge:action:sales_contract.ContractSubmit', name: '提交销售合同', description: '提交合同', effect: 'write', executionMode: 'team_delegable', resourceType: 'sales_contract', status: 'available', params: [{ name: 'attachments', type: 'file', multiple: true }] },
      { id: 'forge:action:sales_contract.RegisterSignature', name: '登记签署', description: '本人登记', effect: 'write', executionMode: 'employee_only', resourceType: 'sales_contract', status: 'available' },
    ]
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/__test/approving-account')) return Response.json({ token: 'forge-token', user: { id: 'forge-1', email: 'developer@example.test' } })
      if (url.endsWith('/v1/auth/external/exchange')) return Response.json({ token: 'weave-token', subject: { id: 'weave-1', externalId: 'forge-1' }, organization: { id: 'default' }, issuer: 'forge:test-deployment', permissions: ['teams:use', 'teams:develop'] })
      if (url.endsWith('/api/v1/workbench/business-actions/catalog')) {
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer forge-token')
        return Response.json({ version: '1', provider: { id: 'forge', name: 'Forge', status: 'available' }, capabilities, refreshedAt: new Date().toISOString() })
      }
      return Response.json({}, { status: 404 })
    }) as typeof fetch
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
    await signInAs(service, 'developer@example.test')
    expect((await service.getBusinessCapabilityCatalog()).capabilities).toEqual([capabilities[0]])
  })

  it('fails closed when employee action metadata contains unsupported array or object parameters', async () => {
    const actions = [
      { name: 'UpdateQuoteLines', objectName: 'forge_quote', label: '调整报价明细', description: '按要求调整报价明细', params: [{ name: 'lines', type: 'array', required: true }] },
      { name: 'UpdateQuoteObject', objectName: 'forge_quote', label: '更新报价结构', description: '按要求更新报价结构', params: [{ name: 'value', type: 'string', required: true }] },
      { name: 'ReadQuote', objectName: 'forge_quote', label: '读取报价', description: '读取报价', params: [{ name: 'quote_id', type: 'string', required: true }] },
    ]
    const metadata = {
      type: 'object', name: 'forge_quote', sortability: {},
      item: { name: 'forge_quote', fields: {}, actions: [
        { name: 'UpdateQuoteLines', params: [{ name: 'lines', type: 'multiselect', multiple: true, required: true }] },
        { name: 'UpdateQuoteObject', params: [{ name: 'value', type: 'object', required: true }] },
        { name: 'ReadQuote', params: [{ name: 'quote_id', type: 'text', required: true }] },
      ] },
    }
    const fetchMock = workOverviewFetch((url) => {
      if (url.endsWith('/api/v1/workbench/business-actions/catalog')) return Response.json({ version: '1', provider: { id: 'forge', name: 'Forge', status: 'available' }, capabilities: actions.map((a) => ({ id: `forge:action:${a.objectName}.${a.name}`, name: a.name, description: a.name, resourceType: a.objectName, status: 'available', effect: 'write', executionMode: 'team_delegable' })), refreshedAt: new Date().toISOString() })
      if (url.endsWith('/api/v1/mcp')) return Response.json({ jsonrpc: '2.0', id: 'business-capability-catalog', result: { content: [{ type: 'text', text: JSON.stringify({ actions }) }] } })
      if (url.endsWith('/api/v1/meta/objects/forge_quote')) return Response.json(metadata)
      return undefined
    })
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
    await signInAs(service, 'employee@example.test')

    await expect(service.getBusinessCapabilities([
      'forge:action:forge_quote.UpdateQuoteLines',
      'forge:action:forge_quote.UpdateQuoteObject',
      'forge:action:forge_quote.ReadQuote',
    ])).rejects.toThrow('参数暂不可安全绑定')
  })

  it('restores file cardinality and objectOverride types only for employee-visible actions', async () => {
    const actions = [
      { name: 'contract_submit_material_package', objectName: 'forge_sales_contract', description: '提交材料集合', requiresRecord: true, params: [
        { name: 'primary_file_id', type: 'string', required: true },
        { name: 'material_file_ids', type: 'string', required: true },
      ] },
      { name: 'sales_lead_convert_to_opportunity', objectName: 'forge_sales_lead', description: '转为商机', requiresRecord: true, params: [
        { name: 'amount', type: 'string', required: false },
        { name: 'expected_close_on', type: 'string', required: false },
        { name: 'account_ref', type: 'string', required: false },
      ] },
      { name: 'unselected_contract_action', objectName: 'forge_sales_contract', description: '未选择动作', requiresRecord: true, params: [{ name: 'id', type: 'string', required: true }] },
    ]
    const objectMetadata = (name: string, objectActions: unknown[], fields: Record<string, unknown> = {}) => ({
      type: 'object', name, sortability: {}, item: { name, actions: objectActions, fields },
    })
    const calls: Array<{ url: string; method?: string; auth?: string }> = []
    const fetchMock = workOverviewFetch((url, init) => {
      calls.push({ url, method: init?.method, auth: new Headers(init?.headers).get('Authorization') ?? undefined })
      if (url.endsWith('/api/v1/workbench/business-actions/catalog')) return Response.json({ version: '1', provider: { id: 'forge', name: 'Forge', status: 'available' }, capabilities: actions.map((a) => ({ id: `forge:action:${a.objectName}.${a.name}`, name: a.name, description: a.name, resourceType: a.objectName, status: 'available', effect: 'write', executionMode: 'team_delegable' })), refreshedAt: new Date().toISOString() })
      if (url.endsWith('/api/v1/mcp')) return Response.json({ jsonrpc: '2.0', id: 'business-capability-catalog', result: { content: [{ type: 'text', text: JSON.stringify({ actions }) }] } })
      if (url.endsWith('/api/v1/meta/objects/forge_sales_contract')) return Response.json(objectMetadata('forge_sales_contract', [
        { name: 'contract_submit_material_package', params: [
          { name: 'primary_file_id', type: 'file', multiple: false, required: true },
          { name: 'material_file_ids', type: 'file', multiple: true, required: true },
        ] },
        { name: 'unselected_contract_action', params: [{ name: 'id', type: 'text', required: true }] },
      ]))
      if (url.endsWith('/api/v1/meta/objects/forge_sales_lead')) return Response.json(objectMetadata('forge_sales_lead', [
        { name: 'sales_lead_convert_to_opportunity', params: [
          { field: 'amount', objectOverride: 'forge_sales_opportunity', required: false },
          { field: 'expected_close_on', objectOverride: 'forge_sales_opportunity', required: false },
          { name: 'account_ref', type: 'reference', required: false },
        ] },
      ]))
      if (url.endsWith('/api/v1/meta/objects/forge_sales_opportunity')) return Response.json(objectMetadata('forge_sales_opportunity', [], {
        amount: { type: 'currency' }, expected_close_on: { type: 'date' },
      }))
      return undefined
    })
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
    await signInAs(service, 'employee@example.test')

    const catalog = await service.getBusinessCapabilities([
      'forge:action:forge_sales_contract.contract_submit_material_package',
      'forge:action:forge_sales_lead.sales_lead_convert_to_opportunity',
    ])
    expect(catalog).toMatchObject([
      { id: 'forge:action:forge_sales_contract.contract_submit_material_package', params: [
        { name: 'primary_file_id', type: 'file', multiple: false, required: true },
        { name: 'material_file_ids', type: 'file', multiple: true, required: true },
      ] },
      { id: 'forge:action:forge_sales_lead.sales_lead_convert_to_opportunity', params: [
        { name: 'amount', type: 'number', required: false },
        { name: 'expected_close_on', type: 'string', required: false },
        { name: 'account_ref', type: 'string', required: false },
      ] },
    ])
    expect(catalog.map((action) => action.id)).not.toContain('forge:action:forge_sales_contract.unselected_contract_action')
    expect(calls.filter((call) => call.url.includes('/api/v1/meta/objects/'))).toEqual([
      expect.objectContaining({ url: 'http://forge/api/v1/meta/objects/forge_sales_contract', auth: 'Bearer forge-token-employee@example.test' }),
      expect.objectContaining({ url: 'http://forge/api/v1/meta/objects/forge_sales_lead', auth: 'Bearer forge-token-employee@example.test' }),
      expect.objectContaining({ url: 'http://forge/api/v1/meta/objects/forge_sales_opportunity', auth: 'Bearer forge-token-employee@example.test' }),
    ])
    expect(calls.some((call) => call.url.endsWith('/api/v1/meta/actions'))).toBe(false)
  })

  it('does not degrade denied native employee metadata to the string summary or sign out', async () => {
    const actions = [{ name: 'contract_submit_material_package', objectName: 'forge_sales_contract', params: [{ name: 'material_file_ids', type: 'string', required: true }] }]
    const fetchMock = workOverviewFetch((url) => {
      if (url.endsWith('/api/v1/workbench/business-actions/catalog')) return Response.json({ version: '1', provider: { id: 'forge', name: 'Forge', status: 'available' }, capabilities: actions.map((a) => ({ id: `forge:action:${a.objectName}.${a.name}`, name: a.name, description: a.name, resourceType: a.objectName, status: 'available', effect: 'write', executionMode: 'team_delegable' })), refreshedAt: new Date().toISOString() })
      if (url.endsWith('/api/v1/mcp')) return Response.json({ jsonrpc: '2.0', id: 'business-capability-catalog', result: { content: [{ type: 'text', text: JSON.stringify({ actions }) }] } })
      if (url.endsWith('/api/v1/meta/objects/forge_sales_contract')) return Response.json({ error: 'forbidden' }, { status: 403 })
      return undefined
    })
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
    await signInAs(service, 'employee@example.test')

    await expect(service.getBusinessCapabilities(['forge:action:forge_sales_contract.contract_submit_material_package']))
      .rejects.toThrow('没有读取 Forge 对象 forge_sales_contract 原生动作声明的权限')
    await expect(service.getSession()).resolves.toMatchObject({ status: 'signed-in' })
  })

  it('keeps the enterprise session when Forge denies one capability catalog', async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input)
      if (url.endsWith('/__test/approving-account')) return Response.json({ token: 'forge-token', user: { id: 'forge-1', email: 'developer@example.test' } })
      if (url.endsWith('/v1/auth/external/exchange')) return Response.json({ token: 'weave-token', subject: { id: 'weave-1', externalId: 'forge-1' }, organization: { id: 'default' }, issuer: 'forge:test-deployment', permissions: ['teams:use', 'teams:develop'] })
      if (url.endsWith('/api/v1/workbench/business-actions/catalog')) return Response.json({}, { status: 403 })
      return Response.json({}, { status: 404 })
    }) as typeof fetch
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
    await signInAs(service, 'developer@example.test')

    await expect(service.getBusinessCapabilityCatalog()).rejects.toThrow('当前账号没有读取 Forge 业务能力的权限')
    await expect(service.getSession()).resolves.toMatchObject({ status: 'signed-in' })
    expect((await service.authorizationHeaders()).get('Authorization')).toBe('Bearer weave-token')
  })

  it('explains an expired Forge password without discarding the Weave session', async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input)
      if (url.endsWith('/__test/approving-account')) return Response.json({ token: 'forge-token', user: { id: 'forge-1', email: 'developer@example.test' } })
      if (url.endsWith('/v1/auth/external/exchange')) return Response.json({ token: 'weave-token', subject: { id: 'weave-1', externalId: 'forge-1' }, organization: { id: 'default' }, issuer: 'forge:test-deployment', permissions: ['teams:use', 'teams:develop'] })
      if (url.endsWith('/api/v1/workbench/business-actions/catalog')) return Response.json({ error: { code: 'PASSWORD_EXPIRED', message: 'expired' } }, { status: 403 })
      return Response.json({}, { status: 404 })
    }) as typeof fetch
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
    await signInAs(service, 'developer@example.test')

    await expect(service.getBusinessCapabilityCatalog()).rejects.toThrow('Forge 账号密码已过期，请更新密码后重新登录')
    await expect(service.getSession()).resolves.toMatchObject({ status: 'signed-in' })
    expect((await service.authorizationHeaders()).get('Authorization')).toBe('Bearer weave-token')
  })

  it('reports Forge and Weave health without forwarding credentials', async () => {
    const fetchMock = vi.fn(async (input: URL, _init?: RequestInit) => new Response(JSON.stringify(
      input.hostname === 'forge.example.test' ? { data: { version: '17.4.0' } } : { status: 'ready' },
    ), { status: 200, headers: { 'content-type': 'application/json' } }))
    const service = newEnterpriseService({
      environment: { WORKBENCH_FORGE_URL: 'https://forge.example.test', WORKBENCH_WEAVE_URL: 'https://weave.example.test' },
      fetch: fetchMock as typeof fetch,
    })

    await expect(service.getStatus()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'forge-development', available: true, secure: true, version: '17.4.0' }),
      expect.objectContaining({ id: 'weave-development', available: true, secure: true }),
    ]))
    expect(fetchMock.mock.calls.every((call) => !new Headers(call[1]?.headers).has('Authorization'))).toBe(true)
  })

  it('keeps unconfigured Forge and Weave requests on separate loopback origins', async () => {
    const requests: string[] = []
    const fetchMock = vi.fn(async (input: URL) => {
      requests.push(input.toString())
      return Response.json({ status: 'ready' }, { status: 200 })
    }) as typeof fetch
    const service = newEnterpriseService({ environment: {}, fetch: fetchMock })

    await expect(service.getStatus()).resolves.toEqual([
      expect.objectContaining({ id: 'forge-development', url: 'http://127.0.0.1:3000', available: true, secure: false }),
      expect.objectContaining({ id: 'weave-development', url: 'http://127.0.0.1:8080', available: true, secure: false }),
    ])
    expect(requests).toEqual([
      'http://127.0.0.1:3000/api/v1/health',
      'http://127.0.0.1:8080/v1/health',
    ])
  })

  it('loads only the remote team catalog before selecting a draft', async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/__test/approving-account')) return Response.json({ token: 'forge-token', user: { id: 'forge-1', email: 'admin@example.test', name: 'Admin' } })
      if (url.endsWith('/v1/auth/external/exchange')) return Response.json({ token: 'weave-token', subject: { id: 'weave-1', externalId: 'forge-1' }, organization: { id: 'default' }, issuer: 'forge:test-deployment', permissions: ['teams:use', 'teams:develop', 'teams:admin'] })
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer weave-token')
      if (url.endsWith('/v1/runtimes')) return Response.json({ runtimes: [{ id: 'runtime-local', name: '本机运行时', engines: ['codex'], health_status: 'healthy', online: true }] })
      if (url.endsWith('/v1/development/model-catalog')) return Response.json({ models: ['qwen3:0.6b'] })
      if (url.includes('/v1/teams?')) return Response.json([{ team: { id: 'team-1', display_name: '合同交接团队', objective: '完成合同交接', status: 'active', updated_at: '2026-09-21T00:00:00Z' }, lead: { id: 'lead-1', display_name: '负责人', role: 'avatar', enabled: true }, workers: [{ id: 'worker-1', display_name: '审核员', role: 'worker', configured_duty: '审核合同', enabled: true }], summary: { worker_count: 1, active_workflow_count: 1, published_workflow_count: 1, health: { conclusion: 'healthy', reason_codes: [] } } }])
      if (url.endsWith('/v1/teams/team-1/workflows')) return Response.json({ workflows: [{ id: 'flow-1', name: '合同处理', status: 'active', published_version: 2, trigger_summary: { type: 'manual' } }] })
      if (url.endsWith('/v1/workflows/flow-1/versions/2')) return Response.json({ graph_definition: { nodes: [{ id: 'review', type: 'agent', label: '审核', config: { agent_id: 'worker-1' } }], edges: [] } })
      if (url.includes('/v1/runs?view=team&team_id=team-1')) return Response.json({ runs: [{ run_id: 'run-1', status: 'succeeded', step: 'review', duration_ms: 1200, tokens_in: 10, tokens_out: 20, cost_usd: 0.01 }] })
      return Response.json({}, { status: 404 })
    }) as typeof fetch
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
    await signInAs(service, 'admin@example.test')

    await expect(service.getDevelopmentOverview()).resolves.toMatchObject({
      version: '1', runtimes: [{ name: '本机运行时', online: true }], teams: [{ id: 'team-1', name: '合同交接团队', lead: { name: '负责人' }, workers: [{ name: '审核员', duty: '审核合同' }], workflows: [], runs: [] }],
    })
  })

  it('reads and saves a server-backed team member configuration draft', async () => {
    const requests: Array<{ method: string; body?: Record<string, unknown> }> = []
    const response = (revision: number) => ({
      version: '1', team_id: 'team-1', agent_id: 'worker-1', agent_name: 'reviewer', base_agent_version: 3, revision,
      updated_at: '2026-09-21T10:00:00Z', configuration: {
        display_name: revision ? '合同复核员' : '审核员', role: 'worker', engine: 'pi', runtime_id: 'local-pi', model: 'default',
        system_prompt: '检查合同', skill_names: ['contract-review'], mcp_server_ids: ['forge'], permission_allow: ['contract.read'],
        business_capability_ids: ['forge:action:sales_contract.ContractSubmit'], business_capability_bindings: [{ capability_id: 'forge:action:sales_contract.ContractSubmit', parameters: [{ name: 'material_file_ids', source: 'materials.ids' }] }],
        memory_enabled: true, memory_scope: 'tenant', max_tokens: 12000, output_schema: { type: 'object' },
      }, relationship: { duty: '复核合同', when_to_use: '合同提交后', allowed_kinds: ['handoff'], default_kind: 'handoff', enabled: true },
    })
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/__test/approving-account')) return Response.json({ token: 'forge-token', user: { id: 'forge-1', email: 'admin@example.test', name: 'Admin' } })
      if (url.endsWith('/v1/auth/external/exchange')) return Response.json({ token: 'weave-token', subject: { id: 'weave-1', externalId: 'forge-1' }, organization: { id: 'default' }, issuer: 'forge:test-deployment', permissions: ['teams:use', 'teams:develop'] })
      requests.push({ method: init?.method ?? 'GET', ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}) })
      return Response.json(response(init?.method === 'PUT' ? 1 : 0))
    }) as typeof fetch
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
    await signInAs(service, 'admin@example.test')
    const draft = await service.getTeamMemberConfigDraft('team-1', 'worker-1')
    expect(draft).toMatchObject({ agentName: 'reviewer', revision: 0, configuration: { engine: 'pi', outputSchema: expect.stringContaining('object'), businessCapabilityBindings: [{ capabilityId: 'forge:action:sales_contract.ContractSubmit', parameters: [{ name: 'material_file_ids', source: 'materials.ids' }] }] }, relationship: { duty: '复核合同' } })
    draft.configuration.displayName = '合同复核员'
    const saved = await service.saveTeamMemberConfigDraft(draft)
    expect(saved).toMatchObject({ revision: 1, configuration: { displayName: '合同复核员' } })
    expect(requests.at(-1)).toMatchObject({ method: 'PUT', body: { revision: 0, configuration: { display_name: '合同复核员', business_capability_bindings: [{ capability_id: 'forge:action:sales_contract.ContractSubmit', parameters: [{ name: 'material_file_ids', source: 'materials.ids' }] }] } } })
    const applied = await service.applyTeamMemberConfigDraft('team-1', 'worker-1', 1)
    expect(applied.revision).toBe(0)
    expect(requests.at(-1)).toEqual({ method: 'POST', body: { revision: 1 } })
  })

  it('creates an editable team with a lead and an execution member', async () => {
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = []
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input), method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
      if (url.endsWith('/__test/approving-account')) return Response.json({ token: 'forge-token', user: { id: 'forge-1', email: 'developer@example.test', name: 'Developer' } })
      if (url.endsWith('/v1/auth/external/exchange')) return Response.json({ token: 'weave-token', subject: { id: 'weave-1', externalId: 'forge-1' }, organization: { id: 'default' }, issuer: 'forge:test-deployment', permissions: ['teams:use', 'teams:develop'] })
      calls.push({ url, method, body })
      if (url.endsWith('/v1/agents') && body?.role === 'avatar') return Response.json({ id: 'lead-1', ...body }, { status: 201 })
      if (url.endsWith('/v1/agents') && body?.role === 'worker') return Response.json({ id: 'worker-1', ...body }, { status: 201 })
      if (url.endsWith('/v1/teams')) return Response.json({ id: 'team-1', display_name: '采购团队', objective: '处理采购工作' }, { status: 201 })
      return Response.json({}, { status: 404 })
    }) as typeof fetch
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
    await signInAs(service, 'developer@example.test')

    await expect(service.createDevelopmentTeam({ version: '1', name: '采购团队', objective: '处理采购工作' })).resolves.toEqual({ id: 'team-1', name: '采购团队', objective: '处理采购工作' })
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual(['POST /v1/agents', 'POST /v1/agents', 'POST /v1/teams'])
    expect(calls[2].body).toMatchObject({ display_name: '采购团队', lead_avatar_id: 'lead-1', workers: [{ worker_agent_id: 'worker-1' }] })
  })

  it('updates team details and adds and removes a team member', async () => {
    const calls: Array<{ path: string; method: string; body?: Record<string, unknown> }> = []
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input)), method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
      if (url.pathname.endsWith('/__test/approving-account')) return Response.json({ token: 'forge-token', user: { id: 'forge-1', email: 'developer@example.test' } })
      if (url.pathname.endsWith('/v1/auth/external/exchange')) return Response.json({ token: 'weave-token', subject: { id: 'weave-1', externalId: 'forge-1' }, organization: { id: 'default' }, issuer: 'forge:test-deployment', permissions: ['teams:use', 'teams:develop'] })
      calls.push({ path: url.pathname, method, body })
      if (url.pathname === '/v1/agents') return Response.json({ id: 'worker-2', name: body?.name }, { status: 201 })
      if (method === 'DELETE') return new Response(null, { status: 204 })
      return Response.json({}, { status: method === 'POST' ? 201 : 200 })
    }) as typeof fetch
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
    await signInAs(service, 'developer@example.test')

    await service.updateDevelopmentTeam({ version: '1', teamId: 'team-1', name: '合同交接组', objective: '完成合同复核', expectedUpdatedAt: '2026-09-21T00:00:00Z' })
    await expect(service.createDevelopmentTeamMember({ version: '1', teamId: 'team-1', name: '法务复核员', duty: '复核法律条款' })).resolves.toEqual({ id: 'worker-2', name: '法务复核员' })
    await service.removeDevelopmentTeamMember('team-1', 'worker-2')

    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/v1/teams/team-1/profile', method: 'PUT', body: { display_name: '合同交接组', objective: '完成合同复核', expected_updated_at: '2026-09-21T00:00:00Z' } }),
      expect.objectContaining({ path: '/v1/teams/team-1/workers', method: 'POST', body: expect.objectContaining({ worker_agent_id: 'worker-2', duty: '复核法律条款' }) }),
      expect.objectContaining({ path: '/v1/teams/team-1/workers/worker-2', method: 'DELETE' }),
    ]))
  })

  it('creates a readable three-step workflow from the selected team members', async () => {
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = []
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input), method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
      if (url.endsWith('/__test/approving-account')) return Response.json({ token: 'forge-token', user: { id: 'forge-1', email: 'developer@example.test', name: 'Developer' } })
      if (url.endsWith('/v1/auth/external/exchange')) return Response.json({ token: 'weave-token', subject: { id: 'weave-1', externalId: 'forge-1' }, organization: { id: 'default' }, issuer: 'forge:test-deployment', permissions: ['teams:use', 'teams:develop'] })
      calls.push({ url, method, body })
      if (url.endsWith('/members/lead-1/config-draft')) return Response.json({ version: '1', team_id: 'team-1', agent_id: 'lead-1', agent_name: 'lead', base_agent_version: 2, revision: 0, updated_at: '2026-09-21T00:00:00Z', configuration: { display_name: '负责人', role: 'avatar', engine: 'loom', system_prompt: '理解任务' }, relationship: {} })
      if (url.endsWith('/members/worker-1/config-draft')) return Response.json({ version: '1', team_id: 'team-1', agent_id: 'worker-1', agent_name: 'worker', base_agent_version: 3, revision: 0, updated_at: '2026-09-21T00:00:00Z', configuration: { display_name: '执行成员', role: 'worker', engine: 'loom' }, relationship: { result_requirement: '返回成果', enabled: true } })
      if (url.endsWith('/v1/teams/team-1/workflows')) return Response.json({ workflow: { id: 'flow-1', name: '合同流程' }, draft: { version: 1 } }, { status: 201 })
      return Response.json({}, { status: 404 })
    }) as typeof fetch
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
    await signInAs(service, 'developer@example.test')

    await expect(service.createDevelopmentWorkflow({ version: '1', teamId: 'team-1', name: '合同流程', description: '完成合同交接', leadId: 'lead-1', workerId: 'worker-1' })).resolves.toEqual({ id: 'flow-1', name: '合同流程', draftVersion: 1 })
    const request = calls.find((call) => call.url.endsWith('/v1/teams/team-1/workflows') && call.method === 'POST')?.body
    expect(request).toMatchObject({ name: '合同流程', trigger_config: { schema_version: 1 }, graph_definition: { entry_node_id: 'understand', nodes: [{ type: 'lead' }, { type: 'worker', config: { agent_id: 'worker-1', agent_version: 3 } }, { type: 'deliver' }] } })
  })

  it('validates a workflow draft without publishing it', async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/__test/approving-account')) return Response.json({ token: 'forge-token', user: { id: 'forge-1', email: 'developer@example.test', name: 'Developer' } })
      if (url.endsWith('/v1/auth/external/exchange')) return Response.json({ token: 'weave-token', subject: { id: 'weave-1', externalId: 'forge-1' }, organization: { id: 'default' }, issuer: 'forge:test-deployment', permissions: ['teams:use', 'teams:develop'] })
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({})
      return Response.json({ valid: false, issues: [{ phase: 4, path: '/nodes/0', node_id: 'review', code: 'workflow_route_missing', message: 'route missing', occurrence: 1 }] })
    }) as typeof fetch
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
    await signInAs(service, 'developer@example.test')

    await expect(service.validateDevelopmentWorkflow('flow-1', 2)).resolves.toEqual({ valid: false, issues: [{ code: 'workflow_route_missing', message: 'route missing', nodeId: 'review' }] })
  })

  it('does not infer that an older pending team request is handled from a later notification in the same session', async () => {
    const notice = (id: string, kind: string, createdAt: string) => ({
      id, type: `weave.team_run.${kind}`, title: `合同检查${kind}`, body: '团队结果', createdAt, read: false,
    })
    const sourceById: Record<string, { kind: string; workReference: string; sessionReference: string }> = {
      old: { kind: 'revision_required', workReference: 'revision-1', sessionReference: 'contract-work' },
      new: { kind: 'result', workReference: 'revision-2', sessionReference: 'contract-work' },
      other: { kind: 'revision_required', workReference: 'revision-3', sessionReference: 'another-work' },
    }
    const fetchMock = workOverviewFetch((url, init) => {
      if (url.includes('/v1/teams?status=active')) return Response.json([])
      if (url.includes('/v1/runs?')) return Response.json({ runs: [] })
      if (url.endsWith('/v1/human-tasks?limit=50')) return Response.json({ tasks: [] })
      if (url.endsWith('/api/v1/workbench/approvals?limit=100&includeSubmitted=1')) return Response.json({ version: '1', items: [] })
      if (url.endsWith('/api/v1/apps/forge/workbench/inbox?limit=100')) return notificationResponse({ data: { notifications: [
        notice('old', 'revision_required', '2026-09-29T02:18:00Z'),
        notice('new', 'result', '2026-09-29T05:09:00Z'),
        notice('other', 'revision_required', '2026-09-29T02:18:00Z'),
      ] } })
      const sourceId = /^http:\/\/forge\/api\/v1\/workbench\/notifications\/([^/]+)\/source$/.exec(url)?.[1]
      if (sourceId && sourceById[sourceId]) {
        const { kind, ...references } = sourceById[sourceId]
        return Response.json({
          version: '1', notificationId: sourceId, kind,
          source: { system: 'weave', ...references, runReference: `run-${sourceId}` },
        })
      }
      if (url.endsWith('/v1/workbench/runs/lookup')) {
        const ids = (JSON.parse(String(init?.body)) as { runIds: string[] }).runIds
        return Response.json({ version: '1', runs: ids.map((id) => { const entry = sourceById[id.replace('run-', '')]!; return runLookup({ ...entry, runReference: id }) }), missing: [] })
      }
      return undefined
    })
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
    await signInAs(service, 'sales@example.test')
    const overview = await service.getWorkOverview()
    expect(overview.items.find((item) => item.id === 'old')).toMatchObject({ actionable: true, status: 'pending', read: false })
    expect(overview.items.find((item) => item.id === 'new')).toMatchObject({ kind: 'result' })
    expect(overview.items.find((item) => item.id === 'other')).toMatchObject({ actionable: true, status: 'pending' })
  })


  it('reads all 623 approval projection items beyond the old cap without losing older pending items', async () => {
    const items = Array.from({ length: 623 }, (_, index) => ({ requestId: `approval-${index}`, mode: 'approval', updatedAt: '2026-10-01T00:00:00Z', title: `审批事项${index}` }))
    const cursors: string[] = []
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: workOverviewFetch((url) => {
      const parsed = new URL(url)
      if (parsed.pathname === '/api/v1/workbench/approvals') {
        const cursor = parsed.searchParams.get('cursor') ?? '0'; cursors.push(cursor)
        const offset = Number(cursor)
        expect(parsed.searchParams.get('limit')).toBe('100')
        return Response.json({ version: '1', items: items.slice(offset, offset + 100), ...(offset + 100 < items.length ? { nextCursor: String(offset + 100) } : {}) })
      }
      if (url.includes('/v1/teams?')) return Response.json([])
      if (url.includes('/v1/runs?')) return Response.json({ runs: [] })
      if (url.includes('/api/v1/apps/forge/workbench/inbox?')) return notificationResponse({ notifications: [] })
      return undefined
    }) })
    await signInAs(service, 'employee@example.test')
    const overview = await service.getWorkOverview()
    expect(cursors).toEqual(['0', '100', '200', '300', '400', '500', '600'])
    expect(overview.tasks).toHaveLength(623)
    expect(overview.tasks.at(-1)?.title).toBe('审批事项622')
    expect(overview.reads.forgeApprovals.status).toBe('loaded')
  })

  it('reports a forbidden approval page without logging out or discarding other readable work data', async () => {
    const first = Array.from({ length: 100 }, (_, index) => ({ requestId: `approval-${index}`, mode: 'approval', title: '审批事项', updatedAt: '2026-10-01T00:00:00Z' }))
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: workOverviewFetch((url) => {
      if (url.endsWith('/api/v1/workbench/approvals?limit=100&includeSubmitted=1')) return Response.json({ version: '1', items: first, nextCursor: 'next' })
      if (url.endsWith('/api/v1/workbench/approvals?limit=100&includeSubmitted=1&cursor=next')) return Response.json({}, { status: 403 })
      if (url.includes('/v1/teams?')) return Response.json([])
      if (url.includes('/v1/runs?')) return Response.json({ runs: [] })
      if (url.includes('/v1/human-tasks?')) return Response.json({ tasks: [] })
      if (url.includes('/api/v1/apps/forge/workbench/inbox?')) return notificationResponse({ notifications: [{ id: 'readable-notice', type: 'result', title: '本人可读消息', createdAt: '2026-10-01T00:00:00Z' }] })
      return undefined
    }) })
    await signInAs(service, 'employee@example.test')
    const overview = await service.getWorkOverview()
    expect(overview.reads.forgeApprovals).toMatchObject({ status: 'failed', error: '当前账号没有读取审批事项的权限' })
    expect(overview.items[0]?.title).toBe('本人可读消息')
    expect(overview.reads.notifications.status).toBe('loaded')
    expect((await service.getSession()).status).toBe('signed-in')
  })

  it('discards an entire paged approval overview when its employee account changes between pages', async () => {
    const waiting = deferred<Response>(), started = deferred<void>()
    const requests = Array.from({ length: 100 }, (_, index) => ({ requestId: `alice-approval-${index}`, mode: 'approval', title: 'Alice 审批事项', updatedAt: '2026-10-01T00:00:00Z' }))
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: workOverviewFetch((url, init) => {
      if (url.endsWith('/api/v1/workbench/approvals?limit=100&includeSubmitted=1')) return Response.json(new Headers(init?.headers).get('Authorization')?.endsWith('-alice@example.test') ? { version: '1', items: requests, nextCursor: 'next' } : { version: '1', items: [] })
      if (url.endsWith('/api/v1/workbench/approvals?limit=100&includeSubmitted=1&cursor=next')) { started.resolve(); return waiting.promise }
      if (url.includes('/v1/teams?')) return Response.json([])
      if (url.includes('/v1/runs?')) return Response.json({ runs: [] })
      if (url.includes('/v1/human-tasks?')) return Response.json({ tasks: [] })
      if (url.includes('/api/v1/apps/forge/workbench/inbox?')) return notificationResponse({ notifications: [] })
      return undefined
    }) })
    await signInAs(service, 'alice@example.test')
    const overview = service.getWorkOverview(), discarded = expect(overview).rejects.toThrow('账号已切换')
    await started.promise; await signInAs(service, 'bob@example.test')
    waiting.resolve(Response.json({ version: '1', items: [{ ...requests[0]!, requestId: 'alice-oldest' }] }))
    await discarded
    expect((await service.getSession()).user?.email).toBe('bob@example.test')
    expect((await service.getWorkOverview()).tasks).toEqual([])
  })

  it('reads 251 original inbox notices beyond the old window and retains visible pages after a source error', async () => {
    let failLast = false
    const notices = Array.from({ length: 251 }, (_, index) => ({ id: `inbox-${index}`, type: 'business.result', title: `本人消息${index}`, createdAt: '2026-10-01T00:00:00Z' }))
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: workOverviewFetch((url) => {
      const parsed = new URL(url)
      if (parsed.pathname === '/api/v1/apps/forge/workbench/inbox') {
        const cursor = parsed.searchParams.get('cursor'), offset = cursor === 'second' ? 200 : cursor === 'first' ? 100 : 0
        if (failLast && offset === 200) return Response.json({}, { status: 403 })
        return Response.json({ version: '1', notifications: notices.slice(offset, offset + 100), next_cursor: offset === 0 ? 'first' : offset === 100 ? 'second' : null, has_more: offset < 200 })
      }
      if (url.includes('/v1/teams?')) return Response.json([])
      if (url.includes('/v1/runs?')) return Response.json({ runs: [] })
      if (url.includes('/v1/human-tasks?')) return Response.json({ tasks: [] })
      if (url.includes('/api/v1/workbench/approvals?')) return Response.json({ version: '1', items: [] })
      return undefined
    }) })
    await signInAs(service, 'employee@example.test')
    const complete = await service.getWorkOverview()
    expect(complete.items).toHaveLength(251)
    expect(complete.reads.notifications.status).toBe('loaded')
    failLast = true
    const partial = await service.getWorkOverview()
    expect(partial.items).toHaveLength(200)
    expect(partial.reads.notifications).toMatchObject({ status: 'failed', error: '当前账号没有读取通知的权限' })
    expect((await service.getSession()).status).toBe('signed-in')
  })

  it.each(['superseded', 'closed', 'current'] as const)('uses only the exact authoritative %s input status to retire a needs-input notice', async (inputStatus) => {
    const source = { workReference: '550e8400-e29b-41d4-a716-446655440400', runReference: 'run-authority', sessionReference: 'work-authority' }
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: workOverviewFetch((url) => {
      if (url.includes('/v1/teams?')) return Response.json([])
      if (url.includes('/v1/runs?')) return Response.json({ runs: [] })
      if (url.includes('/v1/human-tasks?')) return Response.json({ tasks: [] })
      if (url.includes('/api/v1/workbench/approvals?')) return Response.json({ version: '1', items: [] })
      if (url.includes('/api/v1/apps/forge/workbench/inbox?')) return notificationResponse({ notifications: [{ id: 'old-authority', type: 'weave.team_run.revision_required', title: '待补材料', createdAt: '2026-10-01T00:00:00Z' }] })
      if (url.endsWith('/api/v1/workbench/notifications/old-authority/source')) return Response.json({ version: '1', notificationId: 'old-authority', kind: 'revision_required', source: { system: 'weave', ...source } })
      if (url.endsWith('/v1/workbench/runs/lookup')) return Response.json({ version: '1', runs: [runLookup(source, 'needs_input', inputStatus !== 'superseded')], missing: [] })
      return undefined
    }) })
    await signInAs(service, 'employee@example.test')
    const item = (await service.getWorkOverview()).items[0]!
    expect(item.actionable).toBe(inputStatus !== 'superseded')
    expect(item.status).toBe(inputStatus === 'superseded' ? 'completed' : 'pending')
  })

  it('never carries an old native inbox cursor or partial page into the replacement employee account', async () => {
    const waiting = deferred<Response>(), started = deferred<void>(), cursorCalls: string[] = []
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: workOverviewFetch((url, init) => {
      const parsed = new URL(url), old = new Headers(init?.headers).get('Authorization')?.endsWith('-alice@example.test')
      if (parsed.pathname === '/api/v1/apps/forge/workbench/inbox') {
        const cursor = parsed.searchParams.get('cursor')
        if (cursor) { cursorCalls.push(cursor); started.resolve(); return waiting.promise }
        return Response.json({ version: '1', notifications: old ? [{ id: 'alice-only', title: '旧员工消息', type: 'business.result', createdAt: '2026-10-01T00:00:00Z' }] : [], next_cursor: old ? 'alice-bound-cursor' : null, has_more: old })
      }
      if (url.includes('/v1/teams?')) return Response.json([])
      if (url.includes('/v1/runs?')) return Response.json({ runs: [] })
      if (url.includes('/v1/human-tasks?')) return Response.json({ tasks: [] })
      if (url.includes('/api/v1/workbench/approvals?')) return Response.json({ version: '1', items: [] })
      return undefined
    }) })
    await signInAs(service, 'alice@example.test')
    const original = service.getWorkOverview(), discarded = expect(original).rejects.toThrow('账号已切换')
    await started.promise; await signInAs(service, 'bob@example.test')
    waiting.resolve(Response.json({ version: '1', notifications: [], next_cursor: null, has_more: false })); await discarded
    expect((await service.getWorkOverview()).items).toEqual([])
    expect(cursorCalls).toEqual(['alice-bound-cursor'])
    expect((await service.getSession()).user?.email).toBe('bob@example.test')
  })


  it('projects exact run lookup results and disables unresolved notices without reading original files', async () => {
    const entries = [
      { id: 'succeeded', workReference: 'input-completed', runReference: 'run-completed', sessionReference: 'work-completed', result: 'completed' },
      { id: 'no-action', workReference: 'input-needs', runReference: 'run-needs', sessionReference: 'work-needs', result: 'needs_input' },
      { id: 'unknown', workReference: 'input-unknown', runReference: 'run-unknown', sessionReference: 'work-unknown', result: 'action_unknown' },
      { id: 'missing', workReference: 'input-missing', runReference: 'run-missing', sessionReference: 'work-missing', result: undefined },
      { id: 'mismatched', workReference: 'input-mismatch', runReference: 'run-mismatch', sessionReference: 'work-mismatch', result: 'completed' },
    ] as const
    const calls: string[] = [], sourceAuth: Array<string | null> = [], lookupAuth: Array<string | null> = []
    const fetchMock = workOverviewFetch((url, init) => {
      calls.push(url)
      if (url.includes('/v1/teams?')) return Response.json([])
      if (url.includes('/v1/runs?')) return Response.json({ runs: [] })
      if (url.includes('/api/v1/workbench/approvals?')) return Response.json({ version: '1', items: [] })
      if (url.includes('/api/v1/apps/forge/workbench/inbox?')) return notificationResponse({ notifications: entries.map((entry) => ({
        id: entry.id, type: 'weave.team_run.revision_required', title: '合同检查', read: false, createdAt: '2026-10-01T00:00:00Z',
        data: { source: { system: 'weave', workReference: 'forged-input', runReference: 'run-unrelated', sessionReference: 'forged-session' } },
      })) })
      const id = new URL(url).pathname.match(/notifications\/([^/]+)\/source$/)?.[1]
      if (id) {
        sourceAuth.push(new Headers(init?.headers).get('Authorization'))
        const entry = entries.find((item) => item.id === id)!
        return Response.json({ version: '1', notificationId: id, kind: 'revision_required', source: { system: 'weave', workReference: entry.workReference, runReference: entry.runReference, sessionReference: entry.sessionReference } })
      }
      if (url.endsWith('/v1/workbench/runs/lookup')) {
        lookupAuth.push(new Headers(init?.headers).get('Authorization'))
        expect(JSON.parse(String(init?.body))).toEqual({ version: '1', runIds: entries.map((item) => item.runReference) })
        return Response.json({ version: '1', runs: entries.filter((entry) => entry.id !== 'missing').map((entry) => runLookup({ ...entry, ...(entry.id === 'mismatched' ? { workReference: 'different-input' } : {}) }, entry.result)), missing: ['run-missing'] })
      }
      return undefined
    })
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
    await signInAs(service, 'sales@example.test')
    const overview = await service.getWorkOverview()
    expect(overview.items.find((item) => item.id === 'succeeded')).toMatchObject({ actionable: false, status: 'completed', read: false, runReference: 'run-completed', title: '团队结果与业务回执', summary: expect.stringContaining('Forge 当前正式事项为准') })
    expect(overview.items.find((item) => item.id === 'no-action')).toMatchObject({ actionable: true, status: 'pending' })
    expect(overview.items.find((item) => item.id === 'unknown')).toMatchObject({ actionable: false, status: 'completed', title: '业务动作结果待核对' })
    for (const id of ['missing', 'mismatched']) expect(overview.items.find((item) => item.id === id)).toMatchObject({ actionable: false, status: 'unknown' })
    expect(sourceAuth).toEqual(entries.map(() => 'Bearer forge-token-sales@example.test'))
    expect(lookupAuth).toEqual(['Bearer weave-token-sales@example.test'])
    expect(calls.some((url) => url.includes('/original') || url.includes('/workbench/materials/') || url.includes('/workbench-context') || url.includes('run-unrelated'))).toBe(false)
  })

  it.each(['completed', 'needs_input', 'action_failed', 'action_unknown'] as const)('projects server business result %s over a model needs-input notice', async (businessResult) => {
    const source = { workReference: '550e8400-e29b-41d4-a716-446655440300', runReference: 'run-business-result', sessionReference: 'work-business-result' }
    const fetchMock = workOverviewFetch((url) => {
      if (url.includes('/v1/teams?status=active')) return Response.json([])
      if (url.includes('/v1/runs?')) return Response.json({ runs: [] })
      if (url.endsWith('/v1/human-tasks?limit=50')) return Response.json({ tasks: [] })
      if (url.endsWith('/api/v1/workbench/approvals?limit=100&includeSubmitted=1')) return Response.json({ version: '1', items: [] })
      if (url.endsWith('/api/v1/apps/forge/workbench/inbox?limit=100')) return notificationResponse({ notifications: [{ id: 'server-result', type: 'weave.team_run.revision_required', title: '合同检查', createdAt: '2026-09-30T02:00:00Z' }] })
      if (url.endsWith('/api/v1/workbench/notifications/server-result/source')) return Response.json({ version: '1', notificationId: 'server-result', kind: 'revision_required', source: { system: 'weave', ...source } })
      if (url.endsWith('/v1/workbench/runs/lookup')) return Response.json({ version: '1', runs: [runLookup(source, businessResult)], missing: [] })
      return undefined
    })
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
    await signInAs(service, 'employee@example.test')
    const item = (await service.getWorkOverview()).items[0]!
    expect(item.actionable).toBe(businessResult === 'needs_input')
    expect(item.status).toBe(businessResult === 'needs_input' ? 'pending' : 'completed')
    if (businessResult === 'completed') expect(item.summary).toContain('审批状态以 Forge 当前正式事项为准')
    if (businessResult === 'action_failed') expect(item.summary).toContain('业务动作失败')
    if (businessResult === 'action_unknown') expect(item.summary).toContain('结果未知')
  })

  it('does not reuse a successful action receipt across employee accounts', async () => {
    const source = { workReference: '550e8400-e29b-41d4-a716-446655440201', runReference: 'run-shared-notice', sessionReference: 'work-session-shared' }
    const contextAuthors: string[] = []
    const fetchMock = workOverviewFetch((url, init) => {
      if (url.includes('/v1/teams?status=active')) return Response.json([])
      if (url.includes('/v1/runs?')) return Response.json({ runs: [] })
      if (url.endsWith('/v1/human-tasks?limit=50')) return Response.json({ tasks: [] })
      if (url.endsWith('/api/v1/workbench/approvals?limit=100&includeSubmitted=1')) return Response.json({ version: '1', items: [] })
      if (url.endsWith('/api/v1/apps/forge/workbench/inbox?limit=100')) return notificationResponse({ notifications: [
        { id: 'same-notice', type: 'weave.team_run.revision_required', title: '合同检查', body: '团队意见', read: false, createdAt: '2026-09-30T02:00:00Z' },
      ] })
      if (url.endsWith('/api/v1/workbench/notifications/same-notice/source')) return Response.json({
        version: '1', notificationId: 'same-notice', kind: 'revision_required', source: { system: 'weave', ...source },
      })
      if (url.endsWith('/v1/workbench/runs/lookup')) {
        const authorization = new Headers(init?.headers).get('Authorization') ?? ''
        contextAuthors.push(authorization)
        return Response.json({ version: '1', runs: [runLookup(source, authorization === 'Bearer weave-token-alice@example.test' ? 'completed' : 'needs_input')], missing: [] })
      }
      return undefined
    })
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })

    await signInAs(service, 'alice@example.test')
    const alice = await service.getWorkOverview()
    expect(alice.items[0]).toMatchObject({ actionable: false, status: 'completed' })
    await signInAs(service, 'bob@example.test')
    const bob = await service.getWorkOverview()
    expect(bob.items[0]).toMatchObject({ actionable: true, status: 'pending' })
    expect(contextAuthors).toEqual(['Bearer weave-token-alice@example.test', 'Bearer weave-token-bob@example.test'])
  })

  it('submits bound work and completes only the exact human task opened from the native inbox', async () => {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = []
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input)
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
      calls.push({ url, body })
      if (url.endsWith('/__test/approving-account')) return Response.json({ token: 'forge-token', user: { id: 'forge-1', email: 'member@example.test', name: 'Member' }, session: { activeOrganizationId: 'forge-org' } })
      if (url.endsWith('/v1/auth/external/exchange')) return Response.json({ token: 'weave-token', subject: { id: 'weave-1', externalId: 'forge-1' }, organization: { id: 'default' }, issuer: 'forge:test-deployment', permissions: ['teams:use'] })
      if (url.includes('/v1/teams?status=active')) return Response.json([{ id: 'team-1', display_name: '合同团队' }])
      if (url.endsWith('/v1/teams/team-1/workflows')) return Response.json({ workflows: [{ id: 'flow-1', name: '合同复核', published_version: 1 }] })
      if (url.includes('/v1/runs?project_id=workbench-weave-1&limit=50')) return Response.json({ runs: [{ run_id: 'run-1', status: 'running' }] })
      if (url.endsWith('/v1/workbench/runs/lookup')) return Response.json({ version: '1', runs: [runLookup({ workReference: 'input-1', runReference: 'run-1', sessionReference: 'workbench-session-1' }, undefined, true, 'parked')], missing: [] })
      if (url.includes('/v1/human-tasks/run-1?')) {
        const query = new URL(url).searchParams
        expect(Object.fromEntries(query)).toEqual({ input_revision_id: 'input-1', workbench_session_id: 'workbench-session-1', interaction_id: 'human-1' })
        return Response.json({ interaction_id: 'human-1', run_id: 'run-1', input_revision_id: 'input-1', workbench_session_id: 'workbench-session-1', team_id: 'team-1', workflow_id: 'flow-1', workflow_version: 1, title: '复核', instructions: '确认', updated_at: '2026-09-21T00:00:00Z' })
      }
      if (url.endsWith('/api/v1/workbench/notifications/notice-human/source')) return Response.json({ version: '1', notificationId: 'notice-human', kind: 'human_review', source: { system: 'weave', workReference: 'input-1', runReference: 'run-1', sessionReference: 'workbench-session-1', interactionReference: 'human-1' } })
      if (url.endsWith('/api/v1/apps/forge/workbench/inbox?limit=100')) return notificationResponse({ success: true, data: { notifications: [
        { id: 'notice-1', type: 'work.revision', title: '材料需要修改', body: '请补充交付日期', read: false, createdAt: '2026-09-21T01:00:00Z', data: { kind: 'revision_required', source: { system: 'weave', workReference: 'input-1', runReference: 'run-1', sessionReference: 'workbench-session-1' }, status: 'pending', instructions: '补充交付日期后重新提交', material: { label: '当前材料' }, continuation: { reason: '缺少交付日期', returnTarget: 'origin_review', reviewScope: 'affected_members' } } },
        { id: 'notice-native', type: 'weave.team_run.result', title: '合同检查结果', body: '已有团队结果', read: false, createdAt: '2026-09-21T02:00:00Z' },
        { id: 'notice-human', type: 'weave.team_run.human_review', title: '待我复核', read: false, createdAt: '2026-09-21T03:00:00Z' },
        { id: 'notice-1', type: 'work.revision', title: '材料需要修改', body: '重复投递不应重复显示', read: false, createdAt: '2026-09-21T01:01:00Z' },
      ] } })
      if (url.endsWith('/api/v1/workbench/approvals?limit=100&includeSubmitted=1')) return Response.json({ version: '1', items: [] })
      if (url.endsWith('/v1/workbench/dispatch-inputs/prepare')) return Response.json({ input_revision_id: body?.registration_id })
      if (url.endsWith('/api/v1/apps/forge/task-delegations')) return Response.json(delegationResponse(body?.scope as ForgeTaskScope, 'forge-1'))
      if (url.endsWith('/v1/workbench/dispatch-inputs')) {
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer weave-token')
        expect(new Headers(init?.headers).get('X-Weave-Forge-Authorization')).toBe('Bearer task-token-for-this-input')
        expect(JSON.stringify(body)).not.toContain('forge-token')
        return Response.json({ input_revision_id: body?.input_revision_id, client_request_id: 'client-1', task_sha256: createHash('sha256').update(String(body?.task)).digest('hex') }, { status: 201 })
      }
      if (url.endsWith('/v1/teams/team-1/dispatch')) return Response.json({ run_id: 'run-2', task_id: 'task-2', workflow_id: 'flow-1', workflow_version: 1 }, { status: 201 })
      if (url.endsWith('/v1/human-tasks/run-1/complete')) return Response.json({ run_id: 'run-1', idempotent: false }, { status: 202 })
      return Response.json({}, { status: 404 })
    }) as typeof fetch
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
    const session = await signInAs(service, 'member@example.test')
    expect(session.user?.weaveUserId).toBe('weave-1')
    const overview = await service.getWorkOverview()
    expect(overview.items).toHaveLength(2)
    expect(overview).toMatchObject({ choices: [{ teamId: 'team-1', workflowId: 'flow-1', version: 1 }], tasks: [{ interactionId: 'human-1' }], items: [
      { id: 'notice-1', kind: 'notification', actionable: false, source: 'forge', returnTarget: 'origin_review', reviewScope: 'affected_members' },
      { id: 'notice-native', kind: 'result', source: 'weave', notificationType: 'weave.team_run.result', status: 'unknown' },
    ], runs: [{ id: 'run-1' }], reads: { runs: { status: 'loaded' }, teamChoices: { status: 'loaded' }, weaveTasks: { status: 'failed' }, forgeApprovals: { status: 'loaded' }, notifications: { status: 'failed', error: expect.stringContaining('通知在读取期间已变化') } } })
    await expect(service.submitWork(overview.choices[0], '提交合同')).rejects.toThrow('直接交接入口不可用')
    await expect(service.submitWork(overview.choices[0], '提交合同', fixedSource(await service.accountKey()))).resolves.toMatchObject({ runId: 'run-2', workflowVersion: 1 })
    await expect(service.completeHumanTask(overview.tasks[0], { decision: 'approved' })).resolves.toEqual({ runId: 'run-1', repeated: false })
    expect(calls.find((call) => call.url.endsWith('/human-tasks/run-1/complete'))?.body).toMatchObject({ interaction_id: 'human-1', input_revision_id: 'input-1', workbench_session_id: 'workbench-session-1' })
    expect(calls.some((call) => call.url.includes('/human-tasks?'))).toBe(false)
    const registration = calls.find((call) => call.url.endsWith('/v1/workbench/dispatch-inputs'))?.body
    expect(registration).toMatchObject({ team_id: 'team-1', workflow_id: 'flow-1', workflow_version: 1, project_id: 'workbench-weave-1', task: '提交合同' })
    expect(String(registration?.workbench_session_id)).toMatch(/^workbench-weave-1-/)
    expect(JSON.stringify(calls)).not.toContain('weave-token')
  })

  it('restarts a failed read-only team run in the same work session without inventing a prior deliverable', async () => {
    const registrations: Record<string, unknown>[] = []
    const fetchMock = workOverviewFetch((url, init) => {
      if (url.endsWith('/v1/workbench/dispatch-inputs')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        registrations.push(body)
        return Response.json({ input_revision_id: body.input_revision_id, client_request_id: 'new-client', task_sha256: createHash('sha256').update(String(body.task)).digest('hex') }, { status: 201 })
      }
      if (url.endsWith('/v1/teams/team-1/dispatch')) return Response.json({ run_id: 'new-run', task_id: 'new-task', workflow_id: 'flow-1', workflow_version: 1 }, { status: 201 })
      return undefined
    })
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
    await signInAs(service, 'sales@example.test')
    const accountKey = await service.accountKey()
    const choice = { teamId: 'team-1', teamName: '团队', workflowId: 'flow-1', workflowName: '流程', businessCapabilityIds: [], version: 1 }
    const base = {
      sessionKey: 'session', sourceMessages: [{ messageId: 'message-1', eventSeq: 1, sha256: 'a'.repeat(64) }], accountKey,
      resources: [], authorizedBusinessCapabilityIds: [], assertCurrent: async () => {}, fixDelegationIntent: fixedSource(accountKey).fixDelegationIntent,
    }
    const continuation = { workbenchSessionID: 'original-session', inputRevisionID: '550e8400-e29b-41d4-a716-446655440000', runID: 'failed-run', teamID: 'team-1' }
    await service.submitWork(choice, '重新检查当前材料', { ...base, idempotencySeed: 'retry-1', continuation: { ...continuation, restartAfterFailedRun: true } })
    expect(registrations[0]).toMatchObject({ workbench_session_id: 'original-session', expected_revision_id: continuation.inputRevisionID })
    expect(registrations[0]).not.toHaveProperty('revision_context')
    await service.submitWork(choice, '修订已有结论', { ...base, idempotencySeed: 'revision-1', continuation })
    expect(registrations[1]).toMatchObject({ revision_context: { parent_input_revision_id: continuation.inputRevisionID, parent_run_id: continuation.runID } })
    await expect(service.submitWork(choice, '再次检查', { ...base, idempotencySeed: 'unsafe-1', authorizedBusinessCapabilityIds: ['write'], continuation: { ...continuation, restartAfterFailedRun: true } })).rejects.toThrow('先核对 Forge 结果')
    expect(registrations).toHaveLength(2)
  })

  it('treats a registration version conflict as a definite rejection without dispatching', async () => {
    let dispatched = false
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: workOverviewFetch((url) => {
      if (url.endsWith('/v1/workbench/dispatch-inputs')) return Response.json({ code: 'input_revision_conflict', error: 'current dispatch input revision changed' }, { status: 409 })
      if (url.endsWith('/v1/teams/team-1/dispatch')) dispatched = true
      return undefined
    }) })
    await signInAs(service, 'sales@example.test')
    const source = {
      idempotencySeed: 'same-intent', sessionKey: 'session', accountKey: await service.accountKey(),
      sourceMessages: [{ messageId: 'message-1', eventSeq: 1, sha256: 'a'.repeat(64) }], resources: [], authorizedBusinessCapabilityIds: [],
      continuation: { workbenchSessionID: 'original-session', inputRevisionID: '550e8400-e29b-41d4-a716-446655440000', runID: 'failed-run', teamID: 'team-1' },
      assertCurrent: async () => {}, fixDelegationIntent: fixedSource(await service.accountKey()).fixDelegationIntent,
    }
    await expect(service.submitWork({ teamId: 'team-1', teamName: '团队', workflowId: 'flow-1', workflowName: '流程', businessCapabilityIds: [], version: 1 }, '重新检查', source)).rejects.toBeInstanceOf(WorkRegistrationRejectedError)
    expect(dispatched).toBe(false)
  })

  it.each([{ code: 'dispatch_input_too_many_resources' }, { error: { code: 'dispatch_input_too_many_resources' } }])('recognizes a resource-count rejection without dispatching: %j', async (body) => {
    let dispatched = false
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: workOverviewFetch((url) => {
      if (url.endsWith('/v1/workbench/dispatch-inputs')) return Response.json(body, { status: 409 })
      if (url.endsWith('/v1/teams/team-1/dispatch')) dispatched = true
      return undefined
    }) })
    await signInAs(service, 'employee@example.test')
    await expect(service.submitWork({ teamId: 'team-1', teamName: '团队', workflowId: 'flow-1', workflowName: '流程', businessCapabilityIds: [], version: 1 }, '检查材料', fixedSource(await service.accountKey()))).rejects.toThrow('最多允许 10 份材料')
    expect(dispatched).toBe(false)
  })

  it('explains an unchecked action flow to the employee before any task grant or dispatch', async () => {
    let dispatched = false, registered = false
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: workOverviewFetch((url) => {
      if (url.endsWith('/v1/workbench/dispatch-inputs/prepare')) return Response.json({ code: 'business_completion_check_required', error: '流程成员绑定了业务动作，须先声明检查' }, { status: 422 })
      if (url.endsWith('/v1/workbench/dispatch-inputs')) registered = true
      if (url.endsWith('/v1/teams/team-1/dispatch')) dispatched = true
      return undefined
    }) })
    await signInAs(service, 'employee@example.test')
    const rejected = service.submitWork({ teamId: 'team-1', teamName: '团队', workflowId: 'flow-1', workflowName: '流程', businessCapabilityIds: ['forge:action:crm_lead.convert'], version: 1 }, '转化线索', fixedSource(await service.accountKey()))
    await expect(rejected).rejects.toBeInstanceOf(WorkRegistrationRejectedError)
    await expect(rejected).rejects.toThrow('暂不能授权团队办理业务动作')
    expect(registered || dispatched).toBe(false)
  })

  it('loads native Forge approvals and refuses unversioned legacy decisions or native resubmit', async () => {
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = []
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input), method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
      calls.push({ url, method, body })
      if (url.endsWith('/__test/approving-account')) return Response.json({ token: 'forge-token', user: { id: 'sales-1', email: 'sales@example.test', name: 'Sales' } })
      if (url.endsWith('/v1/auth/external/exchange')) return Response.json({ token: 'weave-token', subject: { id: 'weave-sales-1', externalId: 'sales-1' }, organization: { id: 'default' }, issuer: 'forge:test-deployment', permissions: ['teams:use'] })
      if (url.includes('/v1/teams?status=active')) return Response.json([])
      if (url.includes('/v1/runs?project_id=')) return Response.json({ runs: [] })
      if (url.endsWith('/v1/human-tasks?limit=50')) return Response.json({ tasks: [] })
      if (url.endsWith('/api/v1/apps/forge/workbench/inbox?limit=100')) return notificationResponse({ notifications: [] })
      if (url.endsWith('/api/v1/workbench/approvals?limit=100&includeSubmitted=1')) return Response.json({ version: '1', items: [
        { requestId: 'approval-1', title: '销售合同复核 · 财务复核', mode: 'approval', updatedAt: '2026-09-22T08:00:00Z', stepLabel: '财务复核' },
        { requestId: 'approval-2', title: '销售合同需要修改', mode: 'revision', updatedAt: '2026-09-22T09:00:00Z', returnReason: '请补齐附件' },
      ] })
      if (url.endsWith('/api/v1/approvals/requests/approval-2/actions')) return Response.json({ data: [{ action: 'submit' }, { action: 'revise', comment: '请补齐附件' }] })
      if (url.endsWith('/api/v1/approvals/requests/approval-1/revise')) return Response.json({ status: 'returned' })
      return Response.json({}, { status: 404 })
    }) as typeof fetch
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
    await signInAs(service, 'sales@example.test')

    const overview = await service.getWorkOverview()
    expect(overview.tasks).toMatchObject([
      { interactionId: 'approval-1', runId: 'forge:approval:approval-1', source: 'forge', mode: 'approval' },
      { interactionId: 'approval-2', runId: 'forge:revision:approval-2', source: 'forge', mode: 'revision', instructions: '退回原因：请补齐附件' },
    ])
    await expect(service.completeHumanTask(overview.tasks[0], { decision: 'rejected', comment: '请补充付款条件' })).rejects.toThrow()
    await expect(service.completeHumanTask(overview.tasks[1], { decision: 'approved', comment: '已补充' })).rejects.toThrow('Forge 修订材料递交业务动作尚未接通')
    expect(calls.some((call) => call.url.endsWith('/approval-1/revise'))).toBe(false)
    expect(calls.some((call) => call.url.endsWith('/approval-2/resubmit'))).toBe(false)
  })


  it('follows Forge current approval projection and preserves its latest return reason', async () => {
    let returned = false
    const fetchMock = workOverviewFetch((url) => {
      if (url.includes('/v1/teams?')) return Response.json([])
      if (url.includes('/v1/runs?')) return Response.json({ runs: [] })
      if (url.includes('/api/v1/apps/forge/workbench/inbox?')) return notificationResponse({ notifications: [] })
      if (url.includes('/api/v1/workbench/approvals?')) return Response.json({ version: '1', items: returned ? [{ requestId: 'approval-returned', title: '测试合同需要修改', mode: 'revision', updatedAt: '2026-10-01T00:00:00Z', returnReason: '第二轮仍需补材料' }] : [] })
      return undefined
    })
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
    await signInAs(service, 'sales@example.test')
    await expect(service.getWorkOverview()).resolves.toMatchObject({ tasks: [] })
    returned = true
    await expect(service.getWorkOverview()).resolves.toMatchObject({ tasks: [{ interactionId: 'approval-returned', mode: 'revision', instructions: '退回原因：第二轮仍需补材料' }] })
    expect(vi.mocked(fetchMock).mock.calls.some(([input]) => String(input).includes('/approvals/requests/'))).toBe(false)
  })

  it('keeps run progress visible but cannot expose human tasks while the native inbox is unavailable', async () => {
    const fetchMock = workOverviewFetch((url) => {
      if (url.endsWith('/v1/teams?status=active')) return Response.json({ teams: [] })
      if (url.includes('/v1/runs?project_id=')) return Response.json({ runs: [{ run_id: 'run-weave', status: 'running' }] })
      if (url.endsWith('/v1/human-tasks?limit=50')) return Response.json({ tasks: [{ interaction_id: 'task-weave', run_id: 'run-weave', team_id: 'team-1', workflow_id: 'flow-1', workflow_version: 1, title: '团队检查', instructions: '补充产品范围', updated_at: '2026-09-23T01:00:00Z' }] })
      if (url.endsWith('/api/v1/apps/forge/workbench/inbox?limit=100')) return Response.json({}, { status: 503 })
      if (url.endsWith('/api/v1/workbench/approvals?limit=100&includeSubmitted=1')) return Response.json({}, { status: 404 })
      return undefined
    })
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
    await signInAs(service, 'employee@example.test')

    const overview = await service.getWorkOverview()
    expect(overview.runs).toMatchObject([{ id: 'run-weave' }])
    expect(overview.tasks).toEqual([])
    expect(vi.mocked(fetchMock).mock.calls.some(([input]) => String(input).includes('/v1/human-tasks?'))).toBe(false)
    expect(overview.reads).toMatchObject({ runs: { status: 'loaded' }, weaveTasks: { status: 'failed' }, forgeApprovals: { status: 'failed', error: expect.stringContaining('404') }, notifications: { status: 'failed', error: expect.stringContaining('503') } })
  })

  it('keeps the signed-in employee’s Forge approval visible when Weave reads fail', async () => {
    const fetchMock = workOverviewFetch((url) => {
      if (url.startsWith('http://weave/')) return Response.json({}, { status: 503 })
      if (url.endsWith('/api/v1/apps/forge/workbench/inbox?limit=100')) return notificationResponse({ notifications: [{ id: 'notice-forge', type: 'business.result', title: '业务结果', read: false, createdAt: '2026-09-23T01:00:00Z' }] })
      if (url.endsWith('/api/v1/workbench/approvals?limit=100&includeSubmitted=1')) return Response.json({ version: '1', items: [
        { requestId: 'approval-own', title: '当前员工合同 · 交付复核', mode: 'approval', updatedAt: '2026-09-23T01:00:00Z' },
      ] })
      return undefined
    })
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
    await signInAs(service, 'employee@example.test')

    const overview = await service.getWorkOverview()
    expect(overview.tasks).toMatchObject([{ interactionId: 'approval-own', title: '当前员工合同 · 交付复核', source: 'forge', mode: 'approval' }])
    expect(overview.tasks.some((task) => task.interactionId === 'approval-other')).toBe(false)
    expect(overview.items).toMatchObject([{ id: 'notice-forge' }])
    expect(overview.reads).toMatchObject({ runs: { status: 'failed' }, teamChoices: { status: 'failed' }, weaveTasks: { status: 'loaded' }, forgeApprovals: { status: 'loaded' }, notifications: { status: 'loaded' } })
  })

  it('clears a source error after a refresh reads that source successfully', async () => {
    let forgeAvailable = false
    const fetchMock = workOverviewFetch((url) => {
      if (url.endsWith('/v1/teams?status=active')) return Response.json({ teams: [] })
      if (url.includes('/v1/runs?project_id=')) return Response.json({ runs: [] })
      if (url.endsWith('/v1/human-tasks?limit=50')) return Response.json({ tasks: [] })
      if (url.endsWith('/api/v1/apps/forge/workbench/inbox?limit=100')) return forgeAvailable ? notificationResponse({ notifications: [{ id: 'notice-recovered', type: 'business.result', title: '恢复后的消息', read: false, createdAt: '2026-09-23T01:00:00Z' }] }) : Response.json({}, { status: 503 })
      if (url.endsWith('/api/v1/workbench/approvals?limit=100&includeSubmitted=1')) return Response.json({ version: '1', items: [] })
      return undefined
    })
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
    await signInAs(service, 'employee@example.test')

    const failed = await service.getWorkOverview()
    expect(failed.reads.notifications).toMatchObject({ status: 'failed' })
    expect(failed.items).toEqual([])
    forgeAvailable = true
    const recovered = await service.getWorkOverview()
    expect(recovered.reads.notifications).toEqual({ status: 'loaded' })
    expect(recovered.items).toMatchObject([{ id: 'notice-recovered' }])
  })

  it('does not treat reading a work message as completing the underlying item', async () => {
    const fetchMock = workOverviewFetch((url) => {
      if (url.endsWith('/v1/teams?status=active')) return Response.json({ teams: [] })
      if (url.includes('/v1/runs?project_id=')) return Response.json({ runs: [] })
      if (url.endsWith('/v1/human-tasks?limit=50')) return Response.json({ tasks: [] })
      if (url.endsWith('/api/v1/apps/forge/workbench/inbox?limit=100')) return notificationResponse({ notifications: [
        { id: 'notice-read', type: 'business.result', title: '合同状态更新', read: true, createdAt: '2026-09-24T01:00:00Z' },
      ] })
      if (url.endsWith('/api/v1/workbench/approvals?limit=100&includeSubmitted=1')) return Response.json({ version: '1', items: [] })
      return undefined
    })
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
    await signInAs(service, 'employee@example.test')

    await expect(service.getWorkOverview()).resolves.toMatchObject({ items: [{ id: 'notice-read', read: true, status: 'unknown' }] })
  })

  it('fetches an exact Weave continuation and compares all notification references', async () => {
    const task = '请对照已固定的技术协议检查合同。'
    const result = '团队建议补充验收日期。'
    const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
    const payload = {
      version: '1',
      source: { input_revision_id: '10000000-0000-4000-8000-000000000001', run_id: 'run-1', workbench_session_id: 'workbench-session-1' },
      input: {
        task, task_sha256: sha256(task), team_id: 'team-1', workflow_id: 'flow-1', workflow_version: 2,
        materials: [], source_messages: [{ message_id: 'employee-message', event_seq: 1, sha256: sha256('员工要求').toUpperCase() }],
      },
      run: { status: 'succeeded', final_result: { id: 'deliverable-1', title: '团队检查结果', content_type: 'text/markdown', content: result, sha256: sha256(result), disposition: 'needs_input', summary: '已核对🧭', missing_items: ['验收日期'] } },
    }
    const calls: Array<{ url: string; headers: Headers }> = []
    const fetchMock = workOverviewFetch((url, init) => {
      if (url.endsWith('/workbench-context')) {
        calls.push({ url, headers: new Headers(init?.headers) })
        return Response.json(payload)
      }
      return undefined
    })
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
    await signInAs(service, 'employee@example.test')
    const references = { workReference: payload.source.input_revision_id, runReference: 'run-1', sessionReference: 'workbench-session-1' }

    await expect(service.getWorkContinuationContext(references)).resolves.toMatchObject({
      source: { inputRevisionID: references.workReference, runID: references.runReference, workbenchSessionID: references.sessionReference },
      input: { task, teamID: 'team-1', workflowID: 'flow-1', workflowVersion: 2, sourceMessages: [{ sha256: sha256('员工要求').toUpperCase() }] },
      run: { status: 'succeeded', finalResult: { title: '团队检查结果', content: result, disposition: 'needs_input', summary: '已核对🧭', missingItems: ['验收日期'] } },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('http://weave/v1/runs/run-1/workbench-context')
    expect(calls[0]?.headers.get('Authorization')).toBe('Bearer weave-token-employee@example.test')

    for (const businessResult of ['completed', 'needs_input', 'action_failed', 'action_unknown']) {
      Object.assign(payload.run, { business_result: businessResult })
      await expect(service.getWorkContinuationContext(references)).resolves.toMatchObject({ run: { businessResult, finalResult: { disposition: 'needs_input' } } })
    }
    Object.assign(payload.run, { business_result: 'invalid' })
    await expect(service.getWorkContinuationContext(references)).rejects.toThrow('团队业务结果格式无效')
    Object.assign(payload.run, { business_result: undefined })
    expect((await service.getWorkContinuationContext(references)).run.businessResult).toBeUndefined()

    const originalFinalResult = structuredClone(payload.run.final_result)
    payload.run.final_result.summary = '🧭'.repeat(1000)
    await expect(service.getWorkContinuationContext(references)).resolves.toMatchObject({ run: { finalResult: { summary: '🧭'.repeat(1000) } } })
    // A summary or a missing item of any length is kept whole; only a blank one is refused.
    payload.run.final_result.summary = '🧭'.repeat(5000)
    await expect(service.getWorkContinuationContext(references)).resolves.toMatchObject({ run: { finalResult: { summary: '🧭'.repeat(5000) } } })
    payload.run.final_result.summary = ' '
    await expect(service.getWorkContinuationContext(references)).rejects.toThrow('团队结果分类格式无效')
    payload.run.final_result.summary = originalFinalResult.summary
    payload.run.final_result.missing_items = Array.from({ length: 12 }, (_, index) => `第${index + 1}项：` + '缺少盖章页。'.repeat(60))
    await expect(service.getWorkContinuationContext(references)).resolves.toMatchObject({ run: { finalResult: { missingItems: payload.run.final_result.missing_items } } })
    payload.run.final_result.missing_items = ['验收日期', ' ']
    await expect(service.getWorkContinuationContext(references)).rejects.toThrow('团队结果分类格式无效')
    payload.run.final_result.missing_items = originalFinalResult.missing_items
    payload.run.final_result = { ...originalFinalResult, missing_items: [] }
    await expect(service.getWorkContinuationContext(references)).rejects.toThrow('团队结果分类格式无效')
    payload.run.final_result = { ...originalFinalResult, disposition: undefined as unknown as 'needs_input' }
    await expect(service.getWorkContinuationContext(references)).rejects.toThrow('团队结果分类格式无效')
    payload.run.final_result = { ...originalFinalResult, disposition: 'complete', missing_items: ['验收日期'] }
    await expect(service.getWorkContinuationContext(references)).rejects.toThrow('团队结果分类格式无效')
    payload.run.final_result = { ...originalFinalResult, disposition: 'complete', missing_items: [] }
    await expect(service.getWorkContinuationContext(references)).resolves.toMatchObject({ run: { finalResult: { disposition: 'complete', missingItems: [] } } })
    payload.run.final_result = originalFinalResult

    await expect(service.getWorkContinuationContext({ ...references, workReference: '10000000-0000-4000-8000-000000000002' })).rejects.toThrow('工作消息与原团队工作不匹配')
    await expect(service.getWorkContinuationContext({ ...references, runReference: 'run-other' })).rejects.toThrow('工作消息与原团队工作不匹配')
    await expect(service.getWorkContinuationContext({ ...references, sessionReference: 'another-session' })).rejects.toThrow('工作消息与原团队工作不匹配')
  })

  it('reads more than eight small frozen material references within the byte budgets', async () => {
    const task = '按固定输入继续核对。'
    const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
    const files = Array.from({ length: 9 }, (_, index) => {
      const content = `第 ${index + 1} 份小材料`
      const name = `附件-${index + 1}.txt`
      const id = `forge-text-${index + 1}`
      return {
        id, name, mediaType: 'text/plain', bytes: Buffer.byteLength(content), sha256: sha256(content),
        materialId: digest(JSON.stringify([name, 'text/plain', sha256(content)])).slice(0, 24), content,
      }
    })
    const payload = {
      version: '1',
      source: { input_revision_id: '10000000-0000-4000-8000-000000000001', run_id: 'run-nine-files', workbench_session_id: 'workbench-session-nine-files' },
      input: {
        task, task_sha256: sha256(task), team_id: 'team-1', workflow_id: 'flow-1', workflow_version: 2,
        materials: files.map(({ id, name, mediaType, bytes, sha256: hash, materialId }) => ({
          type: 'forge-file', id, name, mediaType, bytes, sha256: hash, materialId,
        })),
        source_messages: [{ message_id: 'employee-message', event_seq: 1, sha256: sha256('员工要求') }],
      },
      run: { status: 'succeeded' },
    }
    const fetchMock = workOverviewFetch((url) => {
      if (url.endsWith('/workbench-context')) return Response.json(payload)
      const file = files.find((item) => url.endsWith(`/api/v1/workbench/materials/${item.id}`))
      if (file) return Response.json({
        version: '1', fileId: file.id, name: file.name, mediaType: 'text/plain; charset=utf-8',
        bytes: file.bytes, sha256: file.sha256, content: file.content,
      })
      return undefined
    })
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
    await signInAs(service, 'employee@example.test')

    const continuation = await service.getWorkContinuationContext({
      workReference: payload.source.input_revision_id, runReference: payload.source.run_id,
      sessionReference: payload.source.workbench_session_id,
    })
    expect(continuation.input.materials).toHaveLength(9)
    expect(continuation.input.materials.map(({ name }) => name)).toEqual(files.map(({ name }) => name))
  })

  it('reads a missing Weave source only through the current Forge-owned notification endpoint', async () => {
    let body: Record<string, unknown> = {
      version: '1', notificationId: 'native-notice-1', kind: 'revision_required',
      source: { system: 'weave', workReference: 'input-1', runReference: 'run-1', sessionReference: 'workbench-session-1' },
    }
    const calls: Array<{ url: string; auth?: string }> = []
    const fetchMock = workOverviewFetch((url, init) => {
      if (url.endsWith('/api/v1/workbench/notifications/native-notice-1/source')) {
        calls.push({ url, auth: new Headers(init?.headers).get('Authorization') ?? undefined })
        return Response.json(body)
      }
      return undefined
    })
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
    await signInAs(service, 'employee@example.test')

    await expect(service.getWorkNotificationSource('native-notice-1')).resolves.toMatchObject({
      notificationID: 'native-notice-1', kind: 'revision_required', source: { workReference: 'input-1', runReference: 'run-1', sessionReference: 'workbench-session-1' },
    })
    expect(calls[0]).toMatchObject({ url: 'http://forge/api/v1/workbench/notifications/native-notice-1/source', auth: 'Bearer forge-token-employee@example.test' })
    body = { ...body, notificationId: 'another-notice' }
    await expect(service.getWorkNotificationSource('native-notice-1')).rejects.toThrow('工作消息来源与当前消息不匹配')
  })

  it('reads a Forge business result by native source, current record, and its authorized historical originals', async () => {
    const sourceBytes = await readFile(new URL('../fixtures/materials/sample-two-page.pdf', import.meta.url))
    const sha256 = createHash('sha256').update(sourceBytes).digest('hex')
    let materialStatus: 'available' | 'none' | 'unavailable' = 'available'
    const calls: string[] = []
    const sourceResponse = () => Response.json({
      version: '1', notificationId: 'business-notice', kind: 'business',
      source: { system: 'forge', objectName: 'forge_sales_contract', recordId: 'contract-current' },
      materialStatus,
      originalFiles: materialStatus === 'available' ? [{
        sourceKind: 'approval', requestId: 'approval-history-1', fileId: 'history-file-1', name: '当前批准合同.pdf',
        mediaType: 'application/pdf', bytes: sourceBytes.length, sha256,
      }] : [],
    })
    const fetchMock = workOverviewFetch((url, init) => {
      calls.push(url)
      if (url.endsWith('/api/v1/workbench/notifications/business-notice/source')) return sourceResponse()
      if (url.endsWith('/api/v1/approvals/requests/approval-history-1/workbench-history/files/history-file-1/original')) {
        expect(new Headers(init?.headers).get('if-match')).toBe(`"${sha256}"`)
        return new Response(Uint8Array.from(sourceBytes), { status: 200, headers: {
          'Content-Type': 'application/pdf', 'Content-Length': String(sourceBytes.length), ETag: `"${sha256}"`,
          'X-Content-SHA256': sha256, 'Cache-Control': 'private, no-store',
        } })
      }
      return undefined
    })
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
    await signInAs(service, 'employee@example.test')
    const record: BusinessRecordRead = {
      candidate: { objectName: 'forge_sales_contract', objectLabel: '销售合同', recordId: 'contract-current', name: '设备验收合同', code: 'C-100', status: '内部复核通过' },
      snapshot: {
        version: 1, capturedAt: '2026-09-30T01:00:00Z', objectLabel: '销售合同',
        record: [{ label: '合同名称', value: '设备验收合同' }, { label: '状态', value: '内部复核通过' }],
        relations: [], completeness: 'complete', pricingDetailCompleteness: 'unknown', completenessNotes: [],
      },
    }
    const readCurrentRecord = vi.spyOn(service, 'readBusinessRecord').mockResolvedValue(record)

    const context = await service.getBusinessNotificationContext('business-notice')
    expect(context).toMatchObject({
      kind: 'business', notificationID: 'business-notice', source: { system: 'forge', objectName: 'forge_sales_contract', recordId: 'contract-current' },
      materialStatus: 'available', record: { candidate: { status: '内部复核通过' } },
      materials: [{ sourceKind: 'approval', requestId: 'approval-history-1', name: '当前批准合同.pdf', extraction: { sourceSha256: sha256 } }],
    })
    expect(readCurrentRecord).toHaveBeenCalledWith('forge_sales_contract', 'contract-current')
    expect(calls.filter((url) => url.includes('/workbench-history/files/'))).toHaveLength(1)
    expect(calls.some((url) => url.includes('/workbench-context/files/'))).toBe(false)

    materialStatus = 'unavailable'
    calls.length = 0
    const unavailable = await service.getBusinessNotificationContext('business-notice')
    expect(unavailable).toMatchObject({ materialStatus: 'unavailable', materials: [] })
    expect(calls.some((url) => url.includes('/files/'))).toBe(false)
  })

  it('reads original work files through the owner-only Forge route and verifies the Weave material tuple', async () => {
    const task = '检查这份原工作材料。', content = '原工作材料正文\n'
    const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
    const material = { type: 'forge-file', id: '10000000-0000-4000-8000-000000000002', name: '技术协议.txt', bytes: Buffer.byteLength(content), sha256: sha256(content) }
    const payload = {
      version: '1',
      source: { input_revision_id: '10000000-0000-4000-8000-000000000001', run_id: 'run-1', workbench_session_id: 'workbench-session-1' },
      input: {
        task, task_sha256: sha256(task), team_id: 'team-1', workflow_id: 'flow-1', workflow_version: 2,
        materials: [material], source_messages: [{ message_id: 'employee-message', event_seq: 1, sha256: sha256('员工要求') }],
      },
      run: { status: 'succeeded' },
    }
    const calls: Array<{ url: string; auth?: string }> = []
    let forgeDigest = material.sha256
    let fileReadStatus = 200
    const fetchMock = workOverviewFetch((url, init) => {
      calls.push({ url, auth: new Headers(init?.headers).get('Authorization') ?? undefined })
      if (url.endsWith('/workbench-context')) return Response.json(payload)
      if (url.endsWith(`/api/v1/workbench/materials/${material.id}`)) return fileReadStatus === 200 ? Response.json({
          version: '1', fileId: material.id, name: material.name, mediaType: 'text/plain; charset=utf-8',
          bytes: Buffer.byteLength(content), sha256: forgeDigest, content,
        }) : Response.json({ error: { code: 'WORKBENCH_MATERIAL_NOT_FOUND' } }, { status: fileReadStatus })
      return undefined
    })
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
    await signInAs(service, 'employee@example.test')
    const references = { workReference: payload.source.input_revision_id, runReference: 'run-1', sessionReference: 'workbench-session-1' }

    await expect(service.getWorkContinuationContext(references)).resolves.toMatchObject({ input: { materials: [{ id: material.id, content }] } })
    expect(calls).toMatchObject([
      { url: 'http://weave/v1/runs/run-1/workbench-context', auth: 'Bearer weave-token-employee@example.test' },
      { url: `http://forge/api/v1/workbench/materials/${material.id}`, auth: 'Bearer forge-token-employee@example.test' },
    ])
    forgeDigest = sha256('different bytes')
    await expect(service.getWorkContinuationContext(references)).rejects.toThrow('原工作材料与固定输入不一致')
    forgeDigest = material.sha256
    fileReadStatus = 404
    await expect(service.getWorkContinuationContext(references)).rejects.toThrow('原工作材料读取失败（404）')
  })

  it.each([
    { label: 'CSV', name: '合同清单.csv', inputMediaType: 'text/csv', responseMediaType: 'text/csv; charset=utf-8', content: '编号,名称\n001,合同' },
    { label: 'JSON', name: '合同数据.json', inputMediaType: 'application/json', responseMediaType: 'application/json; charset=utf-8', content: '{"contract":"北辰"}' },
    { label: 'Markdown', name: '合同说明.md', inputMediaType: 'text/markdown', responseMediaType: 'text/markdown', content: '# 合同说明\n正文' },
  ])('reads original work $label through the owner-only Forge route', async ({ name, inputMediaType, responseMediaType, content }) => {
    const task = '继续读取原工作中的文本材料。'
    const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
    const material = {
      type: 'forge-file', id: '10000000-0000-4000-8000-000000000002', name,
      mediaType: inputMediaType, bytes: Buffer.byteLength(content), sha256: sha256(content),
    }
    const payload = {
      version: '1',
      source: { input_revision_id: '10000000-0000-4000-8000-000000000001', run_id: 'run-text-original', workbench_session_id: 'workbench-session-text-original' },
      input: {
        task, task_sha256: sha256(task), team_id: 'team-1', workflow_id: 'flow-1', workflow_version: 2,
        materials: [material], source_messages: [{ message_id: 'employee-message', event_seq: 1, sha256: sha256('员工原始要求') }],
      },
      run: { status: 'succeeded' },
    }
    const calls: Array<{ url: string; auth?: string }> = []
    const fetchMock = workOverviewFetch((url, init) => {
      calls.push({ url, auth: new Headers(init?.headers).get('Authorization') ?? undefined })
      if (url.endsWith('/workbench-context')) return Response.json(payload)
      if (url.endsWith(`/api/v1/workbench/materials/${material.id}`)) return Response.json({
        version: '1', fileId: material.id, name, mediaType: responseMediaType,
        bytes: material.bytes, sha256: material.sha256, content,
      })
      return undefined
    })
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
    await signInAs(service, 'employee@example.test')
    const references = { workReference: payload.source.input_revision_id, runReference: 'run-text-original', sessionReference: 'workbench-session-text-original' }

    await expect(service.getWorkContinuationContext(references)).resolves.toMatchObject({
      input: { materials: [{ id: material.id, name, mediaType: inputMediaType, bytes: material.bytes, sha256: material.sha256, content }] },
    })
    expect(calls).toMatchObject([
      { url: 'http://weave/v1/runs/run-text-original/workbench-context', auth: 'Bearer weave-token-employee@example.test' },
      { url: `http://forge/api/v1/workbench/materials/${material.id}`, auth: 'Bearer forge-token-employee@example.test' },
    ])
  })

  it('continues PDF and DOCX using only their frozen owner or approval source route', async () => {
    const task = '复核原工作中冻结的二进制材料。'
    const ownerBytes = await readFile(new URL('../fixtures/materials/sample-two-page.pdf', import.meta.url))
    const approvalBytes = await readFile(new URL('../fixtures/materials/sample-paragraphs-table.docx', import.meta.url))
    const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
    const ownerMaterial = {
      type: 'forge-file', materialId: digest('owner-material').slice(0, 24), sourceKind: 'owner',
      id: 'owner-pdf', name: 'owner.pdf', mediaType: 'application/pdf', bytes: ownerBytes.length, sha256: sha256(ownerBytes),
    }
    const approvalMaterials = Array.from({ length: 11 }, (_, index) => ({
      type: 'forge-file', materialId: digest(`approval-material-${index}`).slice(0, 24), sourceKind: 'approval', requestId: 'approval-source-1',
      id: `approval-docx-${index + 1}`, name: `approval-${index + 1}.docx`, mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes: approvalBytes.length, sha256: sha256(approvalBytes),
    }))
    const shaOfTask = sha256(task)
    const payload = {
      version: '1',
      source: { input_revision_id: '10000000-0000-4000-8000-000000000001', run_id: 'run-originals', workbench_session_id: 'workbench-session-originals' },
      input: {
        task, task_sha256: shaOfTask, team_id: 'team-1', workflow_id: 'flow-1', workflow_version: 2,
        materials: [ownerMaterial, ...approvalMaterials],
        source_messages: [{ message_id: 'employee-message', event_seq: 1, sha256: sha256('员工要求') }],
      },
      run: { status: 'succeeded' },
    }
    const calls: Array<{ url: string; headers: Headers }> = []
    let denyOwner = false
    const response = (bytes: Buffer, mediaType: string, digest: string) => new Response(Uint8Array.from(bytes), { status: 200, headers: {
      'Content-Type': mediaType, 'Content-Length': String(bytes.length), ETag: `"${digest}"`,
      'X-Content-SHA256': digest, 'Cache-Control': 'private, no-store',
    } })
    const fetchMock = workOverviewFetch((url, init) => {
      calls.push({ url, headers: new Headers(init?.headers) })
      if (url.endsWith('/workbench-context')) return Response.json(payload)
      if (url.endsWith('/api/v1/workbench/materials/owner-pdf/original')) return denyOwner
        ? Response.json({ error: { code: 'WORKBENCH_MATERIAL_NOT_FOUND' } }, { status: 404 })
        : response(ownerBytes, 'application/pdf', ownerMaterial.sha256)
      if (url.startsWith('http://forge/api/v1/approvals/requests/approval-source-1/workbench-history/files/')) {
        const material = approvalMaterials.find((item) => url.endsWith(`/workbench-history/files/${item.id}/original`))
        if (material) return response(approvalBytes, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', material.sha256)
      }
      return undefined
    })
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
    await signInAs(service, 'employee@example.test')
    const references = { workReference: payload.source.input_revision_id, runReference: 'run-originals', sessionReference: 'workbench-session-originals' }

    const context = await service.getWorkContinuationContext(references)
    expect(context.input.materials).toHaveLength(12)
    expect(context.input.materials[0]).toMatchObject({ materialId: ownerMaterial.materialId, sourceKind: 'owner', mediaType: 'application/pdf', sha256: ownerMaterial.sha256, extraction: { sourceSha256: ownerMaterial.sha256, status: 'partial' } })
    expect(context.input.materials.slice(1)).toHaveLength(11)
    expect(context.input.materials.slice(1).every((material, index) => material.materialId === approvalMaterials[index]?.materialId
      && material.sourceKind === 'approval' && material.requestId === 'approval-source-1'
      && material.extraction?.sourceSha256 === approvalMaterials[index]?.sha256 && material.extraction.status === 'complete')).toBe(true)
    expect(context.input.materials[0]?.content).toContain('PDF PAGE 1: byte exact original.')
    expect(context.input.materials[1]?.content).toContain('DOCX 第一段：原件字节保持不变。')
    expect(calls.find((call) => call.url.endsWith('/owner-pdf/original'))?.headers.get('if-match')).toBe(`"${ownerMaterial.sha256}"`)
    for (const material of approvalMaterials) {
      const call = calls.find((item) => item.url.endsWith(`/workbench-history/files/${material.id}/original`))
      expect(call?.headers.get('if-match')).toBe(`"${material.sha256}"`)
    }
    expect(calls.filter((call) => call.url.includes('/workbench-history/files/'))).toHaveLength(11)
    expect(calls.some((call) => call.url.includes('/workbench-context/files/') && call.url.endsWith('/original'))).toBe(false)
    expect(calls.some((call) => call.url === 'http://forge/api/v1/workbench/materials/owner-pdf')).toBe(false)
    expect(calls.some((call) => call.url === 'http://forge/api/v1/workbench/materials/approval-docx')).toBe(false)

    denyOwner = true
    const originalRouteCount = calls.filter((call) => call.url.endsWith('/owner-pdf/original')).length
    await expect(service.getWorkContinuationContext(references)).rejects.toThrow('原工作原件不属于当前员工')
    expect(calls.filter((call) => call.url.endsWith('/owner-pdf/original'))).toHaveLength(originalRouteCount + 1)
    expect(calls.some((call) => call.url === 'http://forge/api/v1/workbench/materials/owner-pdf')).toBe(false)
  })

  it('discards an in-flight overview when the signed-in account changes', async () => {
    const oldRun = deferred<Response>(), oldRunStarted = deferred<void>()
    const fetchMock = workOverviewFetch((url, init) => {
      const auth = new Headers(init?.headers).get('Authorization')
      if (url.includes('/v1/runs?project_id=') && auth === 'Bearer weave-token-a@example.test') { oldRunStarted.resolve(); return oldRun.promise }
      if (url.endsWith('/v1/teams?status=active')) return Response.json({ teams: [] })
      if (url.includes('/v1/runs?project_id=')) return Response.json({ runs: [] })
      if (url.endsWith('/v1/human-tasks?limit=50')) return Response.json({ tasks: [] })
      if (url.endsWith('/api/v1/apps/forge/workbench/inbox?limit=100')) return notificationResponse({ notifications: [] })
      if (url.endsWith('/api/v1/workbench/approvals?limit=100&includeSubmitted=1')) return Response.json({ version: '1', items: [] })
      return undefined
    })
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
    await signInAs(service, 'a@example.test')
    const oldOverview = service.getWorkOverview()
    await oldRunStarted.promise
    await signInAs(service, 'b@example.test')
    oldRun.resolve(Response.json({ runs: [{ run_id: 'run-from-a', status: 'running' }] }))

    await expect(oldOverview).rejects.toThrow('账号已切换')
    await expect(service.getSession()).resolves.toMatchObject({ status: 'signed-in', user: { id: 'b@example.test' } })
  })

  it('maps only the bounded Forge approval context and rejects changed file bytes', async () => {
    const original = '# 合同\n仅供验收\n'
    const digest = createHash('sha256').update(original).digest('hex')
    const attachment = '# 技术协议\n验收标准\n'
    const attachmentDigest = createHash('sha256').update(attachment).digest('hex')
    const sourceMaterialVersion = createHash('sha256').update('source-v1').digest('hex')
    let actionRecordId = 'contract-1'
    let actionInputName = 'comment'
    let fileContent = original
    const orderRecallAction = {
      semantic: 'recall', label: '撤回订单审批', description: '撤回本人提交且仍待审批的销售订单。',
      execution: { tool: 'run_action', actionName: 'order_approval_mcp_recall', objectName: 'forge_sales_order', recordId: 'order-1', params: { approvalRequestId: 'approval-3', itemVersion: 'native-order-item-1', sourceMaterialVersion } },
      inputs: [{ name: 'comment', type: 'string', label: '撤回原因', required: true }],
    }
    const orderApproveAction = {
      ...orderRecallAction, semantic: 'approve', label: '同意订单复核',
      execution: { ...orderRecallAction.execution, actionName: 'order_approval_mcp_approve', params: { ...orderRecallAction.execution.params, approvalRequestId: 'approval-5' } },
    }
    const calls: string[] = []
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input); calls.push(url)
      if (url.endsWith('/__test/approving-account')) return Response.json({ token: 'forge-token', user: { id: 'reviewer-1' } })
      if (url.endsWith('/v1/auth/external/exchange')) return Response.json({ token: 'weave-token', subject: { id: 'weave-reviewer-1', externalId: 'reviewer-1' }, organization: { id: 'default' }, issuer: 'forge:test-deployment', permissions: ['teams:use'] })
      if (url.endsWith('/api/v1/approvals/requests/approval-1/workbench-context')) return Response.json({
        version: '1', requestId: 'approval-1', status: 'pending', viewer: 'current_approver',
        title: '设备验收合同', step: '交付复核', fields: [{ label: '合同名称', value: '设备验收合同' }],
        businessObject: { objectName: 'forge_sales_contract', recordId: 'contract-1', recordName: '设备验收合同' }, sourceMaterialVersion,
        availableActions: [{
          semantic: 'opaque server hint', label: '当前可办理事项', description: '办理当前员工可执行的事项。',
          execution: { tool: 'run_action', actionName: 'forge_action_from_metadata', objectName: 'forge_sales_contract', recordId: actionRecordId, params: { approvalRequestId: 'approval-1', itemVersion: 'native-item-round-3', sourceMaterialVersion } },
          inputs: [{ name: actionInputName, type: 'string', label: '办理意见', required: true }],
        }],
        files: [
          { fileId: 'approval-file-1', name: '合同.md', mediaType: 'text/plain; charset=utf-8', bytes: Buffer.byteLength(fileContent), sha256: digest, content: fileContent },
          { fileId: 'approval-file-2', name: '技术协议.md', mediaType: 'text/plain; charset=utf-8', bytes: Buffer.byteLength(attachment), sha256: attachmentDigest, content: attachment },
        ],
      })
      if (url.endsWith('/api/v1/approvals/requests/approval-2/workbench-context')) return Response.json({
        version: '1', requestId: 'approval-2', status: 'returned', viewer: 'original_submitter',
        title: '设备验收合同', step: '销售修改', returnReason: '请补齐附件', returnVersion: 'revise-1',
        businessObject: { objectName: 'forge_sales_contract', recordId: 'contract-1', recordName: '设备验收合同' }, sourceMaterialVersion: createHash('sha256').update('source-v1').digest('hex'),
        fields: [{ label: '合同名称', value: '设备验收合同' }], files: [],
      })
      if (url.endsWith('/api/v1/approvals/requests/approval-3/workbench-context')) return Response.json({
        version: '1', requestId: 'approval-3', status: 'pending', viewer: 'original_submitter',
        title: '合成销售订单', step: '订单复核', fields: [{ label: '订单金额', value: '¥20,000' }],
        businessObject: { objectName: 'forge_sales_order', recordId: 'order-1', recordName: '合成销售订单' }, sourceMaterialVersion,
        availableActions: [orderRecallAction], files: [],
      })
      if (url.endsWith('/api/v1/approvals/requests/approval-4/workbench-context')) return Response.json({
        version: '1', requestId: 'approval-4', status: 'pending', viewer: 'current_approver',
        title: '合成销售订单', step: '订单复核', fields: [],
        businessObject: { objectName: 'forge_sales_order', recordId: 'order-1' }, sourceMaterialVersion,
        availableActions: [{ ...orderRecallAction, execution: { ...orderRecallAction.execution, params: { ...orderRecallAction.execution.params, approvalRequestId: 'approval-4' } } }], files: [],
      })
      if (url.endsWith('/api/v1/approvals/requests/approval-5/workbench-context')) return Response.json({
        version: '1', requestId: 'approval-5', status: 'pending', viewer: 'original_submitter',
        title: '合成销售订单', step: '订单复核', fields: [],
        businessObject: { objectName: 'forge_sales_order', recordId: 'order-1' }, sourceMaterialVersion,
        availableActions: [orderApproveAction], files: [],
      })
      return Response.json({}, { status: 404 })
    }) as typeof fetch
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge.example.test', WORKBENCH_WEAVE_URL: 'http://weave.example.test' }, fetch: fetchMock })
    await signInAs(service, 'reviewer@example.test')

    const context = await service.getApprovalContext('approval-1')
    expect(context).toMatchObject({ requestId: 'approval-1', status: 'pending', viewer: 'current_approver', title: '设备验收合同', step: '交付复核', businessObject: { objectName: 'forge_sales_contract', recordId: 'contract-1' }, sourceMaterialVersion, availableActions: [{ execution: { tool: 'run_action', actionName: 'forge_action_from_metadata', recordId: 'contract-1', params: { approvalRequestId: 'approval-1', itemVersion: 'native-item-round-3', sourceMaterialVersion } }, inputs: [{ name: 'comment', type: 'string', required: true }] }], fields: [{ label: '合同名称', value: '设备验收合同' }], files: [{ fileId: 'approval-file-1', name: '合同.md', content: original, sha256: digest, verified: true }, { fileId: 'approval-file-2', name: '技术协议.md', content: attachment, sha256: attachmentDigest, verified: true }] })
    actionRecordId = 'different-record'
    await expect(service.getApprovalContext('approval-1')).rejects.toThrow('当前事项动作与本人打开的事项不匹配')
    actionRecordId = 'contract-1'
    actionInputName = 'approvalRequestId'
    await expect(service.getApprovalContext('approval-1')).rejects.toThrow('动作输入声明暂不支持')
    actionInputName = 'comment'
    const returnedContext = await service.getApprovalContext('approval-2')
    expect(returnedContext).toMatchObject({ requestId: 'approval-2', status: 'returned', viewer: 'original_submitter', title: '设备验收合同', step: '销售修改', returnReason: '请补齐附件', returnVersion: 'revise-1', businessObject: { objectName: 'forge_sales_contract', recordId: 'contract-1' }, sourceMaterialVersion: createHash('sha256').update('source-v1').digest('hex'), files: [] })
    expect(returnedContext).not.toHaveProperty('revisionReady')
    expect(calls.filter((url) => url.includes('/api/v1/data/') || /\/api\/v1\/storage\/files\/[^/]+\/url/.test(url))).toEqual([])
    expect(calls.filter((url) => url.includes('/workbench-context'))).toHaveLength(4)
    const submittedOrder = await service.getApprovalContext('approval-3')
    expect(submittedOrder).toMatchObject({ requestId: 'approval-3', status: 'pending', viewer: 'original_submitter', businessObject: { objectName: 'forge_sales_order', recordId: 'order-1' }, availableActions: [{ semantic: 'recall', execution: { actionName: 'order_approval_mcp_recall' } }] })
    expect(approvalContextView(submittedOrder).actions).toMatchObject([{ semantic: 'recall', label: '撤回订单审批' }])
    await expect(service.getApprovalContext('approval-4')).rejects.toThrow('审批人动作目录无效')
    await expect(service.getApprovalContext('approval-5')).rejects.toThrow('发起人审批动作目录无效')
    fileContent = '# 另一份合同\n'
    await expect(service.getApprovalContext('approval-1')).rejects.toThrow('审批文件与提交版本不一致')
  })

  it('reads more than 11 approval originals only through the current request-bound route', async () => {
    const source = await readFile(new URL('../fixtures/materials/sample-two-page.pdf', import.meta.url))
    const sha256 = createHash('sha256').update(source).digest('hex')
    const originalMaterials = Array.from({ length: 12 }, (_, index) => ({
      sourceKind: 'approval', requestId: 'approval-pdf', fileId: `approval-file-pdf-${index + 1}`,
      name: `验收附件${index + 1}.pdf`, mediaType: 'application/pdf', bytes: source.length, sha256,
    }))
    const calls: Array<{ url: string; headers: Headers }> = []
    let originalResponseStatus = 200
    const originalResponse = () => originalResponseStatus === 200 ? new Response(source, { status: 200, headers: {
      'Content-Type': 'application/pdf', 'Content-Length': String(source.length),
      'X-Content-SHA256': sha256, ETag: `"${sha256}"`, 'Cache-Control': 'private, no-store',
    } }) : new Response(null, { status: originalResponseStatus })
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input), headers = new Headers(init?.headers)
      calls.push({ url, headers })
      if (url.endsWith('/__test/approving-account')) return Response.json({ token: 'forge-token', user: { id: 'approver-1' } })
      if (url.endsWith('/v1/auth/external/exchange')) return Response.json({ token: 'weave-token', subject: { id: 'weave-approver-1', externalId: 'approver-1' }, organization: { id: 'default' }, issuer: 'forge:test-deployment', permissions: ['teams:use'] })
      if (url.endsWith('/api/v1/approvals/requests/approval-pdf/workbench-context')) return Response.json({
        version: '1', requestId: 'approval-pdf', status: 'pending', viewer: 'current_approver',
        title: '验收合同', step: '复核', fields: [], files: [],
        businessObject: { objectName: 'forge_sales_contract', recordId: 'contract-pdf' },
        sourceMaterialVersion: createHash('sha256').update('source-pdf-v1').digest('hex'),
        originalFiles: originalMaterials,
      })
      if (originalMaterials.some((file) => url.endsWith(`/api/v1/approvals/requests/approval-pdf/workbench-context/files/${file.fileId}/original`))) return originalResponse()
      return Response.json({}, { status: 404 })
    }) as typeof fetch
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
    await signInAs(service, 'approver@example.test')

    const context = await service.getApprovalContext('approval-pdf')
    expect(context.originalFiles).toHaveLength(12)
    expect(context.originalFiles?.[0]).toMatchObject({
      sourceKind: 'approval', requestId: 'approval-pdf', fileId: 'approval-file-pdf-1',
      name: '验收附件1.pdf', mediaType: 'application/pdf', bytes: source.length, sha256,
      extraction: { sourceSha256: sha256, status: 'partial' },
    })
    expect(Buffer.from(context.originalFiles![0]!.bytesBase64, 'base64')).toEqual(source)
    const originalCall = calls.find((call) => call.url.endsWith('/files/approval-file-pdf-1/original'))!
    expect(originalCall.headers.get('if-match')).toBe(`"${sha256}"`)
    const view = approvalContextView(context)
    expect(view.originalFiles?.[0]).toMatchObject({ name: '验收附件1.pdf', bytes: source.length, verified: true })
    expect(view.originalFiles?.[0]).not.toHaveProperty('fileId')
    expect(view.originalFiles?.[0]).not.toHaveProperty('requestId')
    expect(view.originalFiles?.[0]).not.toHaveProperty('bytesBase64')

    originalResponseStatus = 404
    await expect(service.getApprovalContext('approval-pdf')).rejects.toThrow('审批原件不属于当前员工或冻结材料')
    expect(calls.filter((call) => call.url.includes('/api/v1/workbench/materials/'))).toEqual([])
  })

  it.each([
    [401, undefined, '登录已失效，请重新登录'],
    [404, 'APPROVAL_CONTEXT_NOT_FOUND', '这项审批已无法由当前员工处理，请刷新待办'],
    [409, 'APPROVAL_CONTEXT_STALE', '审批状态已变化，请刷新待办'],
    [413, 'APPROVAL_MATERIAL_TOO_LARGE', '审批材料过大，请在 Forge 中查看'],
    [415, 'APPROVAL_MATERIAL_UNSUPPORTED_TYPE', '此审批材料格式暂不支持桌面预览，请在 Forge 中查看'],
    [422, 'APPROVAL_MATERIAL_HASH_MISMATCH', '审批材料与本次提交版本不一致，请暂停处理并刷新待办'],
    [422, 'APPROVAL_MATERIAL_HASH_UNAVAILABLE', '审批记录没有可核验的材料摘要，请在 Forge 中查看'],
  ])('handles approval context HTTP %i safely', async (status, code, message) => {
    const secret = 'PRIVATE_APPROVAL_RESPONSE_BODY'
    const calls: string[] = []
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input); calls.push(url)
      if (url.endsWith('/__test/approving-account')) return Response.json({ token: 'forge-token', user: { id: 'reviewer-1' } })
      if (url.endsWith('/v1/auth/external/exchange')) return Response.json({ token: 'weave-token', subject: { id: 'weave-reviewer-1', externalId: 'reviewer-1' }, organization: { id: 'default' }, issuer: 'forge:test-deployment', permissions: ['teams:use'] })
      if (url.endsWith('/api/v1/approvals/requests/approval-1/workbench-context')) return Response.json({ error: { code, detail: secret } }, { status })
      return Response.json({}, { status: 404 })
    }) as typeof fetch
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge.example.test', WORKBENCH_WEAVE_URL: 'http://weave.example.test' }, fetch: fetchMock })
    await signInAs(service, 'reviewer@example.test')

    const error = await service.getApprovalContext('approval-1').then(() => undefined, (reason: unknown) => reason)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(message)
    expect((error as Error).message).not.toContain(secret)
    expect(calls.filter((url) => url.includes('/api/v1/data/') || /\/api\/v1\/storage\/files\/[^/]+\/url/.test(url))).toEqual([])
  })

  it('discards an approval context response after the account changes', async () => {
    const contextRequest = deferred<void>(), lateContext = deferred<Response>()
    const fetchMock = vi.fn((input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/__test/approving-account')) {
        const email = (JSON.parse(String(init?.body)) as { email: string }).email
        return Promise.resolve(Response.json({ token: `forge-token-${email}`, user: { id: email } }))
      }
      if (url.endsWith('/v1/auth/external/exchange')) {
        const account = new Headers(init?.headers).get('Authorization')?.replace('Bearer forge-token-', '') ?? 'unknown'
        return Promise.resolve(Response.json({ token: `weave-token-${account}`, subject: { id: `weave-${account}`, externalId: account }, organization: { id: 'default' }, issuer: 'forge:test-deployment', permissions: ['teams:use'] }))
      }
      if (url.endsWith('/api/v1/approvals/requests/approval-1/workbench-context')) {
        contextRequest.resolve(undefined)
        return lateContext.promise
      }
      return Promise.resolve(Response.json({}, { status: 404 }))
    }) as typeof fetch
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge.example.test', WORKBENCH_WEAVE_URL: 'http://weave.example.test' }, fetch: fetchMock })
    await signInAs(service, 'a@example.test')
    const pending = service.getApprovalContext('approval-1')
    await contextRequest.promise
    await signInAs(service, 'b@example.test')
    lateContext.resolve(Response.json({ version: '1', requestId: 'approval-1', status: 'pending', viewer: 'current_approver', title: '旧账号合同正文', step: '交付复核', fields: [], files: [] }))

    await expect(pending).rejects.toThrow('账号已切换，旧请求结果已丢弃')
    await expect(service.getSession()).resolves.toMatchObject({ status: 'signed-in', user: { id: 'b@example.test' } })
  })

  it('discards an approval context error after the account changes', async () => {
    const contextRequest = deferred<void>(), lateContext = deferred<Response>()
    const fetchMock = vi.fn((input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/__test/approving-account')) {
        const email = (JSON.parse(String(init?.body)) as { email: string }).email
        return Promise.resolve(Response.json({ token: `forge-token-${email}`, user: { id: email } }))
      }
      if (url.endsWith('/v1/auth/external/exchange')) {
        const account = new Headers(init?.headers).get('Authorization')?.replace('Bearer forge-token-', '') ?? 'unknown'
        return Promise.resolve(Response.json({ token: `weave-token-${account}`, subject: { id: `weave-${account}`, externalId: account }, organization: { id: 'default' }, issuer: 'forge:test-deployment', permissions: ['teams:use'] }))
      }
      if (url.endsWith('/api/v1/approvals/requests/approval-1/workbench-context')) {
        contextRequest.resolve(undefined)
        return lateContext.promise
      }
      return Promise.resolve(Response.json({}, { status: 404 }))
    }) as typeof fetch
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge.example.test', WORKBENCH_WEAVE_URL: 'http://weave.example.test' }, fetch: fetchMock })
    await signInAs(service, 'a@example.test')
    const pending = service.getApprovalContext('approval-1')
    await contextRequest.promise
    await signInAs(service, 'b@example.test')
    lateContext.resolve(Response.json({ error: { code: 'APPROVAL_MATERIAL_HASH_MISMATCH', detail: '旧账号响应' } }, { status: 422 }))

    await expect(pending).rejects.toThrow('账号已切换，旧请求结果已丢弃')
    await expect(service.getSession()).resolves.toMatchObject({ status: 'signed-in', user: { id: 'b@example.test' } })
  })

  it('uploads the exact frozen bytes to Forge before dispatch', async () => {
    const content = '# 合同\n固定版本\n', uploaded: Buffer[] = [], uploads: Array<Record<string, unknown>> = []
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/__test/approving-account')) return Response.json({ token: 'forge-token', user: { id: 'sales-1' } })
      if (url.endsWith('/v1/auth/external/exchange')) return Response.json({ token: 'weave-token', subject: { id: 'weave-1', externalId: 'sales-1' }, organization: { id: 'default' }, issuer: 'forge:test-deployment', permissions: ['teams:use'] })
      if (url.endsWith('/api/v1/storage/upload/presigned')) {
        uploads.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return Response.json({ data: { fileId: 'file-1', uploadUrl: '/upload/file-1', method: 'PUT', headers: { 'Content-Type': 'text/markdown' } } })
      }
      if (url.endsWith('/upload/file-1')) { uploaded.push(Buffer.from(init?.body as Uint8Array)); return new Response(null, { status: 200 }) }
      if (url.endsWith('/api/v1/storage/upload/complete')) return Response.json({ data: { fileId: 'file-1' } })
      return Response.json({}, { status: 404 })
    }) as typeof fetch
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
    await signInAs(service, 'sales@example.test')
    const material = makeFrozenTextMaterial('合同.md', Buffer.from(content))
    const resources = await service.stageWorkMaterials([material], async () => undefined)
    expect(uploaded).toEqual([Buffer.from(content)])
    expect(uploads).toEqual([{ filename: '合同.md', mimeType: 'text/markdown', size: Buffer.byteLength(content), scope: 'attachments' }])
    expect(resources).toEqual([{ type: 'forge-file', materialId: material.materialId, id: 'file-1', name: '合同.md', mediaType: 'text/markdown', bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') }])
  })

  it('resumes an interrupted upload file by file without uploading a committed file again', async () => {
    const first = makeFrozenTextMaterial('合同.md', Buffer.from('# 合同\n'))
    const second = makeFrozenTextMaterial('附件.md', Buffer.from('# 附件\n'))
    const calls: string[] = []
    let failCommit = true, presigned = 0
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/__test/approving-account')) return Response.json({ token: 'forge-token', user: { id: 'sales-1' } })
      if (url.endsWith('/v1/auth/external/exchange')) return Response.json({ token: 'weave-token', subject: { id: 'weave-1', externalId: 'sales-1' }, organization: { id: 'default' }, issuer: 'forge:test-deployment', permissions: ['teams:use'] })
      if (url.endsWith('/api/v1/storage/upload/presigned')) {
        presigned += 1
        calls.push(`presign:${JSON.parse(String(init?.body)).filename}`)
        return Response.json({ data: { fileId: `file-${presigned}`, uploadUrl: `/upload/file-${presigned}`, method: 'PUT' } })
      }
      if (url.includes('/upload/file-')) { calls.push(`put:${url.split('/').pop()}`); return new Response(null, { status: 200 }) }
      if (url.endsWith('/api/v1/storage/upload/complete')) {
        const fileId = JSON.parse(String(init?.body)).fileId as string
        calls.push(`complete:${fileId}`)
        // The commit of the second file goes through but its answer is lost.
        if (fileId === 'file-2' && failCommit) { failCommit = false; throw new TypeError('network connection lost') }
        return Response.json({ data: { fileId } })
      }
      return Response.json({}, { status: 404 })
    }) as typeof fetch
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
    await signInAs(service, 'sales@example.test')
    const receipts = new Map<string, { fileId: string; phase: 'presigned' | 'uploaded' | 'completed' }>()
    const progress = { read: async (key: string) => receipts.get(key), write: async (key: string, receipt: { fileId: string; phase: 'presigned' | 'uploaded' | 'completed' }) => { receipts.set(key, receipt) } }
    await expect(service.stageWorkMaterials([first, second], async () => undefined, progress)).rejects.toThrow()
    expect(calls).toEqual(['presign:合同.md', 'put:file-1', 'complete:file-1', 'presign:附件.md', 'put:file-2', 'complete:file-2'])
    calls.length = 0
    const resources = await service.stageWorkMaterials([first, second], async () => undefined, progress)
    // The committed file is reused and the second is only committed again; nothing is uploaded twice.
    expect(calls).toEqual(['complete:file-2'])
    expect(resources.map((resource) => resource.id)).toEqual(['file-1', 'file-2'])
  })

  it('uploads the byte-exact PDF original with its PDF MIME type and frozen material binding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-pdf-upload-'))
    try {
      const source = await readFile(new URL('../fixtures/materials/sample-two-page.pdf', import.meta.url))
      const sourcePath = join(root, '合同.pdf')
      await writeFile(sourcePath, source)
      const material = (await freezeMaterials(root, [{ path: '合同.pdf', sha256: createHash('sha256').update(source).digest('hex') }]))[0]!
      const uploadBodies: Buffer[] = [], uploads: Array<Record<string, unknown>> = []
      const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input)
        if (url.endsWith('/__test/approving-account')) return Response.json({ token: 'forge-token', user: { id: 'sales-1' } })
        if (url.endsWith('/v1/auth/external/exchange')) return Response.json({ token: 'weave-token', subject: { id: 'weave-1', externalId: 'sales-1' }, organization: { id: 'default' }, issuer: 'forge:test-deployment', permissions: ['teams:use'] })
        if (url.endsWith('/api/v1/storage/upload/presigned')) {
          uploads.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
          return Response.json({ data: { fileId: 'pdf-file-1', uploadUrl: '/upload/pdf-file-1', method: 'PUT', headers: { 'Content-Type': 'application/pdf' } } })
        }
        if (url.endsWith('/upload/pdf-file-1')) { uploadBodies.push(Buffer.from(init?.body as Uint8Array)); return new Response(null, { status: 200 }) }
        if (url.endsWith('/api/v1/storage/upload/complete')) return Response.json({ data: { fileId: 'pdf-file-1' } })
        return Response.json({}, { status: 404 })
      }) as typeof fetch
      const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
      await signInAs(service, 'sales@example.test')
      const resources = await service.stageWorkMaterials([material], async () => undefined)
      expect(uploadBodies).toEqual([source])
      expect(uploads).toEqual([{ filename: '合同.pdf', mimeType: 'application/pdf', size: source.length, scope: 'attachments' }])
      expect(resources).toEqual([{ type: 'forge-file', sourceKind: 'owner', materialId: material.materialId, id: 'pdf-file-1', name: '合同.pdf', mediaType: 'application/pdf', bytes: source.length, sha256: material.sha256 }])
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('posts only frozen Forge file references and reads the same revision receipt', async () => {
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = []
    const idempotencyKey = '550e8400-e29b-41d4-a716-446655440000'
    const receipt = {
      requestId: 'approval-2', bindingId: '550e8400-e29b-41d4-a716-446655440001',
      newVersionDigest: createHash('sha256').update('new-contract').digest('hex'), state: 'resumed', repeated: true,
    }
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input), method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
      calls.push({ url, method, body })
      if (url.endsWith('/__test/approving-account')) return Response.json({ token: 'forge-token', user: { id: 'sales-1' } })
      if (url.endsWith('/v1/auth/external/exchange')) return Response.json({ token: 'weave-token', subject: { id: 'weave-sales-1', externalId: 'sales-1' }, organization: { id: 'default' }, issuer: 'forge:test-deployment', permissions: ['teams:use'] })
      if (url.endsWith('/api/v1/approvals/requests/approval-2/workbench-revision')) return Response.json({ data: receipt })
      if (url.endsWith(`/api/v1/approvals/requests/approval-2/workbench-revision/${idempotencyKey}`)) return Response.json({ data: receipt })
      return Response.json({}, { status: 404 })
    }) as typeof fetch
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
    await signInAs(service, 'sales@example.test')
    const body = {
      returnVersion: 'revise-1', sourceMaterialVersion: createHash('sha256').update('source').digest('hex'), idempotencyKey,
      primary: { fileId: 'primary-file', name: '修订正文.md', sha256: createHash('sha256').update('primary').digest('hex') },
      attachments: [{ fileId: 'attachment-file', name: '报价附件.txt', sha256: createHash('sha256').update('attachment').digest('hex') }],
    }
    const post = await service.submitApprovalRevision('approval-2', body, async () => undefined)
    const readback = await service.getApprovalRevisionReceipt('approval-2', idempotencyKey, async () => undefined)
    expect(post).toEqual({ status: 200, body: { data: receipt } })
    expect(readback).toEqual({ status: 200, body: { data: receipt } })
    expect(calls.filter((call) => call.url.endsWith('/approval-2/workbench-revision'))).toEqual([expect.objectContaining({
      url: 'http://forge/api/v1/approvals/requests/approval-2/workbench-revision', method: 'POST', body,
    })])
    expect(calls.find((call) => call.method === 'GET' && call.url.includes('/workbench-revision/'))?.url)
      .toBe(`http://forge/api/v1/approvals/requests/approval-2/workbench-revision/${idempotencyKey}`)
    expect(JSON.stringify(calls)).not.toContain('recordId')
    expect(calls.some((call) => call.url.endsWith('/approval-2/resubmit'))).toBe(false)
  })

  it('returns bounded unavailable states when the environments cannot be reached', async () => {
    const service = newEnterpriseService({
      environment: { WORKBENCH_FORGE_URL: 'http://forge.example.test', WORKBENCH_WEAVE_URL: 'http://weave.example.test' },
      fetch: (async () => { throw new Error('connection failed') }) as typeof fetch,
    })

    await expect(service.getStatus()).resolves.toEqual([
      expect.objectContaining({ available: false, secure: false, message: '暂时无法连接' }),
      expect.objectContaining({ available: false, secure: false, message: '暂时无法连接' }),
    ])
  })
})
