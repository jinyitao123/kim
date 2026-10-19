import type { EmployeeBusinessTarget } from '../../../src/types/employee-business'
import { parseEmployeeBusinessContext, parseEmployeeBusinessOperation } from './employee-business-contract'

/** Shares the existing session-bound HTTP reader without owning credentials or business state. */
export class EmployeeBusinessReadAPI {
  constructor(private readonly read: (path: string, label: string) => Promise<unknown>) {}
  async context(selection: EmployeeBusinessTarget) {
    const creation = 'objectName' in selection
    const query = new URLSearchParams(creation ? { objectName: selection.objectName, sourceKind: 'creation' }
      : { objectName: selection.record.objectName, recordId: selection.record.recordId, sourceKind: selection.source.kind })
    if (creation && selection.referenceIds) query.set('referenceIds', JSON.stringify(selection.referenceIds))
    if (!creation && selection.source.reference) query.set('sourceRef', selection.source.reference)
    const context = parseEmployeeBusinessContext(await this.read(`/api/v1/workbench/business-actions/context?${query}`, '本人业务动作'))
    if (creation ? !('objectName' in context) || context.objectName !== selection.objectName || context.source.kind !== 'creation'
      : !('record' in context) || context.record.objectName !== selection.record.objectName || context.record.recordId !== selection.record.recordId
        || context.source.kind !== selection.source.kind || context.source.reference !== selection.source.reference) throw new Error('当前业务来源与所选目标不一致')
    return context
  }
  async operation(opKey: string) {
    return parseEmployeeBusinessOperation(await this.read(`/api/v1/workbench/business-actions/operations/${encodeURIComponent(opKey)}`, '本人业务回执'))
  }
}
