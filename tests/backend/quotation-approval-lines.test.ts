import { describe, expect, it } from 'vitest'
import { parseQuotationApprovalLines } from '../../electron/main/enterprise/quotation-approval-lines'
import { currentItemContextFingerprint } from '../../electron/main/enterprise/approval-context-binding'
import { quotationApprovalText } from '../../src/lib/quotation-approval-presentation'
import type { EnterpriseApprovalContext, QuotationApprovalLines } from '../../src/types/api'
import { approvalContextView } from '../../electron/main/enterprise'
import { newEnterpriseService, signInAs } from '../helpers/browser-sign-in'

function fixture(): QuotationApprovalLines {
  return { version: '1', pricingVersion: 1, itemCount: 2, totalAmount: 2100, rows: [
    { position: 1, name: '设备', lineType: 'material', quantity: 2, taxedUnitPrice: 900, taxRate: 0, discountRate: 0, taxedSubtotal: 1800, unitName: '台' },
    { position: 2, name: '安装培训', lineType: 'service', quantity: 1, taxedUnitPrice: 300, taxRate: 0, discountRate: 0, taxedSubtotal: 300 },
  ] }
}
describe('native quotation approval frozen lines', () => {
  it('preserves complete business facts and never treats legacy absence as complete', () => {
    expect(parseQuotationApprovalLines(fixture(), 'forge_quotation')).toEqual(fixture())
    expect(parseQuotationApprovalLines(undefined, 'forge_quotation')).toBeUndefined()
    expect(quotationApprovalText(fixture())).toContain('数量 2 台，含税单价 900')
    expect(quotationApprovalText(fixture())).toContain('当前打开仍只授权查看')
    expect(quotationApprovalText(undefined)).toBe('')
  })
  it('rejects incomplete, reordered, wrong-object and inconsistent versions or amounts', () => {
    const f = fixture()
    for (const invalid of [{ ...f, itemCount: 3 }, { ...f, rows: [f.rows[1], f.rows[0]] }, { ...f, totalAmount: 2300 },
      { ...f, pricingVersion: 1.5 }, { ...f, rows: [{ ...f.rows[0], taxedSubtotal: 2000 }, f.rows[1]] },
      { ...f, rows: [{ ...f.rows[0], quantity: 0 }, f.rows[1]] }, { ...f, rows: [{ ...f.rows[0], taxRate: 101 }, f.rows[1]] }]) {
      expect(() => parseQuotationApprovalLines(invalid, 'forge_quotation')).toThrow()
    }
    expect(() => parseQuotationApprovalLines(f, 'forge_sales_contract')).toThrow()
  })
  it('rejects internal identifiers, cost fields, non-finite data and extra payloads', () => {
    const f = fixture()
    for (const extra of [{ lineId: 'hidden-line' }, { costPrice: 500 }, { quantity: Infinity }, { businessAuthorization: true }]) {
      expect(() => parseQuotationApprovalLines({ ...f, rows: [{ ...f.rows[0], ...extra }, f.rows[1]] }, 'forge_quotation')).toThrow()
    }
    expect(() => parseQuotationApprovalLines({ ...f, accountId: 'hidden-account' }, 'forge_quotation')).toThrow()
  })
  it('binds rows to the viewed action version even when the outer material digest is unchanged', () => {
    const context: EnterpriseApprovalContext = { requestId: 'request', status: 'pending', viewer: 'current_approver', title: '报价', step: '复核',
      businessObject: { objectName: 'forge_quotation', recordId: 'quote' }, sourceMaterialVersion: 'a'.repeat(64), fields: [], files: [], quotationLines: fixture() }
    const first = currentItemContextFingerprint(context)
    expect(first).not.toBe(currentItemContextFingerprint({ ...context, quotationLines: undefined }))
    expect(first).not.toBe(currentItemContextFingerprint({ ...context, quotationLines: { ...fixture(), rows: [{ ...fixture().rows[0], name: '另一设备' }, fixture().rows[1]] } }))
  })
  it('keeps complete rows through authenticated context parsing and safe cloning while legacy quotes cannot approve', async () => {
    let lines: unknown = fixture()
    const sourceMaterialVersion = 'b'.repeat(64)
    const actions = ['approve', 'reject'].map(semantic => ({ semantic, label: semantic === 'approve' ? '同意报价' : '驳回报价', description: '办理当前报价审批',
      execution: { tool: 'run_action', actionName: `quotation_approval_mcp_${semantic}`, objectName: 'forge_quotation', recordId: 'quote', requiresConfirmation: true,
        params: { approvalRequestId: 'request', itemVersion: 'item-1', sourceMaterialVersion } }, inputs: [{ name: 'comment', type: 'string', label: '意见', required: true }] }))
    const fetch = async (input: URL | RequestInfo) => {
      const url = String(input)
      if (url.endsWith('/__test/approving-account')) return Response.json({ token: 'fixture-forge', user: { id: 'reviewer' }, session: { activeOrganizationId: 'org' } })
      if (url.endsWith('/v1/auth/external/exchange')) return Response.json({ token: 'fixture-weave', subject: { id: 'mapped-reviewer', externalId: 'reviewer' }, organization: { id: 'org' }, issuer: 'forge:test', permissions: ['teams:use'] })
      if (url.endsWith('/workbench-context')) return Response.json({ version: '1', requestId: 'request', status: 'pending', viewer: 'current_approver', title: '报价', step: '复核',
        businessObject: { objectName: 'forge_quotation', recordId: 'quote' }, sourceMaterialVersion, fields: [], files: [], quotationLines: lines, availableActions: actions })
      return Response.json({}, { status: 404 })
    }
    const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge', WORKBENCH_WEAVE_URL: 'http://weave' }, fetch })
    await signInAs(service, 'reviewer@example.test')
    const context = await service.getApprovalContext('request')
    expect(context.quotationLines).toEqual(fixture())
    const view = approvalContextView(context)
    view.quotationLines!.rows[0].name = 'renderer-changed'
    expect(context.quotationLines!.rows[0].name).toBe('设备')
    lines = undefined
    const legacy = await service.getApprovalContext('request')
    expect(legacy.quotationLines).toBeUndefined()
    expect(legacy.availableActions?.map(action => action.semantic)).toEqual(['reject'])
    lines = { ...fixture(), rows: [{ ...fixture().rows[0], lineId: 'internal-id' }, fixture().rows[1]] }
    await expect(service.getApprovalContext('request')).rejects.toThrow()
  })
})
