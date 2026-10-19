import type { EmployeeBusinessCreationSelection, EmployeeBusinessReferenceName, EmployeeBusinessTarget } from '../../../src/types/employee-business'
import { rejectUnknownKeys, requireRecord, requireString } from '../validation'

export interface VerifiedCreationReference { name?: string; uniqueQuery?: string; materialName?: string; code?: string; objectName: string; recordId: string; accountKey: string; turnKey: string }
const referenceObjects: Record<EmployeeBusinessReferenceName, string> = {
  customer_id: 'forge_customer', contact_id: 'forge_contact', opportunity_id: 'forge_sales_opportunity',
  quotation_type_id: 'forge_quotation_type', issuer_id: 'forge_quotation_issuer', sku_id: 'forge_material_sku',
}
/** Models select already-read opaque refs; only Host translates them into native IDs. */
export function creationSelection(objectRef: unknown, references: unknown, previous: EmployeeBusinessTarget | undefined,
  objects: ReadonlyMap<string, { objectName: string; accountKey: string; turnKey: string }> | undefined,
  verified: ReadonlyMap<string, VerifiedCreationReference> | undefined, accountKey: string, turnKey: string): EmployeeBusinessCreationSelection {
  let objectName = previous && 'objectName' in previous ? previous.objectName : undefined
  if (objectRef !== undefined) {
    const key = requireString(objectRef, 'object_ref', { min: 32, max: 64, trim: true })
    const target = objects?.get(key)
    if (!target || target.accountKey !== accountKey || target.turnKey !== turnKey) throw new Error('创建对象引用已失效，请重新读取本轮本人业务对象目录')
    if (target.objectName !== 'forge_sales_lead' && target.objectName !== 'forge_quotation') throw new Error('当前只开放本人线索和报价创建')
    objectName = target.objectName
  }
  if (!objectName) throw new Error('请先从本轮对象目录选择要创建的业务类型')
  const selection: EmployeeBusinessCreationSelection = { objectName, source: { kind: 'creation' } }
  if (references === undefined) {
    if (previous && 'objectName' in previous && previous.objectName === objectName && previous.referenceIds) selection.referenceIds = previous.referenceIds
    if (previous && 'objectName' in previous && previous.objectName === objectName && previous.referenceFacts) selection.referenceFacts = previous.referenceFacts
    if (previous && 'objectName' in previous && previous.objectName === objectName && previous.skuNames) selection.skuNames = previous.skuNames
    return selection
  }
  const values = requireRecord(references, 'reference_keys'); rejectUnknownKeys(values, Object.keys(referenceObjects), 'reference_keys')
  if (!Object.keys(values).length) throw new Error('请选择至少一条已读取的准确业务引用')
  if (objectName !== 'forge_quotation' && Object.keys(values).length) throw new Error('线索创建不接收其他业务记录引用')
  const ids: NonNullable<EmployeeBusinessCreationSelection['referenceIds']> = {}
  for (const [name, keys] of Object.entries(values)) {
    const field = name as EmployeeBusinessReferenceName
    if (!Array.isArray(keys) || keys.length < 1 || keys.length > (field === 'sku_id' ? 100 : 1)) throw new Error('引用须选择明确的一条头记录或本次最多100条SKU')
    const selected = keys.map(value => {
      const key = requireString(value, 'record_key', { min: 32, max: 64, trim: true })
      const record = verified?.get(key)
      if (!record || record.accountKey !== accountKey || record.turnKey !== turnKey || record.objectName !== referenceObjects[field]) throw new Error('引用未经过本轮本人读取核对，或不是所需业务类型')
      if (record.name) {
        selection.referenceFacts ??= {}
        selection.referenceFacts[field] ??= {}
        selection.referenceFacts[field]![record.recordId] = { name: record.name, ...(record.code ? { code: record.code } : {}), ...(record.uniqueQuery ? { uniqueQuery: record.uniqueQuery } : {}) }
      }
      if (field === 'sku_id' && record.name && record.materialName) {
        selection.skuNames ??= {}
        selection.skuNames[record.recordId] = { name: record.name, materialName: record.materialName, ...(record.code ? { code: record.code } : {}) }
      }
      return record.recordId
    })
    if (new Set(selected).size !== selected.length) throw new Error('本轮引用不能重复')
    ids[field] = selected
  }
  if (Object.keys(ids).length) selection.referenceIds = ids
  return selection
}
