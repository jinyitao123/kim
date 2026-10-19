import { expect, it, vi } from 'vitest'
import { newEnterpriseService, signInAs } from '../helpers/browser-sign-in'
import { inboxWorkItems, parseApprovalWorkPage, parseRunLookup } from '../../electron/main/enterprise/work-sources'

const updatedAt = '2026-10-01T00:00:00Z'

it('accepts only the submitted approval list mode', () => {
  expect(parseApprovalWorkPage({ version: '1', items: [{ requestId: 'approval-1', mode: 'submitted', title: '订单复核', updatedAt }] }))
    .toMatchObject({ items: [{ requestId: 'approval-1', mode: 'submitted' }] })
  expect(() => parseApprovalWorkPage({ version: '1', items: [{ requestId: 'approval-1', mode: 'recall', title: '订单复核', updatedAt }] }))
    .toThrow('无法识别的审批事项')
})

function lookup(runId: string) { return { runId, inputRevisionId: `input-${runId}`, workbenchSessionId: `session-${runId}`, status: 'parked', isCurrent: true, businessResult: 'needs_input', actionCounts: { succeeded: 0, failed: 0, unknown: 0 } } }
function loginFetch(route: (path: string, query: URLSearchParams, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname === '/__test/approving-account') return Response.json({ token: 'native-session', user: { id: 'employee' } })
    if (url.pathname === '/v1/auth/external/exchange') return Response.json({ token: 'weave-session', subject: { id: 'weave-employee', externalId: 'employee' }, organization: { id: 'workspace' }, issuer: 'forge:deployment', permissions: ['teams:use'] })
    if (url.pathname === '/v1/teams') return Response.json([])
    if (url.pathname === '/v1/runs') return Response.json({ runs: [] })
    if (url.pathname === '/api/v1/workbench/approvals') return Response.json({ version: '1', items: [] })
    return route(url.pathname, url.searchParams, init)
  }) as typeof fetch
}

it('reads only account-owned requested runs and strips internal work/source references from the card projection', async () => {
  const batches: string[][] = []
  const fetchMock = loginFetch((path, _query, init) => {
    expect(path).toBe('/v1/workbench/runs/lookup')
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer weave-session')
    const { runIds } = JSON.parse(String(init?.body)) as { runIds: string[] }
    batches.push(runIds)
    return Response.json({ version: '1', runs: runIds.filter((id) => id !== 'unowned').map(lookup), missing: runIds.includes('unowned') ? ['unowned'] : [] })
  })
  const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
  await expect(service.getWorkRunStates(['run'])).rejects.toThrow('请先登录')
  await signInAs(service, 'employee@example.test')
  const ids = [...Array.from({ length: 101 }, (_, index) => `run-${index}`), 'unowned', 'run-0']
  const states = await service.getWorkRunStates(ids)
  expect(batches.map((batch) => batch.length)).toEqual([100, 2])
  expect(states.missing).toEqual(['unowned'])
  expect(states.runs[0]).toEqual({ runId: 'run-0', status: 'parked', isCurrent: true, businessResult: 'needs_input' })
  await expect(service.getWorkRunStates(Array(1001).fill('run'))).rejects.toThrow('范围无效')
  await expect(service.getWorkRunStates([{} as string])).rejects.toThrow('范围无效')
})

it('rejects card status responses after the signed-in account changes', async () => {
  let resolveLookup!: (response: Response) => void
  const fetchMock = loginFetch(() => new Promise<Response>((resolve) => { resolveLookup = resolve }))
  const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
  await signInAs(service, 'employee@example.test')
  const reading = service.getWorkRunStates(['run'])
  const rejected = expect(reading).rejects.toThrow()
  await vi.waitFor(() => expect(resolveLookup).toBeTypeOf('function'))
  await signInAs(service, 'other@example.test')
  resolveLookup(Response.json({ version: '1', runs: [lookup('run')], missing: [] }))
  await rejected
})

it('keeps unknown native topics generic despite forged kind and Weave references in their payload', () => {
  const items = inboxWorkItems(['work.revision_required', 'business.error', 'weave.team_run.result.extra', 'weave.team_run.revision_required'].map((type, index) => ({
    id: `notice-${index}`, title: '工作消息', type, createdAt: updatedAt,
    data: { kind: 'revision_required', source: { system: 'weave', workReference: 'forged-input', runReference: 'forged-run', sessionReference: 'forged-session' } },
  })))
  expect(items.slice(0, 3)).toMatchObject(Array.from({ length: 3 }, () => ({ kind: 'notification', actionable: false, source: 'forge' })))
  expect(items[3]).toMatchObject({ kind: 'revision_required', actionable: true, source: 'weave' })
  expect(items.some((item) => item.workReference || item.runReference || item.sessionReference)).toBe(false)
})

it('keeps execution diagnostics out of employee failure messages without inventing action results', () => {
  const [item] = inboxWorkItems([{ id: 'failure-notice', title: '团队处理失败', type: 'weave.team_run.failure', createdAt: updatedAt,
    body: 'team_run_node_output_invalid: node step-550e8400-e29b-41d4-a716-446655440000 failed at /Users/private/work' }])
  expect(item.summary).toContain('核对结果及业务动作回执')
  expect(item.summary).not.toMatch(/team_run|550e8400|\/Users|0条|成功/)
  expect(item).toMatchObject({ kind: 'failure', source: 'weave', actionable: false })
})

it.each([
  { runs: [lookup('run'), lookup('run')], missing: [] },
  { runs: [lookup('run')], missing: ['run'] },
  { runs: [{ ...lookup('run'), actionCounts: { succeeded: -1, failed: 0, unknown: 0 } }], missing: [] },
  { runs: [{ ...lookup('run'), isCurrent: 'true' }], missing: [] },
  { runs: [{ ...lookup('run'), businessResult: 'unknown' }], missing: [] },
])('rejects malformed or duplicate authoritative run lookup tuples', ({ runs, missing }) => {
  expect(() => parseRunLookup({ version: '1', runs, missing })).toThrow('团队运行状态')
})

it('reads and verifies all 251 actionable native inbox entries and batches run lookup without dropping older work', async () => {
  const runIDs = Array.from({ length: 251 }, (_, index) => `run-${index}`), lookupBatches: string[][] = []
  const notices = runIDs.map((runId) => ({ id: `notice-${runId}`, title: '合同需要补充', type: 'weave.team_run.revision_required', createdAt: updatedAt }))
  const fetchMock = loginFetch((path, query, init) => {
    if (path === '/api/v1/apps/forge/workbench/inbox') {
      const offset = Number(query.get('cursor') ?? 0)
      return Response.json({ version: '1', notifications: notices.slice(offset, offset + 100), has_more: offset + 100 < notices.length, next_cursor: offset + 100 < notices.length ? String(offset + 100) : null })
    }
    const runId = path.match(/notifications\/notice-(run-\d+)\/source$/)?.[1]
    if (runId) {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer native-session')
      return Response.json({ version: '1', notificationId: `notice-${runId}`, kind: 'revision_required', source: { system: 'weave', workReference: `input-${runId}`, runReference: runId, sessionReference: `session-${runId}` } })
    }
    if (path === '/v1/workbench/runs/lookup') {
      const body = JSON.parse(String(init?.body)) as { version: string; runIds: string[] }
      expect(body.version).toBe('1'); lookupBatches.push(body.runIds)
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer weave-session')
      expect(new Headers(init?.headers).has('X-Weave-Forge-Authorization')).toBe(false)
      return Response.json({ version: '1', runs: body.runIds.map(lookup), missing: [] })
    }
    return Response.json({}, { status: 404 })
  })
  const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
  await signInAs(service, 'employee')
  const overview = await service.getWorkOverview()
  expect(lookupBatches.map((batch) => batch.length)).toEqual([100, 100, 51])
  expect(lookupBatches.flat()).toEqual(runIDs)
  expect(overview.items).toHaveLength(251)
  expect(overview.items.every((item) => item.actionable && item.status === 'pending')).toBe(true)
  expect(overview.items.at(-1)).toMatchObject({ id: 'notice-run-250', runReference: 'run-250' })
  expect(overview.reads.notifications).toEqual({ status: 'loaded' })
  expect(vi.mocked(fetchMock).mock.calls.some(([input]) => String(input).includes('/v1/human-tasks?'))).toBe(false)
})

it.each(['valid', 'mismatched-input', 'malformed-detail', 'retired-interaction'] as const)('opens a human review only from exact owned inbox and detail references: %s', async (mode) => {
  const fetchMock = loginFetch((path, query) => {
    if (path === '/api/v1/apps/forge/workbench/inbox') return Response.json({ version: '1', notifications: [{ id: 'human-notice', type: 'weave.team_run.human_review', title: '本人团队等待复核', createdAt: updatedAt }], has_more: false, next_cursor: null })
    if (path === '/api/v1/workbench/notifications/human-notice/source') return Response.json({ version: '1', notificationId: 'human-notice', kind: 'human_review', source: { system: 'weave', workReference: 'input-run', runReference: 'run', sessionReference: 'session-run', interactionReference: 'interaction' } })
    if (path === '/v1/workbench/runs/lookup') return Response.json({ version: '1', runs: [lookup('run')], missing: [] })
    if (path === '/v1/human-tasks/run') {
      expect(Object.fromEntries(query)).toEqual({ input_revision_id: 'input-run', workbench_session_id: 'session-run', interaction_id: 'interaction' })
      return Response.json({ run_id: 'run', interaction_id: mode === 'retired-interaction' ? 'another-interaction' : 'interaction', input_revision_id: mode === 'mismatched-input' ? 'another-input' : 'input-run', workbench_session_id: 'session-run', team_id: 'team', workflow_id: 'workflow', workflow_version: 1, title: '员工复核', instructions: mode === 'malformed-detail' ? '' : '核对材料', updated_at: updatedAt })
    }
    return Response.json({}, { status: 404 })
  })
  const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch: fetchMock })
  await signInAs(service, 'employee')
  const overview = await service.getWorkOverview()
  if (mode === 'valid') {
    expect(overview.tasks).toMatchObject([{ interactionId: 'interaction', runId: 'run', inputRevisionID: 'input-run', workbenchSessionID: 'session-run' }])
    expect(overview.items).toEqual([])
  } else if (mode === 'retired-interaction') {
    expect(overview.tasks).toEqual([])
    expect(overview.items[0]).toMatchObject({ actionable: false, status: 'completed' })
  } else {
    expect(overview.tasks).toEqual([])
    expect(overview.items[0]).toMatchObject({ actionable: false, status: 'unknown' })
    expect(overview.reads.weaveTasks.status).toBe('failed')
  }
  expect(vi.mocked(fetchMock).mock.calls.some(([input]) => String(input).includes('/v1/human-tasks?'))).toBe(false)
})
