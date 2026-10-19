import type { EmployeeBusinessAction, EmployeeBusinessLineItem, EmployeeBusinessContext, EmployeeBusinessOperation, EmployeeBusinessParameter, EmployeeBusinessRecord, EmployeeBusinessRequest, EmployeeBusinessValue } from '../../../src/types/employee-business'
import { rejectUnknownKeys, requireRecord, requireString } from '../validation'
import { digest } from './handoff-store'

const sha = /^[0-9a-f]{64}$/
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const name = /^[a-z][a-z0-9_]{0,127}$/
const reserved = /^(?:action_?name|object_?name|record_?id|actor_?id|user_?id|organization_?id|context_?(?:id|version)|source(?:_.*)?|op_?key|idempotency_?key|employee_?message|file_?id|record_?version)$/i
function text(value: unknown, max = 128): string { return requireString(value, '业务动作字段', { min: 1, max, trim: false }) }
function check(ok: unknown): asserts ok { if (!ok) throw new Error('个人业务动作声明或回执无效，请重新读取当前事项') }
function scalar(value: unknown): value is EmployeeBusinessValue { return typeof value === 'string' && value.length <= 4000 || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) }
function recordReference(value: unknown): EmployeeBusinessRecord {
  const r = requireRecord(value, 'record'); rejectUnknownKeys(r, ['objectName', 'recordId', 'label'], 'record')
  check(name.test(text(r.objectName)) && !String(r.objectName).startsWith('sys_'))
  return { objectName: String(r.objectName), recordId: text(r.recordId), label: text(r.label, 300) }
}
function parameter(value: unknown, allowLeadSource = false): EmployeeBusinessParameter {
  const p = requireRecord(value, 'parameter')
  rejectUnknownKeys(p, ['name', 'label', 'type', 'required', 'description', 'enum', 'enumLabels', 'minimum', 'maximum', 'maxLength'], 'parameter')
  check(name.test(text(p.name)) && (!reserved.test(String(p.name)) || allowLeadSource && p.name === 'source') && ['string', 'number', 'boolean', 'date', 'file'].includes(String(p.type)) && typeof p.required === 'boolean')
  text(p.label, 160)
  if (p.description !== undefined) check(typeof p.description === 'string' && p.description.length <= 1000)
  if (p.enum !== undefined) check(Array.isArray(p.enum) && p.enum.length > 0 && p.enum.length <= 100 && p.enum.every(scalar) && new Set(p.enum).size === p.enum.length)
  if (p.enumLabels !== undefined) {
    check(Array.isArray(p.enum) && Array.isArray(p.enumLabels) && p.enumLabels.length === p.enum.length)
    const mapped = new Set<EmployeeBusinessValue>()
    for (const value of p.enumLabels) {
      const entry = requireRecord(value, 'enum label'); rejectUnknownKeys(entry, ['value', 'label'], 'enum label')
      check(scalar(entry.value) && p.enum.includes(entry.value) && !mapped.has(entry.value))
      check(text(entry.label, 160).trim().length > 0); mapped.add(entry.value)
    }
  }
  for (const key of ['minimum', 'maximum']) if (p[key] !== undefined) check(typeof p[key] === 'number' && Number.isFinite(p[key]))
  if (p.maxLength !== undefined) check(Number.isInteger(p.maxLength) && Number(p.maxLength) > 0 && Number(p.maxLength) <= 4000)
  return p as unknown as EmployeeBusinessParameter
}
export function parseEmployeeBusinessContext(value: unknown): EmployeeBusinessContext {
  const c = requireRecord(value, 'context')
  rejectUnknownKeys(c, ['version', 'contextId', 'contextVersion', 'recordVersion', 'expiresAt', 'readOnly', 'record', 'source', 'actions', 'objectName', 'objectLabel'], 'context')
  check(c.version === '1' && c.readOnly === true && uuid.test(text(c.contextId)) && sha.test(text(c.contextVersion)))
  check(typeof c.expiresAt === 'string' && Number.isFinite(Date.parse(c.expiresAt)))
  const source = requireRecord(c.source, 'source'); rejectUnknownKeys(source, ['kind', 'reference'], 'source')
  const creation = source.kind === 'creation'
  let target: Record<string, unknown>
  if (creation) {
    check(['forge_sales_lead', 'forge_quotation'].includes(String(c.objectName)) && c.record === undefined && c.recordVersion === undefined && source.reference === undefined)
    target = { objectName: c.objectName, objectLabel: text(c.objectLabel, 160) }
  } else {
    check(c.objectName === undefined && c.objectLabel === undefined)
    check(['record', 'business_notification', 'approval'].includes(String(source.kind)))
    if (source.kind === 'record') check(source.reference === undefined); else text(source.reference)
    text(c.recordVersion); target = { record: recordReference(c.record), recordVersion: c.recordVersion }
  }
  check(Array.isArray(c.actions) && c.actions.length <= 64)
  const refs = new Set<number>()
  const actions = c.actions.map((value) => {
    const a = requireRecord(value, 'action')
    rejectUnknownKeys(a, ['action_ref', 'capabilityId', 'declarationVersion', 'label', 'description', 'effect', 'executionMode', 'parameters', 'requiresRecord', 'lineItems'], 'action')
    check(Number.isInteger(a.action_ref) && Number(a.action_ref) >= 1 && Number(a.action_ref) <= 64 && !refs.has(Number(a.action_ref)))
    refs.add(Number(a.action_ref)); text(a.capabilityId, 160); text(a.label, 160); text(a.description, 1000)
    check(sha.test(text(a.declarationVersion)) && a.executionMode === 'employee_only' && ['read', 'write'].includes(String(a.effect)))
    check(creation ? a.requiresRecord === false && a.effect === 'write' : a.requiresRecord === undefined)
    if (creation) check(a.capabilityId === (c.objectName === 'forge_sales_lead' ? 'forge:action:forge_sales_lead.sales_lead_create' : 'forge:action:forge_quotation.sales_quotation_draft_create'))
    check(Array.isArray(a.parameters) && a.parameters.length <= 32)
    const parameters = a.parameters.map(value => parameter(value, creation && c.objectName === 'forge_sales_lead'))
    check(new Set(parameters.map((p) => p.name)).size === parameters.length && parameters.filter((p) => p.type === 'file').length <= 1)
    if (creation) check(parameters.every(p => p.type !== 'file' && !/^(?:lines_json|code|owner_id|responsible_id|status)$/.test(p.name)))
    if (creation && c.objectName === 'forge_quotation') check(a.lineItems !== undefined)
    if (a.lineItems !== undefined) {
      check(creation && c.objectName === 'forge_quotation')
      const declaration = requireRecord(a.lineItems, 'lineItems'); rejectUnknownKeys(declaration, ['minItems', 'maxItems', 'fields'], 'lineItems')
      check(declaration.minItems === 1 && declaration.maxItems === 100 && Array.isArray(declaration.fields) && declaration.fields.length <= 8)
      const fields = declaration.fields.map(value => parameter(value))
      check(fields.every(p => lineItemFields.has(p.name) && p.type !== 'file') && new Set(fields.map(p => p.name)).size === fields.length)
      a.lineItems = { minItems: 1, maxItems: 100, fields }
    }
    return { ...a, parameters }
  })
  return { ...c, ...target, source, actions } as unknown as EmployeeBusinessContext
}
export function parseEmployeeBusinessOperation(value: unknown): EmployeeBusinessOperation {
  const o = requireRecord(value, 'operation')
  rejectUnknownKeys(o, ['version', 'operationId', 'contextId', 'requestDigest', 'status', 'repeated', 'updatedAt', 'noEffect', 'code', 'summary', 'recordReferences'], 'operation')
  check(o.version === '1' && uuid.test(text(o.operationId)) && uuid.test(text(o.contextId)) && sha.test(text(o.requestDigest)))
  check(['in_progress', 'succeeded', 'failed', 'unknown'].includes(String(o.status)) && typeof o.repeated === 'boolean' && Number.isFinite(Date.parse(text(o.updatedAt))))
  if (o.noEffect !== undefined) check(typeof o.noEffect === 'boolean')
  if (o.status === 'unknown' || o.status === 'in_progress') check(o.noEffect !== true)
  if (o.code !== undefined) check(/^[A-Z][A-Z0-9_]{0,95}$/.test(String(o.code)))
  if (o.summary !== undefined) check(typeof o.summary === 'string' && o.summary.length <= 1000)
  if (o.recordReferences !== undefined) {
    check(o.status === 'succeeded' && Array.isArray(o.recordReferences) && o.recordReferences.length <= 16)
    o.recordReferences = o.recordReferences.map(recordReference)
  }
  return o as unknown as EmployeeBusinessOperation
}
export function canonicalBusinessJSON(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalBusinessJSON).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalBusinessJSON((value as Record<string, unknown>)[k])}`).join(',')}}`
  throw new Error('业务请求包含不可序列化的值')
}
export function employeeBusinessRequestDigest(request: EmployeeBusinessRequest): string { return digest(canonicalBusinessJSON({ ...request, file: request.file ?? null })) }
export function validateEmployeeBusinessValues(parameters: EmployeeBusinessParameter[], raw: unknown, allowLeadSource = false): Record<string, EmployeeBusinessValue> {
  const values = requireRecord(raw, 'values'); const declared = parameters.filter((p) => p.type !== 'file')
  rejectUnknownKeys(values, declared.map((p) => p.name), 'values')
  for (const p of declared) {
    const value = values[p.name]
    if (value === undefined) { check(!p.required); continue }
    check(scalar(value) && (!reserved.test(p.name) || allowLeadSource && p.name === 'source'))
    check(p.type === 'number' ? typeof value === 'number' : p.type === 'boolean' ? typeof value === 'boolean' : typeof value === 'string')
    if (typeof value === 'string') check(!value.includes('\0') && value.length <= (p.maxLength ?? 4000) && (!p.required || value.trim().length > 0))
    if (p.type === 'date') check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value)
    if (p.enum) check(p.enum.includes(value))
    if (typeof value === 'number') check((p.minimum === undefined || value >= p.minimum) && (p.maximum === undefined || value <= p.maximum))
  }
  return values as Record<string, EmployeeBusinessValue>
}

const lineItemFields = new Set(['line_type', 'name', 'sku_id', 'quantity', 'taxed_unit_price', 'tax_rate', 'discount_rate', 'remarks'])
export function validateEmployeeBusinessLineItems(action: EmployeeBusinessAction, raw: unknown): EmployeeBusinessLineItem[] | undefined {
  if (!action.lineItems) { check(raw === undefined); return undefined }
  check(Array.isArray(raw) && raw.length >= action.lineItems.minItems && raw.length <= action.lineItems.maxItems)
  return raw.map(rawRow => {
    const row = validateEmployeeBusinessValues(action.lineItems!.fields, rawRow)
    check(row.line_type === 'material' || row.line_type === 'service')
    for (const [name, minimum, maximum] of [['quantity', 0.0001, 1_000_000_000], ['taxed_unit_price', 0, 1_000_000_000_000], ['tax_rate', 0, 100], ['discount_rate', 0, 100]] as const) {
      check(typeof row[name] === 'number' && row[name] >= minimum && row[name] <= maximum)
    }
    if (row.line_type === 'service') check(typeof row.name === 'string' && Boolean(row.name.trim()) && row.name.length <= 255 && !('sku_id' in row))
    else check(typeof row.sku_id === 'string' && Boolean(row.sku_id.trim()) && row.sku_id.length <= 128 && action.lineItems!.fields.find(p => p.name === 'sku_id')?.enum?.includes(row.sku_id))
    return row
  })
}
