import { expect, it } from 'vitest'
import { newEnterpriseService, signInAs } from '../helpers/browser-sign-in'
import { digest } from '../../electron/main/enterprise/handoff-store'

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }

async function fixture() {
  const calls: Array<{ path: string; method: string; headers: Headers; body?: Record<string, unknown> }> = []
  let grant = 'grant-original', revokeFailure = false, stopFailure = false, stopStatus = 'cancel_requested'
  let notWorkbench = false, contextFailure = false, grantAfterRevoke: string | undefined
  let revokePause: { started: ReturnType<typeof deferred<void>>; response: ReturnType<typeof deferred<Response>> } | undefined
  const context = () => ({
    version: '1', source: { input_revision_id: '550e8400-e29b-41d4-a716-446655441001', run_id: 'run-original', workbench_session_id: 'session-original', input_status: 'current' },
    input: { task: '核对合同', task_sha256: digest('核对合同'), team_id: 'team', workflow_id: 'flow', workflow_version: 1, materials: [], source_messages: [{ message_id: 'employee-request', event_seq: 1, sha256: digest('核对合同') }] },
    run: { status: 'parked', authorization: { status: 'active', grant_id: grant, can_renew: false }, action_outcomes: [] },
  })
  const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: (async (input, init) => {
    const path = new URL(String(input)).pathname, method = init?.method ?? 'GET', headers = new Headers(init?.headers)
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
    calls.push({ path, method, headers, body })
    if (path === '/__test/approving-account') return Response.json({ token: `native-${body?.email}`, user: { id: body?.email } })
    if (path === '/v1/auth/external/exchange') return Response.json({ token: 'weave-session', subject: { id: 'weave-employee', externalId: 'employee@example.test' }, organization: { id: 'org' }, issuer: 'forge:stable-deployment', permissions: ['teams:use', 'teams:develop'] })
    if (path.endsWith('/workbench-context')) return contextFailure ? Response.json({}, { status: 403 }) : notWorkbench ? Response.json({}, { status: 404 }) : Response.json(context())
    if (path === '/v1/runs/run-original') return Response.json({ run_id: 'run-original', project_id: 'development-project' })
    if (path.startsWith('/api/v1/apps/forge/task-delegations/')) {
      expect(method).toBe('DELETE')
      expect(body).toEqual({ reason: 'employee_cancel' })
      if (revokePause) { revokePause.started.resolve(); return revokePause.response.promise }
      if (revokeFailure) throw new Error('revocation response lost')
      if (grantAfterRevoke) grant = grantAfterRevoke
      return Response.json({ version: '1', grant_id: 'grant-original', revoked: true, reason: 'employee_cancel' })
    }
    if (path.endsWith('/stop')) {
      if (stopFailure) throw new Error('stop response lost')
      return Response.json({ run_id: 'run-original', status: stopStatus, idempotency_key: body?.idempotency_key }, { status: 202 })
    }
    throw new Error('unexpected test route')
  }) as typeof fetch })
  await signInAs(service, 'employee@example.test')
  return { service, calls, setGrant: (value: string) => { grant = value }, failRevoke: (value: boolean) => { revokeFailure = value }, failStop: (value: boolean) => { stopFailure = value }, status: (value: string) => { stopStatus = value }, development: () => { notWorkbench = true }, denyContext: () => { contextFailure = true }, rotateDuringRevoke: () => { grantAfterRevoke = 'grant-replacement' }, pauseRevoke: () => { revokePause = { started: deferred<void>(), response: deferred<Response>() }; return revokePause } }
}

it('revokes the exact original grant using only the employee bearer before stopping the original run using only Weave identity', async () => {
  const f = await fixture()
  await expect(f.service.cancelWork('run-original')).resolves.toMatchObject({ status: 'cancel_requested', authorizationRevoked: true })
  const operations = f.calls.filter((call) => call.method === 'DELETE' || call.path.endsWith('/stop'))
  expect(operations.map((call) => call.path)).toEqual(['/api/v1/apps/forge/task-delegations/grant-original', '/v1/runs/run-original/stop'])
  expect(operations[0]?.headers.get('Authorization')).toBe('Bearer native-employee@example.test')
  expect(operations[1]?.headers.get('Authorization')).toBe('Bearer weave-session')
  expect(operations[1]?.headers.has('X-Weave-Forge-Authorization')).toBe(false)
  expect(operations[1]?.body).toEqual({ reason: 'employee_cancel', idempotency_key: 'workbench-cancel-run-original' })
})

it('keeps unknown revocation unknown and retries the same grant without stopping before confirmation', async () => {
  const f = await fixture(); f.failRevoke(true)
  await expect(f.service.cancelWork('run-original')).resolves.toMatchObject({ status: 'unknown', authorizationRevoked: false })
  expect(f.calls.some((call) => call.path.endsWith('/stop'))).toBe(false)
  f.failRevoke(false)
  await expect(f.service.cancelWork('run-original')).resolves.toMatchObject({ status: 'cancel_requested', authorizationRevoked: true })
  expect(f.calls.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual(['/api/v1/apps/forge/task-delegations/grant-original', '/api/v1/apps/forge/task-delegations/grant-original'])
})

it('retries an unknown stop along the same run and idempotency key after confirmed revocation', async () => {
  const f = await fixture(); f.failStop(true)
  await expect(f.service.cancelWork('run-original')).resolves.toMatchObject({ status: 'unknown', authorizationRevoked: true })
  f.failStop(false); f.status('cancelled')
  await expect(f.service.cancelWork('run-original')).resolves.toMatchObject({ status: 'cancelled', authorizationRevoked: true })
  expect(f.calls.filter((call) => call.path.endsWith('/stop')).map((call) => call.body?.idempotency_key)).toEqual(['workbench-cancel-run-original', 'workbench-cancel-run-original'])
})

it('does not cancel a replacement grant after an uncertain original cancellation', async () => {
  const f = await fixture(); f.failRevoke(true)
  await f.service.cancelWork('run-original')
  f.setGrant('grant-replacement')
  await expect(f.service.cancelWork('run-original')).rejects.toThrow('没有取消替换后的授权')
  expect(f.calls.filter((call) => call.method === 'DELETE')).toHaveLength(1)
})

it('does not stop a run whose grant changed during revocation', async () => {
  const f = await fixture(); f.rotateDuringRevoke()
  await expect(f.service.cancelWork('run-original')).resolves.toMatchObject({ status: 'unknown', authorizationRevoked: true })
  expect(f.calls.some((call) => call.path.endsWith('/stop'))).toBe(false)
})

it('retains the direct stop path for a permitted development run with no Workbench delegation', async () => {
  const f = await fixture(); f.development()
  await expect(f.service.cancelWork('run-original')).resolves.toMatchObject({ status: 'cancel_requested', authorizationRevoked: false })
  expect(f.calls.some((call) => call.method === 'DELETE')).toBe(false)
})

it('does not turn a forbidden original context into a development fallback or log out the employee', async () => {
  const f = await fixture(); f.denyContext()
  await expect(f.service.cancelWork('run-original')).rejects.toThrow('没有取消这项工作的权限')
  expect(f.calls.some((call) => call.method === 'DELETE' || call.path.endsWith('/stop'))).toBe(false)
  expect((await f.service.getSession()).status).toBe('signed-in')
})

it('discards a delayed old-account revocation before it can stop the run for a replacement login', async () => {
  const f = await fixture(), pause = f.pauseRevoke()
  const cancel = f.service.cancelWork('run-original'), discarded = expect(cancel).rejects.toThrow('账号已切换')
  await pause.started.promise
  expect(f.calls.some((call) => call.method === 'DELETE')).toBe(true)
  await signInAs(f.service, 'replacement@example.test')
  pause.response.resolve(Response.json({ version: '1', grant_id: 'grant-original', revoked: true, reason: 'employee_cancel' }))
  await discarded
  expect(f.calls.some((call) => call.path.endsWith('/stop'))).toBe(false)
})

it('does not describe an already finished run as cancelled', async () => {
  const f = await fixture(); f.status('succeeded')
  await expect(f.service.cancelWork('run-original')).resolves.toMatchObject({ status: 'completed', message: expect.stringContaining('已经结束') })
})
