import { delegationResponse, fixedSource } from './task-delegation-fixture'
import { taskScopeSHA256, type ForgeTaskScope } from '../../electron/main/enterprise/task-handoff'
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { newEnterpriseService, signInAs } from '../helpers/browser-sign-in'

const choice = { teamId: 'team', teamName: '合同团队', workflowId: 'workflow', workflowName: '合同复核', businessCapabilityIds: ['forge:action:forge_sales_contract.contract_submit'], version: 3 }
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
async function fixture() {
  const registrations = new Map<string, string>(), heads = new Set<string>(), runs = new Map<string, string>()
  let dropDispatchResponse = false, mismatchDigest = false
  let rejectContinuation = false
  let afterRegistration = async () => {}
  const calls: { path: string; body: Record<string, unknown> }[] = []
  const delegationGrants: ReturnType<typeof delegationResponse>[] = []
  const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    if (path === '/__test/approving-account') return Response.json({ token: 'forge', user: { id: 'employee' }, session: { activeOrganizationId: 'forge-org' } })
    if (path === '/v1/auth/external/exchange') return Response.json({ token: 'weave', subject: { id: 'bound', externalId: 'employee' }, organization: { id: 'org' }, issuer: 'forge:test-deployment', permissions: ['teams:use'] })
    if (path === '/api/v1/auth/sign-out') return Response.json({ success: true })
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    calls.push({ path, body })
    if (path === '/v1/workbench/dispatch-inputs/prepare') return Response.json({ input_revision_id: body.registration_id })
    if (path === '/api/v1/apps/forge/task-delegations') {
      const grant = delegationResponse(body.scope as ForgeTaskScope, 'employee')
      delegationGrants.push(grant)
      return Response.json(grant)
    }
    if (path === '/v1/workbench/dispatch-inputs') {
      // Mirror service admission constraints, not an unconditional success stub.
      expect(String(body.registration_id)).toMatch(uuid)
      expect(Buffer.byteLength(String(body.task))).toBeLessThanOrEqual(1 << 20)
      const sources = body.source_messages as Array<{ event_seq: number; sha256: string; message_id: string }>
      expect(sources.length).toBeGreaterThan(0)
      expect(sources.every((source, i) => /^[a-f0-9]{64}$/.test(source.sha256) && (i === 0 || source.event_seq > sources[i - 1].event_seq))).toBe(true)
      expect(body.authorized_business_capability_ids).toEqual([])
      if (body.revision_context && rejectContinuation) return Response.json({ error: 'input_revision_conflict' }, { status: 409 })
      const id = String(body.registration_id), encoded = JSON.stringify(body)
      if (registrations.has(id) && registrations.get(id) !== encoded) return Response.json({ error: 'input_registration_conflict' }, { status: 409 })
      if (!registrations.has(id) && heads.has(String(body.workbench_session_id))) return Response.json({ error: 'input_revision_conflict' }, { status: 409 })
      registrations.set(id, encoded); heads.add(String(body.workbench_session_id))
      await afterRegistration()
      return Response.json({ input_revision_id: id, client_request_id: id, task_sha256: mismatchDigest ? hash('wrong material') : hash(String(body.task)) }, { status: 201 })
    }
    if (path === '/v1/teams/team/dispatch') {
      const id = String(body.client_request_id), repeated = runs.has(id)
      if (!repeated) runs.set(id, `run-${runs.size + 1}`)
      if (dropDispatchResponse) { dropDispatchResponse = false; throw new Error('response lost after server accepted') }
      return Response.json({ run_id: runs.get(id), task_id: `task-${id}`, workflow_id: 'workflow', workflow_version: 3 }, { status: repeated ? 200 : 201 })
    }
    throw new Error('unexpected request')
  }) as typeof fetch
  const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
  await signInAs(service, 'employee@example.test')
  let current = true
  const source = { fixDelegationIntent: fixedSource(await service.accountKey()).fixDelegationIntent, idempotencySeed: 'session:employee-message:team', sessionKey: 'session', sourceMessages: [{ messageId: 'employee-message', eventSeq: 2, sha256: hash('这版给他们看看') }], accountKey: await service.accountKey(), resources: [{ type: 'forge-file' as const, id: 'file-contract-v1', name: '合同.md', bytes: 12, sha256: hash('合同正文') }], authorizedBusinessCapabilityIds: [], assertCurrent: async () => { if (!current) throw new Error('员工已改变要求') } }
  return { service, source, registrations, runs, calls, delegationGrants, drop: () => { dropDispatchResponse = true }, wrongDigest: () => { mismatchDigest = true }, rejectContinuation: () => { rejectContinuation = true }, changeDuringRegistration: () => { afterRegistration = async () => { current = false } }, logoutDuringRegistration: () => { afterRegistration = async () => { await service.signOut() } } }
}
describe('Weave handoff admission contract', () => {
  it('recovers a lost dispatch response with the identical UUID and body, producing one run', async () => {
    const f = await fixture(); f.drop()
    await expect(f.service.submitWork(choice, '合同正文', f.source)).rejects.toThrow('response lost')
    const receipt = await f.service.submitWork(choice, '合同正文', f.source)
    expect(receipt.repeated).toBe(true)
    expect(f.runs.size).toBe(1)
    const registrations = f.calls.filter((call) => call.path.endsWith('dispatch-inputs'))
    expect(registrations[0].body).toEqual(registrations[1].body)
    expect(receipt.taskSha256).toBe(hash('合同正文'))
  })
  it('keeps a second independent intent in the same desktop conversation from colliding with the prior input head', async () => {
    const f = await fixture()
    await f.service.submitWork(choice, '合同甲', f.source)
    await f.service.submitWork(choice, '合同乙', { ...f.source, idempotencySeed: 'session:second-message:team' })
    expect(f.registrations.size).toBe(2)
  })
  it('reuses the original session and sends a compare-and-swap parent that rejects a stale head', async () => {
    const f = await fixture()
    f.rejectContinuation()
    const continuation = {
      workbenchSessionID: 'workbench-employee-session',
      inputRevisionID: '10000000-0000-4000-8000-000000000001',
      runID: 'run-parent', teamID: choice.teamId,
    }

    await expect(f.service.submitWork(choice, '按补充材料继续复核', { ...f.source, continuation })).rejects.toThrow('旧事项不能覆盖后来的工作')
    const registration = f.calls.find((call) => call.path.endsWith('dispatch-inputs'))?.body
    expect(registration).toMatchObject({
      workbench_session_id: continuation.workbenchSessionID,
      expected_revision_id: continuation.inputRevisionID,
      revision_context: { parent_input_revision_id: continuation.inputRevisionID, parent_run_id: continuation.runID },
      team_id: choice.teamId,
    })
    expect(f.calls.some((call) => call.path.endsWith('/dispatch'))).toBe(false)
    expect(f.runs.size).toBe(0)
  })
  it('replays one new continuation input with the exact reused and newly staged resources', async () => {
    const f = await fixture(); f.drop()
    const continuation = {
      workbenchSessionID: 'workbench-employee-session',
      inputRevisionID: '10000000-0000-4000-8000-000000000001',
      runID: 'run-needs-input', teamID: choice.teamId,
    }
    const reused = {
      type: 'forge-file' as const, sourceKind: 'owner' as const,
      materialId: 'aaaaaaaaaaaaaaaaaaaaaaaa', id: 'forge-original-docx', name: '合同样例.docx',
      mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' as const,
      bytes: 1200, sha256: hash('frozen-docx'),
    }
    const added = {
      type: 'forge-file' as const, sourceKind: 'owner' as const,
      materialId: 'bbbbbbbbbbbbbbbbbbbbbbbb', id: 'forge-new-pdf', name: '补充材料.pdf',
      mediaType: 'application/pdf' as const, bytes: 900, sha256: hash('new-pdf'),
    }
    const source = {
      ...f.source, idempotencySeed: 'session:current-needs-input-message:team',
      continuation, resources: [reused, added],
    }
    await expect(f.service.submitWork(choice, '按原 DOCX 和新 PDF 补充检查', source)).rejects.toThrow('response lost')
    const receipt = await f.service.submitWork(choice, '按原 DOCX 和新 PDF 补充检查', source)
    expect(receipt.repeated).toBe(true)
    expect(f.runs.size).toBe(1)
    const registrations = f.calls.filter((call) => call.path.endsWith('dispatch-inputs'))
    expect(registrations).toHaveLength(2)
    expect(registrations[0]?.body).toEqual(registrations[1]?.body)
    expect(registrations[0]?.body).toMatchObject({
      expected_revision_id: continuation.inputRevisionID,
      revision_context: { parent_input_revision_id: continuation.inputRevisionID, parent_run_id: continuation.runID },
      resources: [reused, added],
    })
    expect(registrations[0]?.body.registration_id).not.toBe(continuation.inputRevisionID)
    const dispatches = f.calls.filter((call) => call.path.endsWith('/dispatch'))
    expect(dispatches).toHaveLength(2)
    expect(dispatches[0]?.body.client_request_id).toBe(dispatches[1]?.body.client_request_id)
  })
  it('does not dispatch after a changed employee request or logout during registration', async () => {
    for (const mode of ['change', 'logout']) {
      const f = await fixture()
      if (mode === 'change') f.changeDuringRegistration(); else f.logoutDuringRegistration()
      await expect(f.service.submitWork(choice, '合同正文', f.source)).rejects.toThrow()
      expect(f.runs.size).toBe(0)
    }
  })
  it('refuses a registration receipt for different material content', async () => {
    const f = await fixture(); f.wrongDigest()
    await expect(f.service.submitWork(choice, '合同正文', f.source)).rejects.toThrow('固定材料不一致')
    expect(f.runs.size).toBe(0)
  })
  it('registers the exact selected record and refuses to reuse its key for another record', async () => {
    const f = await fixture()
    const source = { ...f.source, businessContext: { objectName: 'forge_quote', recordId: 'quote-a', recordVersion: 'revision-7' } }
    await f.service.submitWork(choice, '核对报价', source)
    const prepared = f.calls.find((call) => call.path.endsWith('/v1/workbench/dispatch-inputs/prepare'))?.body
    const grantRequest = f.calls.find((call) => call.path.endsWith('/api/v1/apps/forge/task-delegations'))?.body
    const registration = f.calls.find((call) => call.path === '/v1/workbench/dispatch-inputs')?.body
    const scope = grantRequest?.scope as ForgeTaskScope
    const grant = f.delegationGrants[0]!
    const record = { object_name: 'forge_quote', record_id: 'quote-a' }
    expect(prepared?.business_record).toEqual(record)
    expect(registration?.business_record).toEqual(record)
    expect(scope.business_record).toEqual(record)
    expect(grant.scope_sha256).toBe(taskScopeSHA256(scope))
    expect(grant.scope).toEqual(scope)
    expect(scope.business_record).toEqual(prepared?.business_record)
    await expect(f.service.submitWork(choice, '核对报价', { ...source, businessContext: { ...source.businessContext, recordId: 'quote-b' } })).rejects.toThrow('已登记内容冲突')
    expect(f.runs.size).toBe(1)
  })

})
