import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { type NativeMcpActionArguments } from '../../electron/main/enterprise'
import { newEnterpriseService, signInAs } from '../helpers/browser-sign-in'
import { parseCurrentItemActionReceipt } from '../../electron/main/enterprise/approval-actions'
import type { EnterpriseApprovalAction } from '../../src/types/api'

function mcpToolResult(value: unknown) {
  return Response.json({ jsonrpc: '2.0', id: 'test', result: { content: [{ type: 'text', text: JSON.stringify(value) }] } })
}

const nativeActionArgs = {
  actionName: 'sales_contract_send_back', objectName: 'forge_sales_contract', recordId: 'contract-1',
  params: {
    approvalRequestId: 'approval-1', itemVersion: 'item-round-1', sourceMaterialVersion: 'a'.repeat(64),
    comment: '按本轮员工意见退回。',
  },
} satisfies NativeMcpActionArguments

const nativeActionReceipt = {
  decision: 'revise', status: 'returned', requestId: 'approval-1', recordId: 'contract-1',
  itemVersion: 'item-round-1', sourceMaterialVersion: 'a'.repeat(64),
  resumed: false, autoRejected: false, alreadyApplied: false,
}

const selectedNativeAction = {
  label: '退回当前审批', description: '按员工意见退回。',
  execution: {
    tool: 'run_action', actionName: nativeActionArgs.actionName,
    objectName: nativeActionArgs.objectName, recordId: nativeActionArgs.recordId,
    requiresConfirmation: false,
    params: {
      approvalRequestId: nativeActionArgs.params.approvalRequestId,
      itemVersion: nativeActionArgs.params.itemVersion,
      sourceMaterialVersion: nativeActionArgs.params.sourceMaterialVersion,
    },
  },
  inputs: [{ name: 'comment', type: 'string', label: '办理意见', required: true }],
} satisfies EnterpriseApprovalAction

type SalesOrderDecision = 'approve' | 'reject'

function salesOrderApprovalAction(semantic: SalesOrderDecision): EnterpriseApprovalAction {
  return {
    ...selectedNativeAction,
    semantic,
    execution: {
      ...selectedNativeAction.execution,
      actionName: semantic === 'approve' ? 'order_approval_mcp_approve' : 'order_approval_mcp_reject',
      objectName: 'forge_sales_order', recordId: 'order-1',
      params: { approvalRequestId: 'approval-order-1', itemVersion: 'order-item-1', sourceMaterialVersion: 'b'.repeat(64) },
    },
  }
}

function salesOrderApprovalReceipt(semantic: SalesOrderDecision): Record<string, unknown> {
  return {
    decision: semantic,
    status: semantic === 'approve' ? 'approved' : 'rejected',
    businessStatus: semantic === 'approve' ? 'active' : 'cancelled',
    requestId: 'approval-order-1', recordId: 'order-1', itemVersion: 'order-item-1', sourceMaterialVersion: 'b'.repeat(64),
    resumed: false, autoRejected: false, alreadyApplied: false,
  }
}

async function nativeActionFixture(mcpResponse: Response | Error) {
  const calls: string[] = []
  const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    calls.push(path)
    if (path === '/__test/approving-account') return Response.json({ token: 'forge-token', user: { id: 'employee' } })
    if (path === '/v1/auth/external/exchange') return Response.json({ token: 'weave-token', subject: { id: 'employee' }, organization: { id: 'org' }, issuer: 'forge:test-deployment', permissions: ['teams:use'] })
    if (path === '/api/v1/mcp') {
      const request = JSON.parse(String(init?.body)) as { id: string; method: string }
      if (request.method === 'tools/list') return Response.json({ jsonrpc: '2.0', id: request.id,
        result: { tools: [{ name: 'run_action', inputSchema: { type: 'object', required: ['actionName'],
          properties: { actionName: { type: 'string' }, objectName: { type: 'string' }, recordId: { type: 'string' }, params: { type: 'object' } } } }] } })
      if (mcpResponse instanceof Error) throw mcpResponse
      return mcpResponse
    }
    throw new Error(`unexpected request ${path}`)
  }) as typeof globalThis.fetch
  const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge.test', WORKBENCH_WEAVE_URL: 'http://weave.test' }, fetch })
  await signInAs(service, 'employee@example.test')
  return { service, calls }
}

async function serviceFixture(queryStatus = 200) {
  const calls: Array<{ path: string; authorization?: string; body?: Record<string, unknown> }> = []
  const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input)), path = url.pathname
    let body: Record<string, unknown> | undefined
    if (typeof init?.body === 'string') body = JSON.parse(init.body) as Record<string, unknown>
    calls.push({ path, authorization: new Headers(init?.headers).get('Authorization') ?? undefined, body })
    if (path === '/__test/approving-account') return Response.json({ token: 'forge-token', user: { id: 'employee' } })
    if (path === '/v1/auth/external/exchange') return Response.json({ token: 'weave-token', subject: { id: 'employee' }, organization: { id: 'org' }, issuer: 'forge:test-deployment', permissions: ['teams:use'] })
    if (path === '/api/v1/meta/object/sales_quote') return Response.json({
      type: 'object', name: 'sales_quote', item: { name: 'sales_quote', label: '销售报价', fields: [
        { name: 'id', type: 'text', label: 'ID' }, { name: 'name', type: 'text', label: '报价名称' },
        { name: 'code', type: 'text', label: '报价编号' }, { name: 'item_count', type: 'number', label: '明细行数' },
        { name: 'version', type: 'number', label: '版本' },
      ] },
    })
    if (path === '/api/v1/mcp') {
      const tool = String((body?.params as Record<string, unknown> | undefined)?.name)
      if (tool === 'list_objects') return mcpToolResult({ objects: [{ name: 'sales_quote', label: '销售报价', fieldCount: 12 }], totalCount: 1 })
      if (tool === 'describe_object') return mcpToolResult({ name: 'sales_quote', label: '销售报价', fields: [{ name: 'id', type: 'text', label: 'ID' }, { name: 'name', type: 'text', label: '报价名称' }, { name: 'code', type: 'text', label: '报价编号' }], enableFeatures: [] })
      if (tool === 'get_record') return mcpToolResult({ id: 'internal-id', name: '设备交接报价', code: 'Q-240', item_count: 0, version: 3 })
      if (tool === 'query_records' && queryStatus === 403) return Response.json({ error: 'forbidden' }, { status: 403 })
      if (tool === 'query_records') return mcpToolResult({ object: 'sales_quote', records: [{ id: 'internal-id', name: '设备交接报价', code: 'Q-240' }], total: 1, hasMore: false })
    }
    throw new Error(`unexpected request ${path}`)
  }) as typeof globalThis.fetch
  const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge.test', WORKBENCH_WEAVE_URL: 'http://weave.test' }, fetch })
  await signInAs(service, 'employee@example.test')
  return { service, calls }
}

async function continuationFixture(actionOutcomes?: unknown) {
  const task = '按固定工作继续检查。'
  const run = { status: 'succeeded', ...(actionOutcomes !== undefined ? { action_outcomes: actionOutcomes } : {}) }
  const workContext = {
    version: '1',
    source: { input_revision_id: '10000000-0000-4000-8000-000000000001', run_id: 'run-1', workbench_session_id: 'workbench-1' },
    input: {
      task, task_sha256: createHash('sha256').update(task).digest('hex'), team_id: 'team-1', workflow_id: 'workflow-1', workflow_version: 2,
      materials: [], source_messages: [{ message_id: 'employee-message', event_seq: 1, sha256: createHash('sha256').update('继续').digest('hex') }],
    },
    run,
  }
  const fetch = vi.fn(async (input: URL | RequestInfo) => {
    const path = new URL(String(input)).pathname
    if (path === '/__test/approving-account') return Response.json({ token: 'forge-token', user: { id: 'employee' } })
    if (path === '/v1/auth/external/exchange') return Response.json({ token: 'weave-token', subject: { id: 'weave-user', externalId: 'employee' }, organization: { id: 'org' }, issuer: 'forge:test-deployment', permissions: ['teams:use'] })
    if (path === '/v1/runs/run-1/workbench-context') return Response.json(workContext)
    throw new Error(`unexpected request ${path}`)
  }) as typeof globalThis.fetch
  const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge.test', WORKBENCH_WEAVE_URL: 'http://weave.test' }, fetch })
  await signInAs(service, 'employee@example.test')
  return service
}

describe('Forge native MCP object reads', () => {
  it('reads list_objects through the current Forge session and keeps system objects excluded', async () => {
    const f = await serviceFixture()
    const directory = await f.service.getBusinessObjectDirectory()
    expect(directory).toEqual({ objects: [{ objectName: 'sales_quote', label: '销售报价' }], complete: true, totalCount: 1 })
    const request = f.calls.find((call) => call.path === '/api/v1/mcp')!
    expect(request.authorization).toBe('Bearer forge-token')
    expect(request.body).toMatchObject({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'list_objects', arguments: {} } })
  })

  it('keeps a query permission denial distinct from no matches and does not end the login session', async () => {
    const f = await serviceFixture(403)
    await expect(f.service.findBusinessRecords('sales_quote', 'Q-240', 0, 20)).rejects.toMatchObject({ kind: 'forbidden' })
    expect((await f.service.getSession()).status).toBe('signed-in')
    const calls = f.calls.filter((call) => call.path === '/api/v1/mcp')
    expect(calls.map((call) => ((call.body?.params ?? {}) as Record<string, unknown>).name)).toEqual(['list_objects', 'describe_object', 'query_records'])
    expect(calls[2]?.body).toMatchObject({ params: { arguments: { objectName: 'sales_quote', limit: 20, offset: 0 } } })
  })

  it('uses the authorized native metadata endpoint for the selected object relation declaration and get_record for data', async () => {
    const f = await serviceFixture()
    const read = await f.service.readBusinessRecord('sales_quote', 'internal-id')
    expect(read.candidate).toMatchObject({ objectName: 'sales_quote', recordId: 'internal-id', name: '设备交接报价', code: 'Q-240', recordVersion: '3' })
    expect(read.snapshot).toMatchObject({ completeness: 'complete', pricingDetailCompleteness: 'complete', expectedDetailCount: 0 })
    expect(f.calls.some((call) => call.path === '/api/v1/meta/object/sales_quote' && call.authorization === 'Bearer forge-token')).toBe(true)
    expect(f.calls.filter((call) => call.path === '/api/v1/mcp').map((call) => ((call.body?.params ?? {}) as Record<string, unknown>).name)).toEqual(['list_objects', 'get_record'])
    expect(f.calls.every((call) => !JSON.stringify(call.body ?? {}).includes('run_action'))).toBe(true)
  })

  it('preserves Weave action outcomes while leaving an absent field explicitly absent', async () => {
    const service = await continuationFixture([{
      node_id: 'review', call_id: 'call-1', action_name: 'quotation_adjust_line_price', object_name: 'sales_quote',
      record_id: 'record-internal-1', status: 'unknown', summary: 'Forge 动作结果未知，须按当前业务状态核对。',
    }])
    const context = await service.getWorkContinuationContext({ workReference: '10000000-0000-4000-8000-000000000001', runReference: 'run-1', sessionReference: 'workbench-1' })
    expect(context.run.actionOutcomes).toEqual([{
      nodeID: 'review', callID: 'call-1', actionName: 'quotation_adjust_line_price', objectName: 'sales_quote',
      recordID: 'record-internal-1', status: 'unknown', summary: 'Forge 动作结果未知，须按当前业务状态核对。',
    }])

    const missing = await continuationFixture()
    const withoutFacts = await missing.getWorkContinuationContext({ workReference: '10000000-0000-4000-8000-000000000001', runReference: 'run-1', sessionReference: 'workbench-1' })
    expect(withoutFacts.run).not.toHaveProperty('actionOutcomes')
  })

  it('rejects an incomplete action outcome instead of turning it into an empty outcome list', async () => {
    const service = await continuationFixture([{ node_id: 'review', call_id: 'call-1', status: 'succeeded' }])
    await expect(service.getWorkContinuationContext({
      workReference: '10000000-0000-4000-8000-000000000001', runReference: 'run-1', sessionReference: 'workbench-1',
    })).rejects.toThrow('团队业务动作事实不完整')
  })
})

describe('Forge native MCP action receipt envelope', () => {
  it('unwraps the bound ActionEnvelope from MCP content text and preserves strict receipt version checks', async () => {
    const envelope = {
      action: nativeActionArgs.actionName, objectName: nativeActionArgs.objectName, ok: true,
      recordId: nativeActionArgs.recordId, result: nativeActionReceipt,
    }
    const f = await nativeActionFixture(mcpToolResult(envelope))

    const attempt = await f.service.runNativeMcpAction(nativeActionArgs, async () => {}, false, async () => {})

    expect(attempt).toEqual({ status: 'returned', result: nativeActionReceipt })
    expect(parseCurrentItemActionReceipt(attempt.result, selectedNativeAction)).toEqual(nativeActionReceipt)
    expect(parseCurrentItemActionReceipt({ ...nativeActionReceipt, itemVersion: 'item-round-2' }, selectedNativeAction)).toBeUndefined()
    expect(parseCurrentItemActionReceipt({ ...nativeActionReceipt, sourceMaterialVersion: 'b'.repeat(64) }, selectedNativeAction)).toBeUndefined()
    expect(f.calls.filter((path) => path === '/api/v1/mcp')).toHaveLength(2)
  })

  it.each(['approve', 'reject'] as const)('requires the native terminal status and business status for sales-order %s', (semantic) => {
    const action = salesOrderApprovalAction(semantic)
    const receipt = salesOrderApprovalReceipt(semantic)
    const parsed = parseCurrentItemActionReceipt(receipt, action)

    expect(parsed).toEqual(receipt)
    expect(parsed?.resumed).toBe(false)
  })

  it.each([
    ['approval without businessStatus', 'approve', { businessStatus: undefined, resumed: true }],
    ['approval with a nonterminal businessStatus', 'approve', { businessStatus: 'cancelled' }],
    ['approval with a nonterminal native status', 'approve', { status: 'pending', resumed: true }],
    ['approval with a reject decision', 'approve', { decision: 'reject', status: 'rejected', businessStatus: 'cancelled' }],
    ['rejection without businessStatus', 'reject', { businessStatus: undefined, resumed: true }],
    ['rejection with a nonterminal businessStatus', 'reject', { businessStatus: 'active' }],
    ['rejection with a nonterminal native status', 'reject', { status: 'pending' }],
    ['rejection with an approve decision', 'reject', { decision: 'approve', status: 'approved', businessStatus: 'active' }],
  ] as const)('does not accept a sales-order receipt with %s', (_case, semantic, changes) => {
    expect(parseCurrentItemActionReceipt(
      { ...salesOrderApprovalReceipt(semantic), ...changes }, salesOrderApprovalAction(semantic),
    )).toBeUndefined()
  })

  it('requires sales-order decision states even when the selected directory action has no semantic label', () => {
    const action = { ...salesOrderApprovalAction('approve'), semantic: undefined }
    expect(parseCurrentItemActionReceipt(
      { ...salesOrderApprovalReceipt('approve'), status: 'pending' }, action,
    )).toBeUndefined()
  })

  it.each(['requestId', 'recordId', 'itemVersion', 'sourceMaterialVersion'] as const)(
    'keeps sales-order approval receipts bound to the selected %s', (field) => {
      const receipt = salesOrderApprovalReceipt('approve')
      receipt[field] = 'another-version'
      expect(parseCurrentItemActionReceipt(receipt, salesOrderApprovalAction('approve'))).toBeUndefined()
    },
  )

  it('preserves the existing sales-contract receipt shape without businessStatus', () => {
    const receipt = parseCurrentItemActionReceipt({ ...nativeActionReceipt, businessStatus: 'active' }, selectedNativeAction)
    expect(receipt).toEqual(nativeActionReceipt)
    expect(receipt).not.toHaveProperty('businessStatus')
  })

  it('accepts only a recalled receipt bound to the curated order-recall action', () => {
    const recallAction: EnterpriseApprovalAction = {
      ...selectedNativeAction,
      semantic: 'recall',
      execution: {
        ...selectedNativeAction.execution,
        actionName: 'order_approval_mcp_recall', objectName: 'forge_sales_order', recordId: 'order-1',
        params: { approvalRequestId: 'approval-1', itemVersion: 'item-round-1', sourceMaterialVersion: 'a'.repeat(64) },
      },
    }
    const receipt = {
      decision: 'recall', status: 'recalled', requestId: 'approval-1', recordId: 'order-1',
      itemVersion: 'item-round-1', sourceMaterialVersion: 'a'.repeat(64), businessStatus: 'cancelled', resumed: false, autoRejected: false, alreadyApplied: false,
    }
    expect(parseCurrentItemActionReceipt(receipt, recallAction)).toEqual(receipt)
    expect(parseCurrentItemActionReceipt({ ...receipt, status: 'cancelled' }, recallAction)).toBeUndefined()
    expect(parseCurrentItemActionReceipt({ ...receipt, decision: 'reject', status: 'rejected' }, recallAction)).toBeUndefined()
    const recalledOnly: Record<string, unknown> = { ...receipt }
    delete recalledOnly.businessStatus
    expect(parseCurrentItemActionReceipt(recalledOnly, recallAction)).toBeUndefined()
    expect(parseCurrentItemActionReceipt({ ...receipt, businessStatus: 'pending_approval' }, recallAction)).toBeUndefined()
    expect(parseCurrentItemActionReceipt(receipt, { ...recallAction, semantic: 'approve' })).toBeUndefined()
    expect(parseCurrentItemActionReceipt(receipt, { ...recallAction, execution: { ...recallAction.execution, actionName: 'another_recall' } })).toBeUndefined()
  })

  it.each(['action', 'objectName', 'recordId', 'ok'] as const)('keeps a mismatched ActionEnvelope %s unknown', async (field) => {
    const envelope: Record<string, unknown> = {
      action: nativeActionArgs.actionName, objectName: nativeActionArgs.objectName, ok: true,
      recordId: nativeActionArgs.recordId, result: nativeActionReceipt,
    }
    envelope[field] = field === 'ok' ? false : 'another-action'
    const f = await nativeActionFixture(mcpToolResult(envelope))

    const attempt = await f.service.runNativeMcpAction(nativeActionArgs, async () => {}, false, async () => {})

    expect(attempt.status).toBe('unknown')
    expect(f.calls.filter((path) => path === '/api/v1/mcp')).toHaveLength(2)
  })

  it('keeps a transport exception unknown and does not retry the native action POST', async () => {
    const f = await nativeActionFixture(new Error('simulated response loss'))

    const attempt = await f.service.runNativeMcpAction(nativeActionArgs, async () => {}, false, async () => {})

    expect(attempt.status).toBe('unknown')
    expect(f.calls.filter((path) => path === '/api/v1/mcp')).toHaveLength(2)
  })
})
