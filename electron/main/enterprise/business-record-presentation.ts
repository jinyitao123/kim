import { businessDisplayValue, businessReadCompletenessText } from '../../../src/lib/business-display'
import type { BusinessRecordFieldValue, BusinessRecordRelationSnapshot, BusinessRecordSnapshot } from './business-records'

interface FieldDefinition { name: string; label: string; type: string; hidden?: boolean; system?: boolean }
interface RelationDefinition { label: string; direction: BusinessRecordRelationSnapshot['direction']; fields: FieldDefinition[] }
interface DisplayField { label: string; value: string }
export interface BusinessRecordPresentation {
  record: DisplayField[]
  relations: Array<Omit<BusinessRecordRelationSnapshot, 'recordIds' | 'records'> & { records: DisplayField[][] }>
  notes: string[]
}

const SCALAR_TYPES = new Set(['string', 'text', 'textarea', 'markdown', 'number', 'integer', 'currency', 'percent', 'percentage', 'boolean', 'checkbox', 'date', 'datetime', 'time', 'select', 'enum', 'picklist'])
const AUDIT_FIELD = /^(?:id|_id|created_?(?:at|by)|updated_?(?:at|by)|last_?modified_?(?:at|by)|deleted_?(?:at|by)|record_?version|version|revision|sort_?order)$/i
const MACHINE_FIELD = /(?:sha(?:256)?|hash|digest|fingerprint|signature|manifest|idempotenc|(?:^|_)path(?:$|_))/i
const INTERNAL_REFERENCE = /(?:_(?:id|key)|Id|ID|Key)$/
const MACHINE_LABEL = /(?:CreatedAt|UpdatedAt|LastModifiedAt|CreatedBy|UpdatedBy|LastModifiedBy|SHA(?:256)?|哈希|指纹|请求摘要|原件摘要|版本摘要|幂等|内部(?:标识|编号|版本))/i

function visible(field: FieldDefinition): boolean {
  return !field.hidden && !field.system && SCALAR_TYPES.has(field.type)
    && !AUDIT_FIELD.test(field.name) && !MACHINE_FIELD.test(field.name) && !INTERNAL_REFERENCE.test(field.name) && !MACHINE_LABEL.test(field.label)
}

function displayFields(values: BusinessRecordFieldValue[], definitions: FieldDefinition[]): DisplayField[] {
  return values.flatMap((field): DisplayField[] => {
    const definitionsForLabel = definitions.filter((definition) => definition.label === field.label)
    if (!definitionsForLabel.length || !definitionsForLabel.every(visible)) return []
    const label = businessDisplayValue(field.label), value = businessDisplayValue(field.value)
    return label && value !== undefined ? [{ label, value }] : []
  })
}

/** The employee excerpt is separate from the complete, version-bound tool snapshot. */
export function presentBusinessRecord(snapshot: BusinessRecordSnapshot, fields: FieldDefinition[], relations: RelationDefinition[] = []): BusinessRecordPresentation {
  const record = displayFields(snapshot.record, fields)
  const displayedRelations = snapshot.relations.flatMap((relation): BusinessRecordPresentation['relations'] => {
    const definition = relations.find((item) => item.label === relation.label && item.direction === relation.direction)
    const label = businessDisplayValue(relation.label)
    if (!definition || !label) return []
    const { recordIds: _ids, records, ...summary } = relation
    return [{ ...summary, label, records: records.map((row) => displayFields(row, definition.fields)) }]
  })
  const notes = [businessReadCompletenessText(snapshot.completeness), '读取范围仅限当前账号可查看的信息。']
  if (snapshot.pricingDetailCompleteness === 'incomplete' && snapshot.completeness !== 'incomplete') notes.push('关联明细尚未完整核实，暂不能据此确认金额或数量。')
  if (record.some((field) => field.value.endsWith('…（摘录）')) || displayedRelations.some((relation) => relation.records.some((row) => row.some((field) => field.value.endsWith('…（摘录）'))))) notes.push('部分较长字段只展示摘录。')
  return { record, relations: displayedRelations, notes }
}

export { businessDisplayValue }
