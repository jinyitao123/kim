import { describe, expect, it } from 'vitest'
import { ForgeBusinessReader } from '../../electron/main/enterprise/business-records'
import { prepareEmployeeBusinessOpen, verifyEmployeeBusinessOpen } from '../../electron/main/enterprise/employee-business-open'
import { canonicalBusinessJSON } from '../../electron/main/enterprise/employee-business-contract'
import { digest } from '../../electron/main/enterprise/handoff-store'
import type { EmployeeBusinessContext, EmployeeBusinessSelection } from '../../src/types/employee-business'

const uuid = '10000000-0000-4000-8000-000000000001'
const fields = [
  { name: 'name', label: '合同名称', type: 'text' },
  { name: 'status', label: '审核状态', type: 'select', options: [{ value: 'approved', label: '内部复核通过' }] },
  { name: 'amount', label: '合同金额', type: 'currency' },
  { name: 'requires_legal_review', label: '需要法务复核', type: 'boolean' },
  { name: 'signed_on', label: '签订日期', type: 'date' },
  { name: 'scope', label: '交付范围', type: 'text' },
  { name: 'note', label: '备注', type: 'textarea' },
  { name: 'empty', label: '空值', type: 'text' },
  { name: 'terms', label: '条款摘要', type: 'textarea' },
  { name: 'created_at', label: 'CreatedAt', type: 'datetime' },
  { name: 'lastModifiedAt', label: 'LastModifiedAt', type: 'datetime' },
  { name: 'record_version', label: '记录版本', type: 'number', hidden: true },
  { name: 'pricing_version', label: '核价版本', type: 'number', hidden: true },
  { name: 'signed_evidence_sha256', label: '签署原件摘要', type: 'text', hidden: true },
  { name: 'draft_request_signature', label: '草稿请求摘要', type: 'text', hidden: true },
  { name: 'submitted_attachment_manifest', label: '本次提交附件清单', type: 'textarea', hidden: true },
  { name: 'extra', label: '材料信息', type: 'textarea' },
  { name: 'details', label: '数据内容', type: 'json' },
  { name: 'other', label: '参考说明', type: 'text' },
  { name: 'receipt_path', label: '原件位置', type: 'text' },
  { name: 'tracking', label: '跟踪数据', type: 'text' },
  { name: 'system_note', label: '系统备注', type: 'text', system: true },
]

function fixture() {
  const row: Record<string, unknown> = {
    id: uuid, name: '设备采购合同', status: 'approved', amount: 0, requires_legal_review: false,
    signed_on: '2026-10-03', scope: '设备 / 服务', note: ' ', empty: null, terms: '按约定交付和验收。'.repeat(100),
    created_at: '2026-01-01T00:00:00Z', lastModifiedAt: '2026-02-01T00:00:00Z', record_version: 7, pricing_version: 12,
    signed_evidence_sha256: 'a'.repeat(64), draft_request_signature: 'b'.repeat(32),
    submitted_attachment_manifest: JSON.stringify([{ file_id: uuid, sha256: 'c'.repeat(64) }]),
    extra: '{"internal_reference":"machine-only"}', details: { machine_value: 'machine-only' },
    other: `内部引用 ${uuid}`, receipt_path: '/private/tmp/internal-contract.pdf', tracking: 'd'.repeat(64), system_note: 'system-only',
  }
  const reader = new ForgeBusinessReader(async (tool) => {
    if (tool === 'list_objects') return { objects: [{ name: 'forge_sales_contract', label: '销售合同' }], totalCount: 1 }
    if (tool === 'get_record') return structuredClone(row)
    throw new Error(`unexpected tool ${tool}`)
  }, async () => ({ name: 'forge_sales_contract', fields }))
  const record = { objectName: 'forge_sales_contract', recordId: uuid, label: '设备采购合同' }
  const service = {
    accountKey: async () => 'employee-a',
    getEmployeeBusinessContext: async (selection: EmployeeBusinessSelection): Promise<EmployeeBusinessContext> => ({
      ...selection, version: '1', contextId: uuid, contextVersion: 'e'.repeat(64), recordVersion: '7',
      expiresAt: new Date(Date.now() + 60_000).toISOString(), readOnly: true, actions: [],
    }),
    readBusinessRecord: async () => reader.readRecord(record.objectName, record.recordId, 1),
  }
  return { row, record, service }
}

describe('employee business display and fixed source', () => {
  it('uses native visibility and readable scalars for the opening excerpt while preserving the complete tool snapshot', async () => {
    const f = fixture()
    const read = await f.service.readBusinessRecord()
    const original = structuredClone(read.snapshot)
    const { pending, prompt } = await prepareEmployeeBusinessOpen(f.service, f.record)
    expect(prompt).toContain('审核状态：内部复核通过')
    expect(prompt).toContain('合同金额：0')
    expect(prompt).toContain('需要法务复核：否')
    expect(prompt).toContain('签订日期：2026-10-03')
    expect(prompt).toContain('交付范围：设备 / 服务')
    expect(prompt).toContain('部分较长字段只展示摘录')
    expect(prompt).toContain('关联明细和原件未在此展开')
    for (const hidden of ['CreatedAt', 'LastModifiedAt', '核价版本', '记录版本', '签署原件摘要', '草稿请求摘要', '本次提交附件清单', '材料信息', '数据内容', '参考说明', '原件位置', '跟踪数据', '系统备注', '空值', '备注：', uuid, 'machine-only', 'system-only', 'a'.repeat(64), 'b'.repeat(32), '/private/tmp', 'approved', 'complete']) expect(prompt).not.toContain(hidden)
    expect(read.snapshot).toEqual(original)
    expect(read.snapshot).toMatchObject({ domainVersion: '7', record: expect.arrayContaining([
      { label: '核价版本', value: 12 }, { label: '签署原件摘要', value: 'a'.repeat(64) },
      { label: '本次提交附件清单', value: f.row.submitted_attachment_manifest },
    ]) })
    const { capturedAt: _time, ...snapshot } = read.snapshot
    expect(pending.snapshotDigest).toBe(digest(canonicalBusinessJSON({ candidate: read.candidate, snapshot })))
    await expect(verifyEmployeeBusinessOpen(f.service, pending, prompt)).resolves.toBeUndefined()
    f.row.pricing_version = 13
    await expect(verifyEmployeeBusinessOpen(f.service, pending, prompt)).rejects.toThrow('业务记录或可办理范围已变化')
  })
})
