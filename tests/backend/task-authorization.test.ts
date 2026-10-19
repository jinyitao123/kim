import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { newEnterpriseService, signInAs } from '../helpers/browser-sign-in'
import { digest, HandoffStore } from '../../electron/main/enterprise/handoff-store'
import type { FixedWorkSource, ForgeTaskScope } from '../../electron/main/enterprise/task-handoff'
import type { FrozenAuthorizationRenewal, RenewalProgress } from '../../electron/main/enterprise/task-renewal'
import { delegationResponse, fixedSource } from './task-delegation-fixture'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })
const inputID = '550e8400-e29b-41d4-a716-446655440800'
const requestID = '550e8400-e29b-41d4-a716-446655440801'
const registrationID = '550e8400-e29b-41d4-a716-446655440802'
const choice = { teamId: 'team', teamName: '合同团队', workflowId: 'workflow', workflowName: '合同复核', businessCapabilityIds: ['forge:action:contract.submit'], version: 1 }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-task-auth-')); directories.push(directory)
  const store = new HandoffStore({ directory })
  const calls: Array<{ path: string; body?: Record<string, unknown>; headers: Headers }> = []
  let tamper = (value: ReturnType<typeof delegationResponse>) => value
  let loseStageReceipt = false, authorizationConflict = false, loseDispatchReceipt = false
  let issuedScope: ForgeTaskScope | undefined
  let issuedExpiresAt = ''
  let issuePause: { started: ReturnType<typeof deferred<void>>; response: ReturnType<typeof deferred<Response>> } | undefined
  let rejectionCode: string | undefined
  let terminalAfterAuthorization = false
  let renewedContextCanRenew = false
  const task = '按原材料继续当前合同工作'
  const scope: ForgeTaskScope = { input_revision_id: inputID, registration_id: registrationID, task_sha256: digest(task), workflow_id: 'workflow', workflow_version: 1, allowed_actions: ['forge:action:contract.submit'], resources: [] }
  const context = {
    version: '1', source: { input_revision_id: inputID, run_id: 'run-original', workbench_session_id: 'session-original', input_status: 'current' },
    input: { registration_id: registrationID, authorized_business_capability_ids: scope.allowed_actions, task, task_sha256: digest(task), team_id: 'team', workflow_id: 'workflow', workflow_version: 1, materials: [], source_messages: [{ message_id: 'employee-message', event_seq: 1, sha256: digest('继续原工作') }] },
    run: { status: 'parked', action_outcomes: [], authorization: { status: 'renewal_required', reason: '工作授权已过期', generation: 1, expires_at: new Date(Date.now() - 1000).toISOString(), can_renew: true, retry_node_id: 'submit', scope } },
  }
  const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: (async (url, init) => {
    const path = new URL(String(url)).pathname, headers = new Headers(init?.headers)
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
    calls.push({ path, body, headers })
    if (path === '/__test/approving-account') return Response.json({ token: 'native-employee-session', user: { id: String(body?.email), email: String(body?.email) }, session: { activeOrganizationId: 'native-org' } })
    if (path === '/v1/auth/external/exchange') return Response.json({ token: 'weave-session', subject: { id: 'weave-bound', externalId: 'employee@example.test' }, organization: { id: 'workspace-not-native-org' }, issuer: 'forge:test-deployment', permissions: ['teams:use'] })
    if (path === '/api/v1/auth/get-session') return Response.json({ user: { id: 'employee@example.test' }, session: { activeOrganizationId: 'native-org' } })
    if (path === '/v1/workbench/dispatch-inputs/prepare') return Response.json({ input_revision_id: inputID })
    if (path === '/api/v1/apps/forge/task-delegations') {
      expect(headers.get('Authorization')).toBe('Bearer native-employee-session')
      issuedScope = body!.scope as ForgeTaskScope
      const grant = tamper(delegationResponse(issuedScope, 'employee@example.test', 'native-org')); grant.generation = 2; issuedExpiresAt = grant.expires_at
      if (issuePause) { issuePause.started.resolve(); return issuePause.response.promise }
      return Response.json(grant)
    }
    if (path === '/v1/workbench/dispatch-inputs') {
      if (rejectionCode) return Response.json({ code: rejectionCode }, { status: 401 })
      expect(headers.get('X-Weave-Forge-Authorization')).toBe('Bearer task-token-for-this-input')
      expect(body?.input_revision_id).toBe(inputID)
      return Response.json({ input_revision_id: inputID, client_request_id: 'client-original', task_sha256: digest(String(body?.task)) }, { status: 201 })
    }
    if (path === '/v1/teams/team/dispatch') {
      if (loseDispatchReceipt) { loseDispatchReceipt = false; throw new Error('dispatch response lost') }
      return Response.json({ run_id: 'run-original', task_id: 'task-original', workflow_id: 'workflow', workflow_version: 1 }, { status: 200 })
    }
    if (path.endsWith('/workbench-context')) return Response.json(context)
    if (path === `/v1/workbench/dispatch-inputs/${inputID}/authorization`) {
      expect(body).toEqual({ expected_generation: 1 })
      if (authorizationConflict) return Response.json({}, { status: 409 })
      expect(headers.get('X-Weave-Forge-Authorization')).toBe('Bearer task-token-for-this-input')
      const expiresAt = issuedExpiresAt
      // Use the exact issued response timestamps for the authorization receipt.
      const issue = calls.filter((call) => call.path === '/api/v1/apps/forge/task-delegations').at(-1)!
      expect(issue.body?.scope).toEqual(scope)
      expect(issue.body?.expected_generation).toBe(1)
      if (terminalAfterAuthorization) context.run.status = 'failed'
      context.run.authorization = { ...context.run.authorization, status: 'active', can_renew: renewedContextCanRenew, generation: 2, expires_at: expiresAt }
      return Response.json({ input_revision_id: inputID, generation: 2, expires_at: expiresAt, status: 'active' })
    }
    if (path === '/v1/runs/run-original/stages/submit/retry') {
      expect(body?.idempotency_key).toMatch(/^[0-9a-f-]{36}$/)
      if (loseStageReceipt) { context.run.status = 'running'; throw new Error('stage response lost after acceptance') }
      return Response.json({ run_id: 'run-original', node_id: 'submit', status: 'queued', preserved_completed_stages: true, affected_node_ids: ['submit'] }, { status: 202 })
    }
    throw new Error(`unexpected fixture request ${path}`)
  }) as typeof fetch })
  await signInAs(service, 'employee@example.test')
  const source: FixedWorkSource = { ...fixedSource(await service.accountKey()), authorizedBusinessCapabilityIds: scope.allowed_actions,
    fixDelegationIntent: async (preparedID, frozenScope) => store.freeze('grant-intent', digest(JSON.stringify(frozenScope)), async () => ({ inputRevisionID: preparedID, requestID })) }
  const renewal: FrozenAuthorizationRenewal = { accountKey: await service.accountKey(), source: { inputRevisionID: inputID, runID: 'run-original', workbenchSessionID: 'session-original' }, expectedGeneration: 1, scope: structuredClone(scope), retryNodeID: 'submit', requestID, retryRequestID: registrationID }
  const observer = { assertCurrent: async () => {}, readProgress: async () => (await store.inspect<RenewalProgress>('renewal-progress'))?.value, checkpoint: async (progress: RenewalProgress) => { await store.checkpoint('renewal-progress', digest(JSON.stringify(renewal)), progress) } }
  return { service, calls, source, scope, renewal, observer, store, directory, context, get issuedScope() { return issuedScope }, tamper: (next: typeof tamper) => { tamper = next }, loseDispatch: () => { loseDispatchReceipt = true }, loseStage: () => { loseStageReceipt = true }, conflict: () => { authorizationConflict = true }, rejectTask: (code: string) => { rejectionCode = code }, closeAfterAuthorization: () => { terminalAfterAuthorization = true }, keepRenewableAfterAuthorization: () => { renewedContextCanRenew = true }, pauseIssue: () => { issuePause = { started: deferred<void>(), response: deferred<Response>() }; return issuePause } }
}

it('prepares, persists issuer intent, and sends only the scoped task token to Weave, using native identity rather than workspace', async () => {
  const f = await fixture()
  const receipt = await f.service.submitWork(choice, '固定合同正文', f.source)
  expect(receipt.inputRevisionId).toBe(inputID)
  expect(f.issuedScope).toMatchObject({ input_revision_id: inputID, workflow_id: 'workflow', workflow_version: 1, allowed_actions: ['forge:action:contract.submit'] })
  expect(f.calls.find((call) => call.path.endsWith('/prepare'))?.headers.has('X-Weave-Forge-Authorization')).toBe(false)
  expect(f.calls.filter((call) => call.path.startsWith('/v1/') && call.path !== '/v1/auth/external/exchange').every((call) => call.headers.get('Authorization') === 'Bearer weave-session')).toBe(true)
  expect(f.calls.filter((call) => call.path.startsWith('/v1/')).every((call) => call.headers.get('X-Weave-Forge-Authorization') !== 'Bearer native-employee-session')).toBe(true)
  const saved = await Promise.all((await readdir(f.directory)).map((file) => readFile(join(f.directory, file), 'utf8')))
  expect(saved.join('')).toContain(inputID)
  expect(saved.join('')).toContain(requestID)
  expect(saved.join('')).not.toContain('task-token-for-this-input')
  expect(saved.join('')).not.toContain('native-employee-session')
})

it.each(['scope', 'organization', 'issuer', 'identity_issuer'] as const)('rejects an issued token with mismatched %s before registering or dispatching', async (field) => {
  const f = await fixture()
  f.tamper((grant) => field === 'scope' ? { ...grant, scope: { ...grant.scope, allowed_actions: [] } }
    : field === 'organization' ? { ...grant, subject: { ...grant.subject, organization_id: 'workspace-not-native-org' } }
      : field === 'identity_issuer' ? { ...grant, identity_issuer: 'forge:another-deployment' } : { ...grant, issuer: 'http://unknown-alias' })
  await expect(f.service.submitWork(choice, '固定合同正文', f.source)).rejects.toThrow('任务授权与当前员工、组织或固定工作范围不一致')
  expect(f.calls.some((call) => call.path === '/v1/workbench/dispatch-inputs')).toBe(false)
})

it('accepts a 24-hour task grant and rejects a longer issuer expiry', async () => {
  const valid = await fixture()
  valid.tamper((grant) => ({ ...grant, expires_at: new Date(Date.parse(grant.issued_at) + 24 * 60 * 60_000).toISOString() }))
  await expect(valid.service.submitWork(choice, '固定合同正文', valid.source)).resolves.toMatchObject({ inputRevisionId: inputID })

  const invalid = await fixture()
  invalid.tamper((grant) => ({ ...grant, expires_at: new Date(Date.parse(grant.issued_at) + 24 * 60 * 60_000 + 1).toISOString() }))
  await expect(invalid.service.submitWork(choice, '固定合同正文', invalid.source)).rejects.toThrow('任务授权与当前员工、组织或固定工作范围不一致')
  expect(invalid.calls.some((call) => call.path === '/v1/workbench/dispatch-inputs')).toBe(false)
})

it('recovers a lost dispatch using the identical input and persisted issuer request, without broadening the scope', async () => {
  const f = await fixture(); f.loseDispatch()
  await expect(f.service.submitWork(choice, '固定合同正文', f.source)).rejects.toThrow('dispatch response lost')
  await f.service.submitWork(choice, '固定合同正文', f.source)
  const issues = f.calls.filter((call) => call.path === '/api/v1/apps/forge/task-delegations')
  const registrations = f.calls.filter((call) => call.path === '/v1/workbench/dispatch-inputs')
  expect(issues[0]?.body).toEqual(issues[1]?.body)
  expect(registrations[0]?.body).toEqual(registrations[1]?.body)
})

it('refuses unsafe terminal authorization renewal before issuing any token', async () => {
  const f = await fixture(); f.context.run.status = 'failed'; f.context.run.authorization.can_renew = false
  await expect(f.service.renewWorkAuthorization(f.renewal, f.observer)).rejects.toThrow('平台未确认原运行可无副作用续办')
  expect(f.calls.some((call) => call.path === '/api/v1/apps/forge/task-delegations')).toBe(false)
})

it('keeps CAS authorization conflicts explicit and does not retry a stage or create another input', async () => {
  const f = await fixture(); f.conflict()
  await expect(f.service.renewWorkAuthorization(f.renewal, f.observer)).rejects.toThrow('授权状态已变化')
  expect(f.calls.some((call) => call.path.includes('/stages/'))).toBe(false)
  expect(f.calls.some((call) => call.path.includes('/prepare') || call.path === '/v1/workbench/dispatch-inputs')).toBe(false)
})

it('parses the active renewable context after renewal and queues retry for the original input', async () => {
  const f = await fixture()
  f.keepRenewableAfterAuthorization()
  expect(await f.service.renewWorkAuthorization(f.renewal, f.observer)).toMatchObject({ status: 'resumed', authorizationRenewed: true })
  expect(f.context.run.authorization).toMatchObject({ status: 'active', can_renew: true, generation: 2, retry_node_id: 'submit' })
  expect(f.calls.filter((call) => call.path.includes('/stages/'))).toHaveLength(1)
  expect(f.calls.find((call) => call.path.includes('/stages/'))?.path).toBe('/v1/runs/run-original/stages/submit/retry')
  expect(f.calls.filter((call) => call.path === '/api/v1/apps/forge/task-delegations')[0]?.body?.scope).toEqual(f.renewal.scope)
  expect(f.calls.some((call) => call.path.includes('/prepare') || call.path === '/v1/workbench/dispatch-inputs')).toBe(false)
  expect(await f.service.renewWorkAuthorization(f.renewal, f.observer)).toMatchObject({ status: 'resumed' })
  expect(f.calls.filter((call) => call.path.includes('/stages/'))).toHaveLength(1)
  const saved = await Promise.all((await readdir(f.directory)).map((file) => readFile(join(f.directory, file), 'utf8')))
  expect(saved.join('')).not.toContain('task-token-for-this-input')
})

it('keeps unknown retry effects read-only on the next renewal request instead of repeating the original stage', async () => {
  const f = await fixture(); f.loseStage()
  expect(await f.service.renewWorkAuthorization(f.renewal, f.observer)).toMatchObject({ status: 'unknown', authorizationRenewed: true })
  expect(await f.service.renewWorkAuthorization(f.renewal, f.observer)).toMatchObject({ status: 'unknown', authorizationRenewed: true })
  expect(f.calls.filter((call) => call.path.includes('/stages/'))).toHaveLength(1)
  expect(f.calls.filter((call) => call.path.endsWith('/authorization'))).toHaveLength(1)
  expect(f.calls.filter((call) => call.path === '/api/v1/apps/forge/task-delegations')).toHaveLength(1)
})

it('rejects a scope that diverges from the independently frozen input action declaration', async () => {
  const f = await fixture(); f.context.run.authorization.scope = { ...f.scope, allowed_actions: [] }
  await expect(f.service.renewWorkAuthorization(f.renewal, f.observer)).rejects.toThrow('工作授权范围与原固定输入不一致')
  expect(f.calls.some((call) => call.path === '/api/v1/apps/forge/task-delegations')).toBe(false)
})

it.each(['business_delegation_expired', 'business_delegation_invalid'])('keeps the employee account when a task-specific 401 rejects registration: %s', async (code) => {
  const f = await fixture(); f.rejectTask(code)
  await expect(f.service.submitWork(choice, '固定合同正文', f.source)).rejects.toThrow('原工作任务授权')
  expect((await f.service.getSession()).status).toBe('signed-in')
  expect(f.calls.some((call) => call.path === '/v1/teams/team/dispatch')).toBe(false)
})

it('does not register a token issued for the former account after a login switch', async () => {
  const f = await fixture(), pause = f.pauseIssue()
  const original = f.service.submitWork(choice, '固定合同正文', f.source), discarded = expect(original).rejects.toThrow('账号已切换')
  await pause.started.promise
  await signInAs(f.service, 'replacement@example.test')
  pause.response.resolve(Response.json(delegationResponse(f.issuedScope!, 'employee@example.test', 'native-org')))
  await discarded
  expect(f.calls.some((call) => call.path === '/v1/workbench/dispatch-inputs')).toBe(false)
  expect((await f.service.getSession()).user?.email).toBe('replacement@example.test')
})

it('does not retry a stage if the original run becomes terminal after authorization replacement', async () => {
  const f = await fixture(); f.closeAfterAuthorization()
  await expect(f.service.renewWorkAuthorization(f.renewal, f.observer)).rejects.toThrow('运行已不在原安全等待位置')
  expect(f.calls.some((call) => call.path.includes('/stages/'))).toBe(false)
})
