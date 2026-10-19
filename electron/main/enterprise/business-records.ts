import { createHash } from 'node:crypto'
import { ForgeBusinessReadError } from './business-read-error'
import type { BusinessRecordPresentation } from './business-record-presentation'
export { ForgeBusinessReadError, businessReadErrorResult } from './business-read-error'

type JsonRecord = Record<string, unknown>

export interface BusinessObjectSummary {
  objectName: string
  label: string
}

export interface BusinessObjectDirectory {
  objects: BusinessObjectSummary[]
  complete: boolean
  totalCount?: number
}

export interface BusinessRecordCandidate {
  objectName: string
  objectLabel: string
  recordId: string
  name: string
  code?: string
  status?: string
  owner?: string
  recordVersion?: string
}

export interface BusinessRecordSearchPage {
  records: BusinessRecordCandidate[]
  offset: number
  limit: number
  hasMore: boolean
  complete: boolean
  warning?: string
}

export interface BusinessRecordFieldValue {
  label: string
  value: unknown
}

export interface BusinessRecordRelationSnapshot {
  label: string
  direction: 'related' | 'reference'
  records: BusinessRecordFieldValue[][]
  recordIds?: string[]
  returnedCount: number
  limit: number
  complete: boolean
  requiredForCalculation?: boolean
  expectedCount?: number
}

export interface BusinessRecordSnapshot {
  version: 1
  capturedAt: string
  objectLabel: string
  record: BusinessRecordFieldValue[]
  domainVersion?: string
  relations: BusinessRecordRelationSnapshot[]
  completeness: 'complete' | 'partial' | 'truncated' | 'incomplete'
  pricingDetailCompleteness: 'complete' | 'incomplete' | 'unknown'
  expectedDetailCount?: number
  completenessNotes: string[]
}

export interface BusinessRecordRead {
  /** Host-only names from the actual SKU and authorized material reference read. */
  creationSku?: { name: string; materialName: string; code?: string }
  candidate: BusinessRecordCandidate
  snapshot: BusinessRecordSnapshot
  presentation?: BusinessRecordPresentation
}

const OBJECT_NAME = /^[a-z][a-z0-9_]{1,127}$/
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_.]{0,127}$/
const MAX_RELATION_METADATA_CANDIDATES = 8
const MAX_RELATION_PLANS = 24
const MAX_RELATION_ROWS = 12
const MAX_TOTAL_RELATED_ROWS = 48
const MAX_SNAPSHOT_FIELDS = 48
const MAX_FIELD_VALUE_BYTES = 8_000
const SEARCH_PAGE_MAX = 50
const GENERIC_SEARCH_TERMS = new Set([
  'record', 'records', 'business', 'businesses', 'please', 'find', 'search', 'check', 'open', 'review', 'current', 'the', 'for', 'with',
  '业务', '业务记录', '记录', '查询', '查找', '搜索', '查看', '核对', '处理', '当前', '有关', '相关', '这个', '那条', '需要', '帮我', '一下', '合同', '报价',
])
const SENSITIVE_FIELD = /(?:password|passwd|secret|token|cookie|credential|authorization|api[_-]?key|private[_-]?key|bank|account[_-]?number|routing[_-]?number|ssn|social[_-]?security|phone|mobile|email|e_mail|address|身份证|手机号|电话|邮箱|地址|密码|令牌|凭据|密钥|银行卡|银行账号)/i
const INTERNAL_FIELD = /^(?:id|_id|created_by|updated_by|owner_id|created_by_id|updated_by_id)$/i
const INTERNAL_SUFFIX = /(?:_id|Id|_key|Key)$/
const SENSITIVE_TYPES = new Set(['password', 'secret', 'file', 'image', 'video', 'audio', 'binary', 'attachment'])
const SAFE_SEARCH_TYPES = new Set(['string', 'text', 'textarea', 'markdown', 'code', 'number', 'integer', 'currency', 'select', 'enum', 'picklist', 'lookup', 'user', 'master_detail'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function object(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function unwrapData(value: unknown): unknown {
  const source = object(value)
  if (!source) return value
  if (source.data !== undefined) return source.data
  if (source.result !== undefined) return source.result
  if (source.item !== undefined) return source.item
  return value
}

function safeObjectName(value: unknown): string | undefined {
  const name = text(value)
  return name && OBJECT_NAME.test(name) && !name.startsWith('sys_') ? name : undefined
}

export function parseBusinessObjectDirectory(value: unknown): BusinessObjectDirectory {
  const payload = object(unwrapData(value))
  const rows = Array.isArray(payload?.objects) ? payload.objects : undefined
  if (!payload || !rows) throw new ForgeBusinessReadError('failed', 'Forge 对象目录格式无法识别')
  const objects = rows.flatMap((raw): BusinessObjectSummary[] => {
    const entry = object(raw), objectName = safeObjectName(entry?.name)
    return objectName ? [{ objectName, label: text(entry?.label) ?? objectName }] : []
  })
  const totalCount = number(payload.totalCount)
  const complete = payload.partial !== true && totalCount !== undefined && totalCount === objects.length
  return { objects, complete, ...(totalCount !== undefined ? { totalCount } : {}) }
}

interface BusinessField {
  name: string
  label: string
  type: string
  hidden?: boolean
  system?: boolean
  reference?: string
  options?: Array<{ value: string | number | boolean; label: string }>
}

function nativeFieldOptions(value: unknown): Array<{ value: string | number | boolean; label: string }> {
  if (!Array.isArray(value)) return []
  return value.flatMap((raw): Array<{ value: string | number | boolean; label: string }> => {
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') return [{ value: raw, label: String(raw) }]
    const option = object(raw), optionValue = option?.value
    if (typeof optionValue !== 'string' && typeof optionValue !== 'number' && typeof optionValue !== 'boolean') return []
    const label = text(option?.label) ?? text(option?.name) ?? String(optionValue)
    return [{ value: optionValue, label: label.slice(0, 500) }]
  })
}

function nativeFieldValue(field: BusinessField, rawValue: unknown): unknown {
  if (!field.options?.length) return rawValue
  if (Array.isArray(rawValue)) return rawValue.map((value) => nativeFieldValue(field, value))
  const raw = object(rawValue)
  const value = raw && Object.hasOwn(raw, 'value') ? raw.value : rawValue
  const option = field.options.find((item) => Object.is(item.value, value)
    || ['string', 'number', 'boolean'].includes(typeof item.value) && ['string', 'number', 'boolean'].includes(typeof value) && String(item.value) === String(value))
  return option?.label ?? rawValue
}

function definitionFields(definition: unknown): BusinessField[] {
  const source = object(unwrapData(definition))
  const rawFields = source?.fields
  const entries: Array<{ name?: string; field: unknown }> = Array.isArray(rawFields)
    ? rawFields.map((field) => ({ field }))
    : object(rawFields) ? Object.entries(rawFields as JsonRecord).map(([name, field]) => ({ name, field })) : []
  return entries.flatMap(({ name: key, field: raw }): BusinessField[] => {
    const field = object(raw), name = text(field?.name) ?? text(field?.field) ?? key
    if (!field || !name || !FIELD_NAME.test(name)) return []
    const type = (text(field.type) ?? 'string').toLowerCase()
    const options = nativeFieldOptions(field.options ?? field.enum)
    return [{ name, label: text(field.label) ?? name, type, hidden: field.hidden === true, system: field.system === true, ...(text(field.reference) ? { reference: text(field.reference) } : {}), ...(options.length ? { options } : {}) }]
  })
}

function labelMatches(field: BusinessField, expression: RegExp): boolean {
  return expression.test(field.name) || expression.test(field.label)
}

function isSensitive(field: BusinessField): boolean {
  return SENSITIVE_FIELD.test(field.name) || SENSITIVE_FIELD.test(field.label) || SENSITIVE_TYPES.has(field.type)
}

function canExposeField(field: BusinessField): boolean {
  return !isSensitive(field) && !INTERNAL_FIELD.test(field.name) && !INTERNAL_SUFFIX.test(field.name)
}

function displayFields(fields: BusinessField[]): BusinessField[] {
  return fields.filter(canExposeField).slice(0, MAX_SNAPSHOT_FIELDS)
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed || UUID.test(trimmed)) return undefined
    return trimmed.length <= 500 ? trimmed : trimmed.slice(0, 500)
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const source = object(value)
    return text(source?.name) ?? text(source?.label) ?? text(source?.display_name)
  }
  return undefined
}

function pickField(fields: BusinessField[], expression: RegExp): BusinessField | undefined {
  return fields.find((field) => !isSensitive(field) && labelMatches(field, expression))
}

function readableOwnerField(fields: BusinessField[]): BusinessField | undefined {
  // Native user/lookup fields contain opaque account IDs. Only a readable
  // display field may identify a person to Pi or the employee.
  const people = fields.filter((field) => canExposeField(field) && field.type !== 'user' && field.type !== 'lookup')
  return pickField(people, /(?:owner|assignee|responsible|assigned_to)/i)
    ?? pickField(people, /(?:负责人|所有者|经办人|归属人)/)
}

function recordID(row: JsonRecord): string | undefined {
  return text(row.id) ?? text(row._id)
}

function candidateFromRow(objectSummary: BusinessObjectSummary, fields: BusinessField[], rowValue: unknown): BusinessRecordCandidate | undefined {
  const row = object(rowValue), id = row && recordID(row)
  if (!row || !id) return undefined
  const nameField = pickField(fields, /^(?:name|title|subject|display[_ ]?name|label)$/i)
    ?? pickField(fields, /(?:名称|标题|主题)$/)
  const codeField = pickField(fields, /^(?:code|number|no|document[_ ]?number|reference[_ ]?number)$/i)
    ?? pickField(fields, /(?:编号|代码|单号)$/)
  const statusField = pickField(fields, /(?:^|_)(?:status|state|approval_status)(?:$|_)/i)
    ?? pickField(fields, /(?:状态|审批结果)/)
  const ownerField = readableOwnerField(fields)
  const versionField = pickVersionField(fields)
  const name = nameField ? stringValue(nativeFieldValue(nameField, row[nameField.name])) : undefined
  const code = codeField ? stringValue(nativeFieldValue(codeField, row[codeField.name])) : undefined
  const status = statusField ? stringValue(nativeFieldValue(statusField, row[statusField.name])) : undefined
  const owner = ownerField ? stringValue(nativeFieldValue(ownerField, row[ownerField.name])) : undefined
  if (!name && !code) return undefined
  const candidate: BusinessRecordCandidate = {
    objectName: objectSummary.objectName, objectLabel: objectSummary.label, recordId: id,
    name: name ?? code!,
    ...(code ? { code } : {}), ...(status ? { status } : {}), ...(owner ? { owner } : {}),
  }
  const recordVersion = versionField ? scalarVersion(row[versionField.name]) : undefined
  if (recordVersion) candidate.recordVersion = recordVersion
  return candidate
}

function scalarVersion(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() && value.length <= 128 && !UUID.test(value)) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

function pickVersionField(fields: BusinessField[]): BusinessField | undefined {
  return fields.find((field) => /^(?:record_?version|version(?:_number)?|revision(?:_number)?)$/i.test(field.name) || /^(?:版本|修订版本|记录版本)$/.test(field.label))
}

function queryRows(value: unknown): { rows: unknown[]; totalCount?: number; hasMore?: boolean } {
  const payload = unwrapData(value)
  if (Array.isArray(payload)) return { rows: payload }
  const source = object(payload)
  const rows = Array.isArray(source?.records) ? source.records
    : Array.isArray(source?.rows) ? source.rows
      : Array.isArray(source?.items) ? source.items : undefined
  if (!source || !rows) throw new ForgeBusinessReadError('failed', 'Forge 记录查询结果格式无法识别')
  const totalCount = number(source.totalCount) ?? number(source.total_count) ?? number(source.total)
  return { rows, ...(totalCount !== undefined ? { totalCount } : {}), ...(typeof source.hasMore === 'boolean' ? { hasMore: source.hasMore } : {}) }
}

function searchTerms(summary: string): string[] {
  const tokens = summary.toLowerCase().split(/[\s，。；、：,.!?！？（）()《》“”"'\-_/]+/).map((term) => term.trim())
  return [...new Set(tokens.filter((term) => term.length >= 2 && !GENERIC_SEARCH_TERMS.has(term)))]
}

function searchScore(summary: string, fields: BusinessField[], rowValue: unknown): number {
  const row = object(rowValue)
  if (!row) return 0
  const terms = searchTerms(summary)
  if (!terms.length) return 0
  const values = fields.map((field) => stringValue(nativeFieldValue(field, row[field.name]))?.toLowerCase()).filter((value): value is string => Boolean(value))
  return terms.reduce((score, term) => score + (values.some((value) => value.includes(term)) ? Math.max(2, term.length) : 0), 0)
}

function searchFields(fields: BusinessField[]): BusinessField[] {
  const ranked = fields.filter((field) => SAFE_SEARCH_TYPES.has(field.type) && !isSensitive(field) && !INTERNAL_SUFFIX.test(field.name)
    && (labelMatches(field, /(?:name|title|subject|display|code|number|reference|customer|client|product)/i) || /(?:名称|标题|主题|编号|代码|单号|客户名|产品名)/.test(field.label)))
    .map((field) => ({ field, score: labelMatches(field, /(?:code|number|reference)/i) || /(?:编号|代码|单号)/.test(field.label) ? 4 : 2 }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 16)
    .map(({ field }) => field)
  return ranked
}

function queryHasMore(page: { rows: unknown[]; totalCount?: number; hasMore?: boolean }, offset: number, limit: number): boolean {
  if (page.hasMore !== undefined) return page.hasMore
  return page.totalCount !== undefined ? offset + page.rows.length < page.totalCount : page.rows.length >= limit
}

function safeJsonValue(value: unknown): { value?: unknown; truncated: boolean } {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return { value, truncated: false }
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') <= MAX_FIELD_VALUE_BYTES) return { value, truncated: false }
    let end = Math.min(value.length, MAX_FIELD_VALUE_BYTES)
    while (Buffer.byteLength(value.slice(0, end), 'utf8') > MAX_FIELD_VALUE_BYTES) end -= 128
    return { value: value.slice(0, Math.max(0, end)), truncated: true }
  }
  if (Array.isArray(value)) {
    const result = value.slice(0, 20).map((entry) => safeJsonValue(entry))
    return { value: result.flatMap((entry) => entry.value === undefined ? [] : [entry.value]), truncated: value.length > 20 || result.some((entry) => entry.truncated) }
  }
  const source = object(value)
  if (!source) return { truncated: false }
  const result: JsonRecord = {}
  let truncated = false
  for (const [key, entry] of Object.entries(source).slice(0, 20)) {
    if (SENSITIVE_FIELD.test(key) || INTERNAL_FIELD.test(key) || INTERNAL_SUFFIX.test(key)) { truncated = true; continue }
    const safe = safeJsonValue(entry)
    if (safe.value !== undefined) result[key] = safe.value
    truncated ||= safe.truncated
  }
  truncated ||= Object.keys(source).length > 20
  return { value: result, truncated }
}

function snapshotFields(fields: BusinessField[], rowValue: unknown): { values: BusinessRecordFieldValue[]; truncated: boolean } {
  const row = object(rowValue)
  if (!row) return { values: [], truncated: true }
  const selected = displayFields(fields)
  let truncated = fields.filter(canExposeField).length > selected.length
  const values = selected.flatMap((field): BusinessRecordFieldValue[] => {
    if (row[field.name] === undefined) return []
    const safe = safeJsonValue(nativeFieldValue(field, row[field.name]))
    truncated ||= safe.truncated
    if (safe.value === undefined) return []
    return [{ label: field.label, value: safe.value }]
  })
  return { values, truncated }
}

function relationTarget(field: BusinessField): string | undefined {
  return safeObjectName(field.reference)
}

function relationLabel(objectSummary: BusinessObjectSummary, field: BusinessField): string {
  return `${objectSummary.label} · ${field.label}`
}

function relationFieldName(field: BusinessField): string { return field.name }

function versionValue(fields: BusinessField[], rowValue: unknown): string | undefined {
  const row = object(rowValue), field = pickVersionField(fields)
  return row && field ? scalarVersion(row[field.name]) : undefined
}

function nativeFieldList(definition: unknown): BusinessField[] {
  const source = object(unwrapData(definition))
  if (!source) throw new ForgeBusinessReadError('failed', 'Forge 对象元数据无法识别')
  const fields = definitionFields(source)
  if (!fields.length) throw new ForgeBusinessReadError('failed', 'Forge 对象元数据没有可读取字段')
  return fields
}

function hashIdentity(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function semanticTokens(value: string): string[] {
  const normalized = value.toLowerCase()
  const ascii = normalized.split(/[^a-z0-9]+/).filter((token) => token.length >= 3)
  const chinese = normalized.match(/[\u3400-\u9fff]{2,}/g) ?? []
  const grams = chinese.flatMap((part) => Array.from({ length: part.length - 1 }, (_, index) => part.slice(index, index + 2)))
  return [...new Set([...ascii, ...grams])].filter((token) => !new Set(['forge', 'object', 'record', 'data', 'table', 'system', '明细', '项目', '记录', '数据', '管理', '业务', '销售']).has(token))
}

function relationshipCandidateScore(root: BusinessObjectSummary, candidate: BusinessObjectSummary): number {
  if (candidate.objectName.startsWith(`${root.objectName}_`)) return 100
  if (root.label.length >= 2 && candidate.label.startsWith(root.label)) return 90
  if (root.label.length >= 3 && candidate.label.includes(root.label)) return 80
  const rootNameTail = root.objectName.split('_').slice(1).join('_')
  if (rootNameTail.length >= 4 && candidate.objectName.includes(rootNameTail)) return 70
  const rootTokens = new Set([...semanticTokens(root.objectName), ...semanticTokens(root.label)])
  const candidateTokens = semanticTokens(`${candidate.objectName} ${candidate.label}`)
  return candidateTokens.reduce((score, token) => score + (rootTokens.has(token) ? 10 : 0), 0)
}

function expectedDetailCount(fields: BusinessField[], row: JsonRecord): number | undefined {
  const field = fields.find((item) => /^(?:item_count|line_count|detail_count|row_count)$/i.test(item.name) || /^(?:明细行数|明细数量|项目数量|行数)$/.test(item.label))
  const count = field ? number(row[field.name]) : undefined
  return count !== undefined && Number.isInteger(count) && count >= 0 ? count : undefined
}

function isLineItemRelationship(summary: BusinessObjectSummary, fields: BusinessField[]): boolean {
  const descriptor = `${summary.objectName} ${summary.label}`.toLowerCase()
  const names = fields.map((field) => `${field.name} ${field.label}`).join(' ').toLowerCase()
  const rowSemantics = /(?:quantity|qty|unit_price|unit price|price|amount|subtotal|数量|单价|金额|小计)/i.test(names)
  const lineSemantics = /(?:line|item|detail|明细|项目行|产品行)/i.test(descriptor)
  return rowSemantics && lineSemantics
}

export class ForgeBusinessReader {
  private readonly relationIndexes = new Map<string, {
    generation: number
    expiresAt: number
    directorySignature: string
    rootObject: string
    relations: Array<{ summary: BusinessObjectSummary; field: BusinessField; fields: BusinessField[] }>
    complete: boolean
  }>()

  constructor(
    private readonly callTool: (name: 'list_objects' | 'describe_object' | 'query_records' | 'get_record', args: Record<string, unknown>, generation: number) => Promise<unknown>,
    private readonly getObjectMetadata: (objectName: string, generation: number) => Promise<unknown>,
  ) {}

  private async relatedObjectMetadata(root: BusinessObjectSummary, directory: BusinessObjectDirectory, generation: number) {
    const directorySignature = hashIdentity(directory.objects.map((item) => [item.objectName, item.label]))
    const cacheKey = `${generation}:${root.objectName}:${directorySignature}`
    const cached = this.relationIndexes.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) return cached
    const candidates = directory.objects.filter((item) => item.objectName !== root.objectName)
      .map((summary) => ({ summary, score: relationshipCandidateScore(root, summary) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.summary.objectName.localeCompare(right.summary.objectName))
    const selected = candidates.slice(0, MAX_RELATION_METADATA_CANDIDATES)
    let complete = directory.complete && selected.length === Math.max(0, directory.objects.length - 1)
    const relations: Array<{ summary: BusinessObjectSummary; field: BusinessField; fields: BusinessField[] }> = []
    const descriptions = await Promise.all(selected.map(async ({ summary }) => {
      try { return { summary, fields: nativeFieldList(await this.getObjectMetadata(summary.objectName, generation)) } }
      catch { return { summary, fields: undefined } }
    }))
    for (const entry of descriptions) {
      if (!entry.fields) { complete = false; continue }
      for (const field of entry.fields) {
        if (relationTarget(field) === root.objectName) relations.push({ summary: entry.summary, field, fields: entry.fields })
      }
    }
    const next = { generation, expiresAt: Date.now() + 5 * 60_000, directorySignature, rootObject: root.objectName, relations, complete }
    this.relationIndexes.set(cacheKey, next)
    while (this.relationIndexes.size > 16) this.relationIndexes.delete(this.relationIndexes.keys().next().value!)
    return next
  }

  async listObjects(generation: number): Promise<BusinessObjectDirectory> {
    return parseBusinessObjectDirectory(await this.callTool('list_objects', {}, generation))
  }

  async assertObjectReadable(objectName: string, generation: number): Promise<BusinessObjectSummary> {
    const summary = safeObjectName(objectName)
    if (!summary) throw new ForgeBusinessReadError('not_found', '所选业务对象不在当前员工可见目录中')
    const directory = await this.listObjects(generation)
    const found = directory.objects.find((item) => item.objectName === summary)
    if (!found) throw new ForgeBusinessReadError('not_found', '所选业务对象当前不在员工可见目录中')
    return found
  }

  async findRecords(objectName: string, workSummary: string, offset: number, requestedLimit: number, generation: number): Promise<BusinessRecordSearchPage> {
    const directory = await this.listObjects(generation)
    const objectSummary = directory.objects.find((item) => item.objectName === objectName)
    if (!objectSummary) throw new ForgeBusinessReadError('not_found', '所选业务对象当前不在员工可见目录中')
    const description = await this.callTool('describe_object', { objectName }, generation)
    const fields = nativeFieldList(description)
    const search = searchFields(fields)
    if (!search.length) throw new ForgeBusinessReadError('failed', '当前对象没有可安全检索的显示字段')
    const display = [
      pickField(fields, /^(?:name|title|subject|display[_ ]?name|label)$/i) ?? pickField(fields, /(?:名称|标题|主题)$/),
      pickField(fields, /^(?:code|number|no|document[_ ]?number|reference[_ ]?number)$/i) ?? pickField(fields, /(?:编号|代码|单号)$/),
      pickField(fields, /(?:^|_)(?:status|state|approval_status)(?:$|_)/i) ?? pickField(fields, /(?:状态|审批结果)/),
      readableOwnerField(fields),
      pickVersionField(fields),
    ].filter((field): field is BusinessField => Boolean(field))
    const limit = Math.max(1, Math.min(SEARCH_PAGE_MAX, Math.trunc(requestedLimit || 20)))
    const pageOffset = Math.max(0, Math.min(10_000, Math.trunc(offset || 0)))
    const query = await this.callTool('query_records', {
      objectName,
      fields: [...new Set(['id', ...search.map((field) => field.name), ...display.map((field) => field.name)])],
      limit,
      offset: pageOffset,
      ...(fields.some((field) => field.name === 'updated_at') ? { orderBy: [{ field: 'updated_at', order: 'desc' }] } : {}),
    }, generation)
    const result = queryRows(query)
    const scored = result.rows.map((row) => ({ row, score: searchScore(workSummary, search, row) }))
    const matches = scored.flatMap(({ row, score }): Array<{ item: BusinessRecordCandidate; score: number }> => {
      const item = score > 0 ? candidateFromRow(objectSummary, fields, row) : undefined
      return item ? [{ item, score }] : []
    }).sort((left, right) => right.score - left.score)
    const positiveButUndisplayable = scored.filter((entry) => entry.score > 0).length > matches.length
    const noSearchFieldsReturned = result.rows.length > 0 && !search.some((field) => result.rows.some((rowValue) => {
      const row = object(rowValue)
      return row ? Object.hasOwn(row, field.name) : false
    }))
    const hasMore = queryHasMore(result, pageOffset, limit)
    return {
      records: matches.map(({ item }) => item), offset: pageOffset, limit,
      hasMore,
      complete: directory.complete && !hasMore && !positiveButUndisplayable && !noSearchFieldsReturned,
      ...(positiveButUndisplayable || noSearchFieldsReturned ? { warning: '记录数据查询已获准，但当前账号可读字段不足以安全识别并展示所有匹配记录' } : {}),
    }
  }

  async readRecord(objectName: string, id: string, generation: number): Promise<BusinessRecordRead> {
    const directory = await this.listObjects(generation)
    const rootObject = directory.objects.find((item) => item.objectName === objectName)
    if (!rootObject) throw new ForgeBusinessReadError('not_found', '所选业务记录当前不在员工可见目录中')
    let rootFields: BusinessField[]
    let referenceMetadataAvailable = true
    try { rootFields = nativeFieldList(await this.getObjectMetadata(objectName, generation)) }
    catch {
      rootFields = nativeFieldList(await this.callTool('describe_object', { objectName }, generation))
      referenceMetadataAvailable = false
    }
    const rowValue = await this.callTool('get_record', { objectName, recordId: id }, generation)
    const row = object(unwrapData(rowValue))
    if (!row || !recordID(row)) throw new ForgeBusinessReadError('not_found', '当前员工无法读取所选业务记录')
    if (recordID(row) !== id) throw new ForgeBusinessReadError('failed', 'Forge 返回的业务记录与所选记录不一致')
    let creationSku: BusinessRecordRead['creationSku']
    const rootSnapshot = snapshotFields(rootFields, row)
    const relations: BusinessRecordRelationSnapshot[] = []
    const notes: string[] = ['关联明细按当前员工权限读取；完整性只表示当前员工可见范围，不代表无权查看的数据不存在']
    if (rootSnapshot.truncated) notes.push('主记录字段已按安全读取上限截断')
    if (!directory.complete) notes.push('可见对象目录为部分结果，不能确认全部关联对象')
    if (!referenceMetadataAvailable) notes.push('原生具名元数据未提供关系声明，无法确认关联明细')
    let truncated = rootSnapshot.truncated
    let partial = !directory.complete || !referenceMetadataAvailable
    let blockingDetailMismatch = false

    const relationIndex = referenceMetadataAvailable
      ? await this.relatedObjectMetadata(rootObject, directory, generation)
      : { relations: [], complete: false }
    if (!relationIndex.complete) {
      partial = true
      notes.push('只读取了少量名称相关对象的原生元数据，未检查其余对象；无法证明不存在其它关联关系')
    }

    const incoming = relationIndex.relations
    const outgoingCandidates = rootFields.flatMap((field) => {
      const target = relationTarget(field)
      if (!target || target === objectName || !directory.objects.some((candidate) => candidate.objectName === target)) return []
      return [{ summary: directory.objects.find((candidate) => candidate.objectName === target)!, field }]
    })
    const outgoing: Array<{ summary: BusinessObjectSummary; field: BusinessField; fields: BusinessField[] }> = []
    for (const candidate of outgoingCandidates.slice(0, MAX_RELATION_PLANS)) {
      try { outgoing.push({ ...candidate, fields: nativeFieldList(await this.getObjectMetadata(candidate.summary.objectName, generation)) }) }
      catch { partial = true; notes.push('部分原生父记录元数据不可读，关系完整性未确认') }
    }
    const plans = [
      ...incoming.slice(0, MAX_RELATION_PLANS).map(({ summary, field, fields }) => ({ summary, field, fields, direction: 'related' as const })),
      ...outgoing.slice(0, MAX_RELATION_PLANS).map(({ summary, field, fields }) => ({ summary, field, fields, direction: 'reference' as const })),
    ].slice(0, MAX_RELATION_PLANS)
    if (incoming.length + outgoingCandidates.length > plans.length) {
      truncated = true
      notes.push('关联读取达到安全上限，未读取的关系已标为不完整')
    }
    const expectedCount = expectedDetailCount(rootFields, row)
    const lineItemPlans = plans.filter((plan) => plan.direction === 'related' && isLineItemRelationship(plan.summary, plan.fields))
    let pricingDetailCompleteness: BusinessRecordSnapshot['pricingDetailCompleteness'] = expectedCount === undefined ? 'unknown' : expectedCount === 0 ? 'complete' : 'incomplete'
    if (expectedCount !== undefined && expectedCount > 0 && !lineItemPlans.length) {
      partial = true
      blockingDetailMismatch = true
      notes.push(`主记录声明了 ${expectedCount} 条明细，但未能从原生元数据确认对应的明细关系`)
    }
    let relatedRead = 0
    const skuReadable = directory.objects.some((item) => item.objectName === 'forge_material_sku')
    let skuFields: BusinessField[] | undefined
    const skuCache = new Map<string, Promise<BusinessRecordFieldValue[]>>()
    const skuLabels = async (line: unknown, fields: BusinessField[]): Promise<BusinessRecordFieldValue[]> => {
      const skuReference = skuReadable ? fields.find((field) => field.reference === 'forge_material_sku') : undefined
      const skuId = skuReference && text(object(line)?.[skuReference.name])
      if (!skuId) return []
      let pending = skuCache.get(skuId)
      if (!pending) {
        pending = (async () => {
          skuFields ??= nativeFieldList(await this.getObjectMetadata('forge_material_sku', generation))
          const sku = object(unwrapData(await this.callTool('get_record', {
            objectName: 'forge_material_sku', recordId: skuId,
          }, generation)))
          if (!sku || recordID(sku) !== skuId) throw new Error('规格记录不可读取')
          const codeField = skuFields.find((field) => field.name === 'code' && canExposeField(field))
          const nameField = skuFields.find((field) => field.name === 'name' && canExposeField(field))
          const code = codeField ? stringValue(sku[codeField.name]) : undefined
          const name = nameField ? stringValue(sku[nameField.name]) : undefined
          return [
            ...(code ? [{ label: '物料规格编码', value: code }] : []),
            ...(name ? [{ label: '物料规格名称', value: name }] : []),
          ]
        })()
        skuCache.set(skuId, pending)
      }
      try { return await pending }
      catch {
        partial = true
        notes.push('部分物料规格编码当前不可读取；物料编码不能代替规格编码')
        return []
      }
    }
    for (const plan of plans) {
      const relation = relationTarget(plan.field)
      if (!relation) continue
      try {
        if (plan.direction === 'related') {
          const remaining = MAX_TOTAL_RELATED_ROWS - relatedRead
          if (remaining <= 0) { truncated = true; notes.push('关联明细行数达到安全上限'); break }
          const limit = Math.min(MAX_RELATION_ROWS, remaining)
          const skuReference = skuReadable ? plan.fields.find((field) => field.reference === 'forge_material_sku') : undefined
          const query = await this.callTool('query_records', {
            objectName: plan.summary.objectName,
            where: { [relationFieldName(plan.field)]: id },
            fields: [...new Set(['id', ...displayFields(plan.fields).map((field) => field.name), ...(skuReference ? [skuReference.name] : [])])],
            limit,
            offset: 0,
          }, generation)
          const page = queryRows(query)
          const recordFields = await Promise.all(page.rows.map(async (relatedRow) => {
            const snapshot = snapshotFields(plan.fields, relatedRow)
            return { values: [...snapshot.values, ...await skuLabels(relatedRow, plan.fields)], truncated: snapshot.truncated }
          }))
          const requiredForCalculation = plan.direction === 'related' && expectedCount !== undefined && isLineItemRelationship(plan.summary, plan.fields)
          const actionRecordIds = requiredForCalculation ? page.rows.map((relatedRow) => {
            const id = recordID(object(relatedRow) ?? {})
            return id && id.length <= 128 ? id : undefined
          }) : []
          const hasActionRecordIds = requiredForCalculation && actionRecordIds.length > 0
            && actionRecordIds.every((value): value is string => Boolean(value))
            && new Set(actionRecordIds).size === actionRecordIds.length
          const hasMore = page.hasMore !== undefined ? page.hasMore : page.totalCount !== undefined ? page.totalCount > page.rows.length : page.rows.length >= limit
          const countMatches = !requiredForCalculation || page.rows.length === expectedCount && (page.totalCount === undefined || page.totalCount === expectedCount)
          const relationComplete = !hasMore && countMatches && recordFields.every((entry) => !entry.truncated)
          relatedRead += page.rows.length
          relations.push({
            label: relationLabel(plan.summary, plan.field), direction: plan.direction,
            records: recordFields.map((entry) => entry.values), returnedCount: page.rows.length, limit, complete: relationComplete,
            ...(hasActionRecordIds && relationComplete ? { recordIds: actionRecordIds as string[] } : {}),
            ...(requiredForCalculation ? { requiredForCalculation: true, expectedCount } : {}),
          })
          if (requiredForCalculation && !hasActionRecordIds) notes.push('部分明细缺少可校验的原生操作标识；不能让成员猜测明细引用')
          if (requiredForCalculation && countMatches && !hasMore) pricingDetailCompleteness = 'complete'
          if (requiredForCalculation && !countMatches) {
            blockingDetailMismatch = true
            pricingDetailCompleteness = 'incomplete'
            notes.push(`明细关系“${relationLabel(plan.summary, plan.field)}”返回 ${page.rows.length} 条，与主记录声明的 ${expectedCount} 条不一致；停止按完整明细核算`)
          }
          if (!relationComplete) {
            truncated = true
            notes.push('部分关联明细达到分页或字段上限')
          }
        } else {
          const rawReference = row[plan.field.name]
          const referenceValue = object(rawReference)
          const referenceID = text(rawReference) ?? text(referenceValue?.id) ?? text(referenceValue?._id)
          if (!referenceID) {
            if (rawReference !== undefined && rawReference !== null && rawReference !== '') {
              partial = true
              notes.push('部分原生关系值未能解析为记录引用')
              relations.push({ label: relationLabel(plan.summary, plan.field), direction: plan.direction, records: [], returnedCount: 0, limit: 1, complete: false })
            }
            continue
          }
          const related = object(unwrapData(await this.callTool('get_record', { objectName: plan.summary.objectName, recordId: referenceID }, generation)))
          if (!related) {
            partial = true
            notes.push('部分关联记录当前不可读取')
            relations.push({ label: relationLabel(plan.summary, plan.field), direction: plan.direction, records: [], returnedCount: 0, limit: 1, complete: false })
            continue
          }
          if (objectName === 'forge_material_sku' && plan.summary.objectName === 'forge_material' && plan.field.name === 'material_id'
            && recordID(related) === referenceID && rootFields.some(field => field.name === 'name' && canExposeField(field))
            && plan.fields.some(field => field.name === 'name' && canExposeField(field)) && text(row.name) && text(related.name)) {
            creationSku = { name: text(row.name)!, materialName: text(related.name)!,
              ...(rootFields.some(field => field.name === 'code' && canExposeField(field)) && text(row.code) ? { code: text(row.code)! } : {}) }
          }
          const snapshot = snapshotFields(plan.fields, related)
          relations.push({ label: relationLabel(plan.summary, plan.field), direction: plan.direction, records: [snapshot.values], returnedCount: 1, limit: 1, complete: !snapshot.truncated })
          truncated ||= snapshot.truncated
        }
      } catch (error) {
        if (error instanceof Error && /账号已切换|登录已失效|会话已变化/.test(error.message)) throw error
        partial = true
        notes.push(error instanceof ForgeBusinessReadError && error.kind === 'forbidden' ? '部分关联记录无读取权限' : '部分关联记录读取失败或已不可见')
        relations.push({
          label: relationLabel(plan.summary, plan.field), direction: plan.direction,
          records: [], returnedCount: 0, limit: plan.direction === 'related' ? MAX_RELATION_ROWS : 1, complete: false,
          ...(plan.direction === 'related' && expectedCount !== undefined && isLineItemRelationship(plan.summary, plan.fields) ? { requiredForCalculation: true, expectedCount } : {}),
        })
        if (plan.direction === 'related' && expectedCount !== undefined && isLineItemRelationship(plan.summary, plan.fields)) {
          blockingDetailMismatch = true
          pricingDetailCompleteness = 'incomplete'
        }
      }
    }
    if (expectedCount !== undefined) {
      if (expectedCount === 0 && !lineItemPlans.length) {
        pricingDetailCompleteness = 'complete'
      } else if (lineItemPlans.length) {
        const verified = lineItemPlans.every((plan) => {
          const detail = relations.find((relationValue) => relationValue.direction === 'related'
            && relationValue.label === relationLabel(plan.summary, plan.field))
          return detail?.complete === true && detail.returnedCount === expectedCount && detail.expectedCount === expectedCount
        })
        pricingDetailCompleteness = verified ? 'complete' : 'incomplete'
        if (!verified) {
          blockingDetailMismatch = true
          notes.push(`无法核实全部 ${expectedCount} 条明细，价格核算前必须补齐或核对原生明细读取结果`)
        }
      }
    }
    const candidate = candidateFromRow(rootObject, rootFields, row) ?? {
      objectName, objectLabel: rootObject.label, recordId: id,
      name: rootObject.label,
      ...(versionValue(rootFields, row) ? { recordVersion: versionValue(rootFields, row) } : {}),
    }
    const domainVersion = versionValue(rootFields, row)
    if (!relations.every((relation) => relation.complete)) partial = true
    if (expectedCount !== undefined && expectedCount > 0 && !lineItemPlans.length) pricingDetailCompleteness = 'incomplete'
    const snapshot: BusinessRecordSnapshot = {
      version: 1, capturedAt: new Date().toISOString(), objectLabel: rootObject.label,
      record: rootSnapshot.values, relations,
      completeness: blockingDetailMismatch ? 'incomplete' : truncated ? 'truncated' : partial ? 'partial' : 'complete',
      pricingDetailCompleteness,
      ...(expectedCount !== undefined ? { expectedDetailCount: expectedCount } : {}),
      completenessNotes: [...new Set(notes)],
      ...(domainVersion ? { domainVersion } : {}),
    }
    if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > 220_000) {
      throw new ForgeBusinessReadError('failed', '所选记录及关联明细超出桌面固定输入上限')
    }
    const { presentBusinessRecord } = await import('./business-record-presentation')
    const presentation = presentBusinessRecord(snapshot, rootFields, plans.map((plan) => ({
      label: relationLabel(plan.summary, plan.field), direction: plan.direction,
      fields: [...plan.fields, { name: 'sku_code', label: '物料规格编码', type: 'text' }, { name: 'sku_name', label: '物料规格名称', type: 'text' }],
    })))
    return { candidate, snapshot, presentation, ...(creationSku ? { creationSku } : {}) }
  }
}

export function opaqueBusinessReference(seed: unknown): string {
  return createHash('sha256').update(JSON.stringify(seed)).digest('hex').slice(0, 32)
}
