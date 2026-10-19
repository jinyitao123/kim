import { describe, expect, it, vi } from 'vitest'
import type { EnterpriseApprovalContext } from '../../src/types/api'
import { approvalUiChoices, completeViewedApproval, type ApprovalUiAttempt } from '../../electron/main/enterprise/approval-ui-actions'
import { currentItemContextFingerprint } from '../../electron/main/enterprise/approval-context-binding'
import { digest } from '../../electron/main/enterprise/handoff-store'

function fixture(semantic = 'reject', objectName = 'forge_sales_order', viewer: EnterpriseApprovalContext['viewer'] = 'current_approver') {
  const context: EnterpriseApprovalContext = {
    requestId: 'approval-current', status: 'pending', viewer, title: '当前审批', step: '员工复核',
    businessObject: { objectName, recordId: 'record-current' }, sourceMaterialVersion: 'a'.repeat(64), fields: [], files: [],
    availableActions: [{ semantic, label: semantic === 'recall' ? '撤回订单审批' : semantic === 'reject' ? '拒绝订单' : semantic === 'revise' ? '退回修改' : '同意', description: '当前原生动作',
      execution: { tool: 'run_action', actionName: semantic === 'recall' ? 'order_approval_mcp_recall' : `native_${semantic}`, objectName, recordId: 'record-current', requiresConfirmation: false, params: { approvalRequestId: 'approval-current', itemVersion: 'item-before', sourceMaterialVersion: 'a'.repeat(64) } },
      inputs: [{ name: 'comment', type: 'string', label: '意见', required: true }],
    }],
  }
  const result = { decision: semantic, status: semantic === 'recall' ? 'recalled' : semantic === 'reject' ? 'rejected' : semantic === 'revise' ? 'returned' : 'approved',
    requestId: context.requestId, recordId: context.businessObject.recordId, itemVersion: 'item-before', sourceMaterialVersion: context.sourceMaterialVersion,
    ...(semantic === 'recall' || semantic === 'reject' && objectName === 'forge_sales_order' ? { businessStatus: 'cancelled' }
      : semantic === 'approve' && objectName === 'forge_sales_order' ? { businessStatus: 'active' } : {}),
    resumed: true, autoRejected: false, alreadyApplied: false }
  const service = { getApprovalContext: vi.fn(async () => structuredClone(context)), runNativeMcpAction: vi.fn(async () => ({ status: 'returned' as const, result })) }
  const view = approvalUiChoices(context)
  const action = context.availableActions![0]!
  const payload = { actionRef: view.actions?.[0]?.actionRef ?? digest(JSON.stringify(action)), actionVersion: view.actionVersion ?? currentItemContextFingerprint(context), comment: '本人明确的本次意见' }
  const attempts = new Map<string, ApprovalUiAttempt>()
  const assertCurrent = vi.fn()
  const runId = viewer === 'original_submitter' ? 'forge:submitted:approval-current' : 'forge:approval:approval-current'
  const run = (input: Record<string, unknown> = payload) => completeViewedApproval(service, context.requestId, runId, 'employee-a', input, attempts, assertCurrent)
  return { context, service, view, payload, result, attempts, assertCurrent, run, runId }
}

describe('work page native approval actions', () => {
  it.each([['reject', 'forge_sales_order'], ['revise', 'forge_sales_contract'], ['approve', 'another_business_object']])('uses the declared %s action without an object-specific mapping', async (semantic, objectName) => {
    const f = fixture(semantic, objectName)
    expect(JSON.stringify(f.view)).not.toContain('record-current')
    expect(JSON.stringify(f.view)).not.toContain('item-before')
    expect(f.view.actions![0].semantic).toBe(semantic)
    expect(await f.run()).toEqual({ runId: 'forge:approval:approval-current', repeated: false })
    expect(f.service.runNativeMcpAction).toHaveBeenCalledWith({ actionName: `native_${semantic}`, objectName, recordId: 'record-current',
      params: { approvalRequestId: 'approval-current', itemVersion: 'item-before', sourceMaterialVersion: 'a'.repeat(64), comment: f.payload.comment } }, expect.any(Function), false, expect.any(Function))
  })
  it('accepts a matched rejection receipt after the native request becomes terminal', async () => {
    const f = fixture()
    f.service.runNativeMcpAction.mockImplementation(async () => {
      f.service.getApprovalContext.mockRejectedValue(new Error('current item no longer readable'))
      return { status: 'returned', result: f.result }
    })
    expect(await f.run()).toHaveProperty('runId')
    expect(f.service.getApprovalContext).toHaveBeenCalledOnce()
  })
  it('uses only the frozen recall directory for a pending order submitter', async () => {
    const f = fixture('recall', 'forge_sales_order', 'original_submitter')
    expect(f.view.actions).toEqual([{ actionRef: f.payload.actionRef, semantic: 'recall', label: '撤回订单审批' }])
    expect(await f.run()).toEqual({ runId: 'forge:submitted:approval-current', repeated: false })
    expect(f.service.runNativeMcpAction).toHaveBeenCalledWith({ actionName: 'order_approval_mcp_recall', objectName: 'forge_sales_order', recordId: 'record-current',
      params: { approvalRequestId: 'approval-current', itemVersion: 'item-before', sourceMaterialVersion: 'a'.repeat(64), comment: f.payload.comment } }, expect.any(Function), false, expect.any(Function))
  })
  it('keeps a submitter recall bound to the displayed item version and never repeats an unknown result', async () => {
    const stale = fixture('recall', 'forge_sales_order', 'original_submitter')
    await expect(stale.run({ ...stale.payload, actionVersion: 'c'.repeat(64) })).rejects.toThrow('版本已变化')
    expect(stale.service.runNativeMcpAction).not.toHaveBeenCalled()

    const unknown = fixture('recall', 'forge_sales_order', 'original_submitter')
    unknown.result.status = 'cancelled'
    await expect(unknown.run()).rejects.toThrow('结果仍待核对')
    await expect(unknown.run()).rejects.toThrow('结果仍待核对')
    expect(unknown.service.runNativeMcpAction).toHaveBeenCalledOnce()
  })
  it('does not expose or execute recall for an approver or a non-order submitter', async () => {
    const reviewer = fixture('recall', 'forge_sales_order')
    expect(reviewer.view.actions).toEqual([])
    await expect(reviewer.run()).rejects.toThrow('无权执行此审批动作')
    expect(reviewer.service.runNativeMcpAction).not.toHaveBeenCalled()

    const otherSubmitter = fixture('recall', 'forge_sales_contract', 'original_submitter')
    expect(otherSubmitter.view.actions).toBeUndefined()
    await expect(otherSubmitter.run()).rejects.toThrow('无权执行此审批动作')
    expect(otherSubmitter.service.runNativeMcpAction).not.toHaveBeenCalled()
  })
  it('refuses stale displayed versions, unknown references, injected targets and empty opinions before native execution', async () => {
    const f = fixture()
    await expect(f.run({ ...f.payload, actionVersion: 'c'.repeat(64) })).rejects.toThrow('版本已变化')
    await expect(f.run({ ...f.payload, actionRef: 'd'.repeat(64) })).rejects.toThrow('不属于')
    await expect(f.run({ ...f.payload, recordId: 'another-record' })).rejects.toThrow()
    await expect(f.run({ ...f.payload, comment: ' ' })).rejects.toThrow('填写办理意见')
    expect(f.service.runNativeMcpAction).not.toHaveBeenCalled()
  })
  it('shares one in-flight native call and refuses a different opinion for the same viewed version', async () => {
    const f = fixture()
    await Promise.all([f.run(), f.run()])
    expect(f.service.runNativeMcpAction).toHaveBeenCalledOnce()
    await expect(f.run({ ...f.payload, comment: '改成另一意见' })).rejects.toThrow('不能替换')
    expect(f.service.runNativeMcpAction).toHaveBeenCalledOnce()
  })
  it('keeps a mismatched or missing native receipt unknown and never replays it on another click', async () => {
    const f = fixture()
    f.result.sourceMaterialVersion = 'b'.repeat(64)
    await expect(f.run()).rejects.toThrow('结果仍待核对')
    await expect(f.run()).rejects.toThrow('结果仍待核对')
    expect(f.service.runNativeMcpAction).toHaveBeenCalledOnce()
  })
  it('rejects an identity change during the context read and provides no direct actions without server semantics', async () => {
    const f = fixture()
    f.service.getApprovalContext.mockImplementation(async () => { f.assertCurrent.mockImplementation(() => { throw new Error('账号已变化') }); return f.context })
    await expect(f.run()).rejects.toThrow('账号已变化')
    expect(f.service.runNativeMcpAction).not.toHaveBeenCalled()
    delete f.context.availableActions![0].semantic
    expect(approvalUiChoices(f.context).actions).toEqual([])
    expect(approvalUiChoices({ ...f.context, status: 'returned', viewer: 'original_submitter' })).toEqual({})
  })
})
