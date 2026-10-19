import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { workRunDetails } from '../../electron/main/enterprise/work-run-details'
import { newEnterpriseService, signInAs } from '../helpers/browser-sign-in'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const input = '550e8400-e29b-41d4-a716-446655440000'
const owned = { runId: 'run', inputRevisionID: input, workbenchSessionID: 'session', status: 'failed', isCurrent: true, actionCounts: { succeeded: 0, failed: 0, unknown: 0 } }
function context() { return { version: '1', source: { run_id: 'run', input_revision_id: input, workbench_session_id: 'session' }, input: {
  team_id: 'team', workflow_id: 'workflow', workflow_version: 1, task: '检查材料', task_sha256: hash('检查材料'),
  materials: [{ type: 'forge-file', id: 'file', name: '合同材料.pdf', bytes: 2048, sha256: hash('file'), mediaType: 'application/pdf', materialId: '012345678901234567890123', sourceKind: 'owner' }],
  source_messages: [{ message_id: 'message', event_seq: 1, sha256: hash('source') }],
}, run: { status: 'failed' } } }
function activity() { return { run_id: 'run', status: 'failed', created_at: '2026-10-02T10:00:00Z', finished_at: '2026-10-02T10:01:00Z', observed_at: '2026-10-02T10:01:01Z', completeness: { members: 'complete', activity_events: 'complete' }, members: [{ name: '材料检查员', status: 'failed', runtime: { configured_endpoint: 'private', auth_mode: 'secret' }, stages: [{ name: '核对材料', status: 'failed', duration_ms: 60000, node_id: input, failure_class: 'validation', failure_reason: 'workflow_field_unknown $.task' }] }] } }

it('projects real members, timing, materials and zero action records without runtime internals or raw errors', () => {
  const details = workRunDetails(owned, activity(), context())
  expect(details).toMatchObject({ status: 'failed', acceptedAt: '2026-10-02T10:00:00Z', finishedAt: '2026-10-02T10:01:00Z', activityComplete: true,
    members: [{ name: '材料检查员', status: 'failed', stages: [{ name: '核对材料', status: 'failed', durationMs: 60000 }] }],
    materials: [{ name: '合同材料.pdf', format: 'PDF', bytes: 2048 }], actionCounts: { succeeded: 0, failed: 0, unknown: 0 } })
  expect(details.explanation).toContain('步骤结果未通过要求，尚未形成有效结论')
  for (const hidden of [input, 'workflow_field_unknown', '$.task', 'configured_endpoint', 'secret', 'workbench_session_id']) expect(JSON.stringify(details)).not.toContain(hidden)
})

it('does not invent names, statuses, missing times or action counts from missing or unsafe fields', () => {
  const raw = activity()
  raw.members[0].name = input
  raw.members[0].stages[0].name = '/Users/private/work/file'
  raw.members[0].stages[0].status = 'unrecognized_state'
  const details = workRunDetails({ ...owned, actionCounts: undefined }, { ...raw, created_at: undefined, finished_at: undefined, completeness: {} }, context())
  expect(details).toMatchObject({ members: [{ name: '团队成员 1', stages: [{ name: '执行步骤 1', status: 'not_recorded' }] }], activityComplete: false })
  expect(details.acceptedAt).toBeUndefined()
  expect(details.finishedAt).toBeUndefined()
  expect(details.actionCounts).toBeUndefined()
  expect(JSON.stringify(details)).not.toContain('/Users')
})

it('keeps result summaries and missing requirements only after native context validation', () => {
  const ctx = { ...context(), run: { status: 'succeeded', business_result: 'needs_input', final_result: { id: 'result', title: '材料检查结果', content_type: 'text/plain', content: '请补充期限', sha256: hash('请补充期限'), disposition: 'needs_input', summary: '缺少交付期限', missing_items: ['请补充交付期限'] } } }
  expect(workRunDetails({ ...owned, status: 'succeeded' }, { ...activity(), status: 'succeeded' }, ctx).result).toEqual({ title: '材料检查结果', summary: '缺少交付期限', missingItems: ['请补充交付期限'] })
  expect(() => workRunDetails(owned, { ...activity(), run_id: 'other' }, context())).toThrow('正在更新')
  expect(() => workRunDetails(owned, { ...activity(), status: 'running' }, context())).toThrow('正在更新')
  expect(() => workRunDetails({ ...owned, workbenchSessionID: 'other' }, activity(), context())).toThrow('正在更新')
})

it.each(['付款30%/30%/40%，交付20天/72小时。', '由销售/商务核对付款比例，Delivery/Acceptance 分别确认。'])('keeps ordinary business slash text: %s', (summary) => {
  const ctx = { ...context(), run: { status: 'succeeded', final_result: { id: 'result', title: '合同检查', content_type: 'text/plain', content: summary, sha256: hash(summary), disposition: 'complete', summary, missing_items: [] } } }
  expect(workRunDetails({ ...owned, status: 'succeeded' }, { ...activity(), status: 'succeeded' }, ctx).result?.summary).toBe(summary)
})

it.each(['请读取 /Users/private/work/contract.pdf', '原件保存在（/var/tmp/contract.pdf）', '请读取 C:\\private\\contract.pdf', '附件位置：reports/contract.pdf'])('does not publish internal file paths: %s', (summary) => {
  const ctx = { ...context(), run: { status: 'succeeded', final_result: { id: 'result', title: '合同检查', content_type: 'text/plain', content: summary, sha256: hash(summary), disposition: 'complete', summary, missing_items: [] } } }
  expect(workRunDetails({ ...owned, status: 'succeeded' }, { ...activity(), status: 'succeeded' }, ctx).result).toBeUndefined()
})

function summaryDetails(summary: string) {
  const ctx = { ...context(), run: { status: 'succeeded', final_result: { id: 'result', title: '检查结果', content_type: 'text/plain', content: summary, sha256: hash(summary), disposition: 'complete', summary, missing_items: [] } } }
  return workRunDetails({ ...owned, status: 'succeeded' }, { ...activity(), status: 'succeeded' }, ctx)
}

it('keeps complete readable sentences as an explicitly partial excerpt without rewriting their caveats', () => {
  const first = '未执行 internal_operation，本轮没有写入业务。'
  const business = '付款比例记录为30%/30%/40%，尚未取得客户确认。交付20天/72小时之间仍有差异，不能据此确认最终期限。'
  const details = summaryDetails(first + business)
  expect(details.result).toEqual({ title: '检查意见摘录', summary: business, missingItems: [] })
  expect(details.explanation).toContain('完整结果请从“我的工作”的原工作消息查看')
  expect(details.status).toBe('succeeded')
  expect(details.actionCounts).toEqual(owned.actionCounts)
})

it('does not retain a positive conclusion after dropping its limiting sentence', () => {
  const details = summaryDetails('付款条件已经确认。但仅在 internal_operation 完成后成立。交付期限仍待确认。')
  expect(details.result?.summary).toBe('交付期限仍待确认。')
  expect(summaryDetails('以下结论仅在 internal_operation 完成后成立。付款条件已经确认。').result).toBeUndefined()
  expect(summaryDetails('internal_operation 结果不可用。因此付款已经确认。交付期限尚待确认。').result?.summary).toBe('交付期限尚待确认。')
})

it('preserves a complete safe summary verbatim instead of labeling it an excerpt', () => {
  const summary = '付款比例仍待客户确认。\n\n交付期限为20天/72小时，尚有差异。'
  const details = summaryDetails(summary)
  expect(details.result).toEqual({ title: '检查结果', summary, missingItems: [] })
  expect(details.explanation).not.toContain('部分检查意见')
})

it.each([
  ['verification', 'workflow_field_unknown', '步骤结果未通过要求'],
  ['schema', 'schema mismatch', '步骤结果未通过要求'],
  ['configuration', 'configuration was rejected', '流程配置未通过检查'],
  ['unrecognized', 'configuration schema validation connection unavailable', '本次团队执行未完成'],
])('uses declared failure class %s without assigning causes from raw prose', (failureClass, reason, expected) => {
  const raw = activity()
  raw.members[0].stages[0].failure_class = failureClass
  raw.members[0].stages[0].failure_reason = reason
  expect(workRunDetails(owned, raw, context()).explanation).toContain(expected)
})

it.each([undefined, null, {}, [null], [{ name: '检查员', status: 'running' }]])('does not call missing or malformed member records complete: %j', (members) => {
  expect(workRunDetails(owned, { ...activity(), members }, context()).activityComplete).toBe(false)
})

it.each([
  ['failed', '步骤结果未通过要求'],
  ['cancelled', '本次团队执行已停止'],
  ['succeeded', '团队执行已完成'],
  ['abandoned', ''],
  ['parked', '团队工作当前处于等待状态，等待原因尚未核对'],
] as const)('does not suggest renewal for a non-renewable %s run', (status, expected) => {
  const ctx = { ...context(), run: { status, authorization: { status: 'renewal_required', can_renew: false } } }
  const details = workRunDetails({ ...owned, status }, { ...activity(), status }, ctx)
  expect(details.authorizationRequired).toBe(false)
  expect(details.explanation).not.toContain('更新本次工作的授权')
  if (expected) expect(details.explanation).toContain(expected)
})

it('suggests renewal only for the current parked input with a validated renewable scope', () => {
  const base = context()
  const ctx = { ...base, source: { ...base.source, input_status: 'current' },
    input: { ...base.input, registration_id: input, authorized_business_capability_ids: [] },
    run: { status: 'parked', authorization: { status: 'renewal_required', can_renew: true, generation: 1, retry_node_id: 'retry-node',
      scope: { input_revision_id: input, registration_id: input, task_sha256: base.input.task_sha256,
        workflow_id: base.input.workflow_id, workflow_version: base.input.workflow_version, allowed_actions: [], resources: base.input.materials } } } }
  const details = workRunDetails({ ...owned, status: 'parked' }, { ...activity(), status: 'parked' }, ctx)
  expect(details.authorizationRequired).toBe(true)
  expect(details.explanation).toContain('继续执行需要更新本次工作的授权')
  expect(workRunDetails({ ...owned, status: 'parked', isCurrent: false }, { ...activity(), status: 'parked' }, ctx).authorizationRequired).toBe(false)
  expect(workRunDetails({ ...owned, status: 'parked' }, { ...activity(), status: 'parked' }, {
    ...ctx, run: { ...ctx.run, authorization: { ...ctx.run.authorization, status: 'active' } },
  }).authorizationRequired).toBe(false)
})

it('refuses an unowned detail lookup before requesting activity or context', async () => {
  const paths: string[] = []
  const fetchMock = vi.fn(async (value: URL | RequestInfo) => {
    const path = new URL(String(value)).pathname; paths.push(path)
    if (path.endsWith('/__test/approving-account')) return Response.json({ token: 'forge-token', user: { id: 'employee' } })
    if (path.endsWith('/external/exchange')) return Response.json({ token: 'weave-token', subject: { id: 'weave-employee', externalId: 'employee' }, organization: { id: 'workspace' }, issuer: 'forge:deployment', permissions: ['teams:use'] })
    return Response.json({ version: '1', runs: [], missing: ['other-run'] })
  }) as typeof fetch
  const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
  await signInAs(service, 'employee@example.test')
  await expect(service.getWorkRunDetails('other-run')).rejects.toThrow('当前账号无法读取')
  expect(paths.filter((path) => path.includes('/runs/'))).toEqual(['/v1/workbench/runs/lookup'])
})

it('reads owned activity and fixed context with the current session and returns only the safe projection', async () => {
  const calls: string[] = []
  const fetchMock = vi.fn(async (value: URL | RequestInfo, init?: RequestInit) => {
    const path = new URL(String(value)).pathname
    if (path.endsWith('/__test/approving-account')) return Response.json({ token: 'forge-token', user: { id: 'employee' } })
    if (path.endsWith('/external/exchange')) return Response.json({ token: 'weave-token', subject: { id: 'weave-employee', externalId: 'employee' }, organization: { id: 'workspace' }, issuer: 'forge:deployment', permissions: ['teams:use'] })
    calls.push(path)
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer weave-token')
    if (path.endsWith('/lookup')) return Response.json({ version: '1', runs: [{ runId: 'run', inputRevisionId: input, workbenchSessionId: 'session', status: 'failed', isCurrent: true, actionCounts: owned.actionCounts }], missing: [] })
    if (path.endsWith('/activity')) return Response.json(activity())
    if (path.endsWith('/workbench-context')) return Response.json(context())
    throw new Error('Unexpected request')
  }) as typeof fetch
  const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
  await expect(service.getWorkRunDetails('run')).rejects.toThrow('请先登录')
  await signInAs(service, 'employee@example.test')
  await expect(service.getWorkRunDetails('run')).resolves.toMatchObject({ runId: 'run', status: 'failed', materials: [{ name: '合同材料.pdf' }], actionCounts: owned.actionCounts })
  expect(calls).toEqual(['/v1/workbench/runs/lookup', '/v1/runs/run/activity', '/v1/runs/run/workbench-context'])
  await expect(service.getWorkRunDetails(' run ')).rejects.toThrow('范围无效')
})

it('projects authoritative action reasons while keeping run status and hiding unsafe details', () => {
  const outcomes = [
    { node_id: 'node', call_id: 'call', action_name: 'lead_convert', object_name: 'lead', status: 'failed', summary: '业务动作“转为商机”未完成。原因：销售业务设置缺少项目客户分类，请管理员维护。' },
    { node_id: 'node2', call_id: 'call2', action_name: 'contract_submit', object_name: 'contract', status: 'unknown', summary: '业务动作“合同提交”结果未知。token=secret-value /srv/private/file' },
  ]
  const ctx = { ...context(), run: { status: 'succeeded', action_outcomes: outcomes } }
  const details = workRunDetails({ ...owned, status: 'succeeded' }, { ...activity(), status: 'succeeded' }, ctx)
  expect(details.status).toBe('succeeded')
  expect(details.actionOutcomes).toEqual([
    { actionName: '转为商机', status: 'failed', summary: outcomes[0].summary },
    { actionName: '合同提交', status: 'unknown', summary: '未取得可展示的业务原因，请从原工作核对。' },
  ])
  expect(JSON.stringify(details)).not.toMatch(/secret-value|lead_convert|\/srv|call2/)
})

it('lists every missing item a check found and says when one is shown only in part', () => {
  const items = Array.from({ length: 12 }, (_, index) => `第${index + 1}项：${'附件与主件条款不一致，需要补充盖章页。'.repeat(index === 0 ? 20 : 1)}`)
  items.push('超长说明：'.concat('付款节点与验收标准需要逐条核对。'.repeat(200)))
  const summary = '合同存在多处需要补充的内容。'
  const content = JSON.stringify({ disposition: 'needs_input', summary, missing_items: items })
  const ctx = { ...context(), run: { status: 'succeeded', business_result: 'needs_input', final_result: { id: 'result', title: '合同检查', content_type: 'application/json', content, sha256: hash(content), disposition: 'needs_input', summary, missing_items: items } } }
  const details = workRunDetails({ ...owned, status: 'succeeded' }, { ...activity(), status: 'succeeded' }, ctx)
  expect(details.result?.missingItems).toHaveLength(13)
  expect(details.result?.missingItems.slice(0, 12)).toEqual(items.slice(0, 12))
  expect(details.result?.missingItems[12]).toMatch(/^超长说明：.*…$/)
  expect(details.explanation).toContain('这里只展示部分检查意见；完整结果请从“我的工作”的原工作消息查看。')
})
