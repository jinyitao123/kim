import type { EmployeeBusinessWork } from '../../../src/types/employee-business'
import { rejectUnknownKeys, requireRecord, requireString } from '../validation'
const kinds = ['quotation_follow_up', 'contract_signature', 'contract_order_conditions', 'contract_prepayment', 'prepayment_confirmation', 'sales_order_creation', 'sales_order_submission', 'project_start']
const text = (value: unknown, max = 128) => requireString(value, '本人业务事项', { min: 1, max })
export async function readBusinessWork(read: (path: string) => Promise<unknown>) {
  const items = new Map<string, EmployeeBusinessWork>(), cursors = new Set<string>()
  let cursor: string | undefined, error: string | undefined
  do {
    const page = requireRecord(await read(`/api/v1/workbench/business-work?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`), 'business work')
    rejectUnknownKeys(page, ['version', 'items', 'readStatus', 'observedAt', 'nextCursor', 'sourceErrors'], 'business work')
    if (page.version !== '1' || !['complete', 'partial'].includes(String(page.readStatus)) || !Array.isArray(page.items) || page.items.length > 100
      || !Number.isFinite(Date.parse(text(page.observedAt)))) throw new Error('本人业务事项返回格式无效')
    if (page.readStatus === 'partial') {
      if (!Array.isArray(page.sourceErrors) || !page.sourceErrors.length || page.sourceErrors.length > kinds.length) throw new Error('本人业务事项完整性无效')
      const failedKinds = new Set<string>()
      for (const value of page.sourceErrors) {
        const source = requireRecord(value, 'source error'); rejectUnknownKeys(source, ['kind', 'code'], 'source error')
        if (!kinds.includes(String(source.kind)) || failedKinds.has(String(source.kind)) || !/^[A-Z][A-Z0-9_]{0,95}$/.test(text(source.code))) throw new Error('本人业务事项完整性无效')
        failedKinds.add(String(source.kind))
      }
      error = '部分业务事项暂未取得，请刷新核对'
    } else if (page.sourceErrors !== undefined) throw new Error('本人业务事项完整性冲突')
    for (const value of page.items) {
      const item = requireRecord(value, 'business item')
      rejectUnknownKeys(item, ['workKey', 'kind', 'title', 'record', 'recordVersion', 'updatedAt', 'assignment', 'assignmentReason'], 'business item')
      const record = requireRecord(item.record, 'record'); rejectUnknownKeys(record, ['objectName', 'recordId', 'label'], 'record')
      if (!/^[0-9a-f]{64}$/.test(text(item.workKey)) || !kinds.includes(String(item.kind)) || !/^[a-z][a-z0-9_]{0,127}$/.test(text(record.objectName)) || String(record.objectName).startsWith('sys_')
        || !Number.isFinite(Date.parse(text(item.updatedAt)))) throw new Error('本人业务事项来源无效')
      text(item.title, 300); text(record.recordId); text(record.label, 300); text(item.recordVersion)
      if (item.assignment === 'assigned' ? item.assignmentReason !== undefined
        : item.assignment !== 'needs_assignment' || !['no_eligible_employee', 'multiple_eligible_employees'].includes(String(item.assignmentReason))) throw new Error('本人业务事项分配状态无效')
      const typed = item as unknown as EmployeeBusinessWork
      const prior = items.get(typed.workKey)
      if (prior && JSON.stringify(prior) !== JSON.stringify(typed)) throw new Error('分页中的业务事项已变化，请刷新')
      items.set(typed.workKey, typed)
    }
    cursor = page.nextCursor === undefined ? undefined : text(page.nextCursor, 8192)
    if (cursor && cursors.has(cursor)) throw new Error('本人业务事项分页未完成')
    if (cursor) cursors.add(cursor)
  } while (cursor)
  return { items: [...items.values()], ...(error ? { error } : {}) }
}
