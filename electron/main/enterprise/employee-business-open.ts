import type { EnterpriseService } from '../enterprise'
import type { EmployeeBusinessRecord, EmployeeBusinessSelection } from '../../../src/types/employee-business'
import { digest } from './handoff-store'
import { canonicalBusinessJSON } from './employee-business-contract'
import { businessDisplayValue } from './business-record-presentation'

export interface PendingEmployeeBusinessContext {
  accountKey: string; selection: EmployeeBusinessSelection; contextVersion: string; recordVersion: string
  snapshotDigest: string; promptDigest: string; createdAt: number
}
type Access = Pick<EnterpriseService, 'accountKey' | 'getEmployeeBusinessContext' | 'readBusinessRecord'>
function snapshotDigest(value: Awaited<ReturnType<Access['readBusinessRecord']>>) {
  const { capturedAt: _time, ...snapshot } = value.snapshot
  return digest(canonicalBusinessJSON({ candidate: value.candidate, snapshot }))
}
export async function prepareEmployeeBusinessOpen(service: Access, record: EmployeeBusinessRecord) {
  const accountKey = await service.accountKey()
  const selection: EmployeeBusinessSelection = { record, source: { kind: 'record' } }
  const context = await service.getEmployeeBusinessContext(selection)
  if (!('record' in context)) throw new Error('当前事项必须绑定真实业务记录')
  const read = await service.readBusinessRecord(record.objectName, record.recordId)
  if (read.candidate.objectName !== record.objectName || read.candidate.recordId !== record.recordId || await service.accountKey() !== accountKey) throw new Error('员工账号或业务来源已变化，请重新打开')
  const fields = read.presentation?.record.map((field) => `- ${field.label}：${field.value}`).join('\n')
  const notes = read.presentation?.notes ?? ['业务信息暂未展开，请重新读取。']
  const prompt = `当前本人业务事项：${businessDisplayValue(context.record.label) ?? '当前业务事项'}\n\n当前业务信息（摘录）：\n${fields || '暂无可展示的已填写业务信息。'}\n\n读取情况：${notes.join(' ')}关联明细和原件未在此展开。\n\n请先只读查看与整理；如需办理业务或交给团队，我会在新的消息中明确提出。`
  const pending: PendingEmployeeBusinessContext = { accountKey, selection: { record: context.record, source: context.source }, contextVersion: context.contextVersion, recordVersion: context.recordVersion, snapshotDigest: snapshotDigest(read), promptDigest: digest(prompt), createdAt: Date.now() }
  return { pending, prompt }
}
export async function verifyEmployeeBusinessOpen(service: Access, pending: PendingEmployeeBusinessContext, prompt: string) {
  if (Date.now() - pending.createdAt > 10 * 60_000 || digest(prompt.trim()) !== pending.promptDigest || await service.accountKey() !== pending.accountKey) throw new Error('本人业务事项上下文已失效，请重新打开')
  const context = await service.getEmployeeBusinessContext(pending.selection)
  if (!('record' in context)) throw new Error('当前事项必须绑定真实业务记录')
  const read = await service.readBusinessRecord(pending.selection.record.objectName, pending.selection.record.recordId)
  if (context.contextVersion !== pending.contextVersion || context.recordVersion !== pending.recordVersion || snapshotDigest(read) !== pending.snapshotDigest
    || await service.accountKey() !== pending.accountKey) throw new Error('当前业务记录或可办理范围已变化，请重新打开')
}
