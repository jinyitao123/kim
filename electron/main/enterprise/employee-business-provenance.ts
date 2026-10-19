import type { EmployeeBusinessAction, EmployeeBusinessContext, EmployeeBusinessLineItem, EmployeeBusinessTarget, EmployeeBusinessValue } from '../../../src/types/employee-business'
import type { BusinessInputSource } from './employee-business-inputs'
import { digest } from './handoff-store'
import { requireRecord, requireString } from '../validation'

export interface DraftFieldEvidence {
  value: EmployeeBusinessValue
  source?: BusinessInputSource
  lineFragment?: string
  nativeReference?: { objectName: string; field: string; contextVersion: string }
  derived?: 'material' | 'service'
}
export type DraftEvidence = Record<string, DraftFieldEvidence>
export function isDraftAction(action: EmployeeBusinessAction): boolean {
  return ['forge:action:forge_sales_lead.sales_lead_create', 'forge:action:forge_quotation.sales_quotation_draft_create',
    'forge:action:forge_sales_contract.contract_draft_payment_term_update', 'forge:action:forge_quotation.quotation_convert_to_contract'].includes(action.capabilityId)
}
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const clauses = (text: string) => text.split(/[，,。；;\n]/).map(value => value.trim()).filter(Boolean)
const excluded = (text: string, estimate = false) => /(?:不要|不用|不选|不是|不采用|不需要|如果|假如|除非|倾向|建议|你觉得|是否|能否|大概|估计|可能|或许|不确定|不知道|未知|[?？])/.test(estimate ? text.replace(/大概|估计/g, '') : text)
const hasCode = (text: string, code: string) => new RegExp(`(?<![A-Za-z0-9_-])${escapeRegex(code)}(?![A-Za-z0-9_-])`).test(text)
const numberPattern = (value: number) => `(?<![\\d.\\-])${escapeRegex(String(value))}(?![\\d.])`
const chineseQuantity: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
const conversionFields: Record<string, string[]> = {
  name: ['合同名称', '名称'], code: ['合同编号', '编号'], contract_type_id: ['合同类型', '类型'],
  starts_on: ['生效日期', '生效'], ends_on: ['到期日期', '到期'],
}
function conversionDateMatches(text: string, field: string, value: EmployeeBusinessValue): boolean {
  if (typeof value !== 'string' || /或|待定|左右|大约/.test(text)) return false
  const names = conversionFields[field].join('|')
  const found = [...text.matchAll(new RegExp(`(?:${names})\\s*[：:]?\\s*(?:(\\d{4})年(\\d{1,2})月(\\d{1,2})日|(\\d{4})-(\\d{2})-(\\d{2}))`, 'g'))]
  if (found.length !== 1) return false
  const parts = found[0][1] ? found[0].slice(1, 4) : found[0].slice(4, 7)
  const date = `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`
  return date === value && Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date
}
function conversionFieldAssignment(text: string, field: string): boolean {
  return conversionFields[field].some(name => new RegExp(`${name}\\s*(?:就)?(?:用|改|换|更换|变更|调整|是|为|设|定|不要|不用|不再|取消|[:：]|\\d{4})|(?:不要|不用|不再|取消)\\s*${name}`).test(text))
}
function matches(text: string, field: string, value: EmployeeBusinessValue, label?: string, estimate = false, conversionField?: string): boolean {
  if (excluded(text, estimate)) return false
  if (conversionField) {
    if (['starts_on', 'ends_on'].includes(conversionField)) return conversionDateMatches(text, conversionField, value)
    const assigned = text.match(new RegExp(`^(?:${conversionFields[conversionField].join('|')})\\s*(?:就)?(?:用|为|是|设为|定为|改为|改成|换成|换为)?\\s*[：:]?\\s*(.+)$`))?.[1]
    return Boolean(assigned && (assigned.includes(String(value)) || label && assigned.includes(label)))
  }
  if (typeof value !== 'number') return text.includes(String(value)) || Boolean(label && text.includes(label))
  const number = numberPattern(value)
  if (estimate) return /(?:估算|预估|估计|预计|内部.{0,4}大概)/.test(text) && new RegExp(number).test(text)
  if (field === 'quantity') {
    const alternatives = [number, ...Object.entries(chineseQuantity).filter(([, n]) => n === value).map(([word]) => word)].join('|')
    return new RegExp(`(?:数量\\s*[：:]?\\s*(?:${alternatives})|(?:${alternatives})\\s*(?:套|项|个|件|台|次|人|小时|天|月|年|米|箱|张|份|组|批))`).test(text)
  }
  if (field === 'tax_rate') return new RegExp(`税率\\s*[：:]?\\s*${number}`).test(text)
  if (field === 'discount_rate') return new RegExp(`折扣(?:率)?\\s*[：:]?\\s*${number}`).test(text)
  if (field === 'taxed_unit_price') return new RegExp(`(?:(?:含税单价|单价|价格)\\s*[：:]?\\s*${number}|${number}\\s*(?:元)?$)`).test(text)
  return new RegExp(number).test(text)
}
function sourceClauses(source: BusinessInputSource, row?: EmployeeBusinessLineItem, field?: string, anchors?: string[]): string[] {
  const parts = clauses(source.text)
  if (!row) return parts
  const names = anchors ?? (typeof row.name === 'string' ? [row.name] : [])
  const name = names.find(value => parts.some(part => part.includes(value)))
  if (!name) return []
  if (parts.filter(part => part.includes(name)).length !== 1) return []
  const index = parts.findIndex(part => part.includes(name))
  if (index < 0) return []
  // Adjacent explicitly labelled modifiers belong to this named line, not another line.
  const result = [parts[index]]
  for (let next = index + 1; next < parts.length && /^(?:数量|含税单价|单价|价格|税率|折扣(?:率)?)[：:\s\d]/.test(parts[next]); next++) result.push(parts[next])
  return field === 'name' || field === 'line_type' ? [parts[index]] : result
}
function relevant(source: BusinessInputSource, row: EmployeeBusinessLineItem | undefined, field: string, label: string, anchors?: string[]) {
  return sourceClauses(source, row, field, anchors).filter(part => row ? field === 'quantity' ? /数量|[套项个件台次人米箱张份组批]|小时|天|月|年/.test(part)
    : field === 'tax_rate' ? part.includes('税率') : field === 'discount_rate' ? part.includes('折扣') : field === 'taxed_unit_price' ? !/^(?:数量|税率|折扣)/.test(part) && /(?:含税单价|单价|价格)|\d(?:\.\d+)?(?:元)?$/.test(part) : true
    : part.includes(label) || field === 'payment_term' && /付款|支付|到货|预付|结清|账期/.test(part))
}
/** This checks bounded literal provenance, not language-driven execution or business defaults. */
export function proveDraftInputs(options: {
  context: EmployeeBusinessContext; selection: EmployeeBusinessTarget; action: EmployeeBusinessAction
  values: Record<string, EmployeeBusinessValue>; lineItems?: EmployeeBusinessLineItem[]
  rawSources: unknown; sources: BusinessInputSource[]; conflictSources?: BusinessInputSource[]; messageId: string; previous?: DraftEvidence
}): DraftEvidence {
  const { context, selection, action, values, lineItems, sources, messageId, previous } = options
  const conversion = action.capabilityId === 'forge:action:forge_quotation.quotation_convert_to_contract'
  if (conversion && (!('record' in selection) || selection.record.objectName !== 'forge_quotation' || lineItems !== undefined
    || Object.keys(values).some(field => !(field in conversionFields)))) throw new Error('报价转合同仅允许当前报价及声明的合同草稿字段')
  const paths = Object.keys(values).map(name => `values.${name}`)
  for (const [index, row] of (lineItems ?? []).entries()) for (const name of Object.keys(row)) paths.push(`lineItems.${index}.${name}`)
  const raw = options.rawSources === undefined ? {} : requireRecord(options.rawSources, 'input_sources')
  for (const path of Object.keys(raw)) if (!paths.includes(path)) throw new Error('参数来源路径不属于本次声明字段或明细行')
  const output: DraftEvidence = {}
  const conflictSources = options.conflictSources ?? sources
  for (const path of paths) {
    const pieces = path.split('.'), field = pieces.at(-1)!
    const inputRow = pieces[0] === 'lineItems' ? lineItems![Number(pieces[1])] : undefined
    // Material attribution uses the authoritative selected SKU label, never a model-supplied display name.
    const sku = action.lineItems?.fields.find(item => item.name === 'sku_id')
    const skuLabel = inputRow?.line_type === 'material' ? sku?.enumLabels?.find(item => item.value === inputRow.sku_id)?.label : undefined
    const nativeSku = inputRow?.line_type === 'material' && 'objectName' in selection ? selection.skuNames?.[String(inputRow.sku_id)] : undefined
    const materialName = nativeSku?.materialName
    const boundNames = 'objectName' in selection ? Object.values(selection.skuNames ?? {}) : []
    const uniqueMaterial = materialName && boundNames.filter(item => item.materialName === materialName).length === 1
    const uniqueSku = nativeSku && boundNames.filter(item => item.name === nativeSku.name).length === 1
    const expectedLabel = nativeSku ? `${nativeSku.materialName} · ${nativeSku.name}${nativeSku.code ? `（${nativeSku.code}）` : ''}` : undefined
    const anchors = nativeSku ? [skuLabel!, ...(uniqueSku ? [nativeSku.name] : []), ...(uniqueMaterial ? [materialName!] : []), ...(nativeSku.code && boundNames.filter(item => item.code === nativeSku.code).length === 1 ? [nativeSku.code] : [])] : undefined
    const row = inputRow
    if (inputRow?.line_type === 'material' && (!skuLabel || !nativeSku || !materialName || skuLabel !== expectedLabel || !sku?.enum?.includes(inputRow.sku_id!)
      || !('objectName' in selection) || !selection.referenceIds?.sku_id?.includes(String(inputRow.sku_id)))) throw new Error('物料明细须先读取并绑定准确SKU名称，不能用自填名称替代')
    const value = ((inputRow ?? values) as Record<string, EmployeeBusinessValue>)[field]!
    const parameter = (row ? action.lineItems!.fields : action.parameters).find(item => item.name === field)!
    const requested = raw[path] === undefined ? undefined : requireString(raw[path], 'input source', { min: 32, max: 32, trim: false })
    if (requested && !sources.some(item => item.source_ref === requested)) throw new Error('参数来源已失效或不属于本人本会话，请补充准确输入')
    if ('objectName' in selection && ['customer_id', 'contact_id', 'opportunity_id', 'quotation_type_id', 'issuer_id', 'sku_id'].includes(field)) {
      const ids = selection.referenceIds?.[field as keyof NonNullable<typeof selection.referenceIds>]
      if (!ids?.includes(String(value)) || !parameter.enum?.includes(value)) throw new Error('请先明确选择并读取准确业务引用，不能用原始编号或任意目录选项')
      const prior = previous?.[path]
      const source = requested ? sources.find(item => item.source_ref === requested) : prior?.value === value && prior?.source
        ? sources.find(item => item.source_ref === prior.source!.source_ref) : sources.find(item => item.messageId === messageId)
      if (!source || prior && prior.value !== value && source.messageId !== messageId) throw new Error('业务对象须来自员工明确选择；变更对象需要当前新输入')
      const label = parameter.enumLabels?.find(item => item.value === value)?.label
      const fact = selection.referenceFacts?.[field as keyof NonNullable<typeof selection.referenceFacts>]?.[String(value)]
      const selectsReference = (part: string) => !excluded(part) && (Boolean(label && part.includes(label))
        || Boolean(fact?.code && hasCode(part, fact.code)) || Boolean(fact?.uniqueQuery && part.includes(fact.uniqueQuery) && (label?.includes(fact.uniqueQuery) || fact.code === fact.uniqueQuery))
        || (field === 'sku_id' ? Boolean(nativeSku && part.includes(nativeSku.materialName) && part.includes(nativeSku.name)) : Boolean(fact?.name && fact.name === label && part.includes(fact.name))))
      const chosen = clauses(source.text).some(selectsReference)
      if (!chosen) throw new Error('所选业务引用与员工原话不一致或存在歧义，请明确名称、规格或可读编号；能读取不代表已选择')
      const laterConflict = conflictSources.filter(item => item.eventSeq > source.eventSeq).some(item => clauses(item.text).some(part => {
        if (/(?:如果|假如|除非|倾向|建议|你觉得|是否|能否|[?？])/.test(part)) return false
        const mentionsReference = part.includes(parameter.label) || Boolean(label && part.includes(label))
          || Boolean(fact?.name && part.includes(fact.name)) || Boolean(fact?.code && hasCode(part, fact.code))
          || Boolean(fact?.uniqueQuery && part.includes(fact.uniqueQuery))
          || Boolean(nativeSku && (part.includes(nativeSku.materialName) || part.includes(nativeSku.name)))
          || Boolean(parameter.enumLabels?.some(entry => part.includes(entry.label)))
        if (!mentionsReference) return false
        // A later correction invalidates the old source even when the model keeps the same value.
        return /(?:改为|改成|改用|改选|更换|换成|换为|另选|重新选择|取消|撤销|不再|不要|不用|不选|不是|别用)/.test(part) || !selectsReference(part)
      }))
      if (laterConflict) throw new Error('业务引用有后续更正或否定，请按最新员工选择核对，不能沿用旧来源')
      output[path] = { value, source, nativeReference: { objectName: selection.objectName, field, contextVersion: context.contextVersion } }
      continue
    }
    if (row && field === 'line_type') {
      if (value !== (row.sku_id ? 'material' : 'service')) throw new Error('请明确明细是已选物料还是服务，不能猜测行类型')
      if (value === 'material') { output[path] = { value, derived: value }; continue }
      // A service name has no vocabulary restriction; its employee source must explicitly select the declared service type.
    }
    const prior = previous?.[path]
    const fallback = sources.find(item => item.messageId === messageId)
    const source = requested ? sources.find(item => item.source_ref === requested) : prior && prior.value === value && prior.source
      ? sources.find(item => item.source_ref === prior.source!.source_ref) : fallback
    if (!source) throw new Error('请为已明确的参数选择原员工输入来源；缺少的业务事实需要补充')
    if (prior && prior.value !== value && source.messageId !== messageId) throw new Error('已固定参数发生变化，请由当前员工消息明确给出新值')
    const mapped = parameter.enumLabels?.find(entry => entry.value === value)
    const label = field === 'line_type' && value === 'service' && parameter.enum?.includes('service') ? '服务' : mapped && parameter.enumLabels?.filter(entry => entry.label === mapped.label).length === 1 ? mapped.label : undefined
    const estimate = action.capabilityId === 'forge:action:forge_sales_lead.sales_lead_create' && !row && field === 'estimated_amount'
    const conversionField = conversion ? field : undefined
    const fragments = sourceClauses(source, row, field, anchors).filter(part => matches(part, field, value, label, estimate, conversionField))
    if (!fragments.length) throw new Error('参数缺少准确员工来源或明细归属，请只补充尚不明确的字段')
    if (source.messageId !== messageId) {
      const conversionChanged = conversion && conflictSources.filter(item => item.eventSeq > source.eventSeq).some(item => clauses(item.text).some(part => conversionFieldAssignment(part, field)
        && !/(?:如果|假如|除非|建议|你觉得|是否|能否|[?？])/.test(part)
        && (/(?:改|换|变更|调整|不要|不用|不再|取消)/.test(part) || !matches(part, field, value, label, estimate, conversionField))))
      if (conversionChanged) throw new Error('合同草稿字段有后续更正，请核对最新员工输入')
      const conflicting = !conversion && conflictSources.filter(item => item.eventSeq > source.eventSeq).some(item => relevant(item, row, field, parameter.label, anchors)
        .some(part => !excluded(part, estimate) && !matches(part, field, value, label, estimate, conversionField) && (typeof value !== 'number' || /\d/.test(part))))
      if (conflicting) throw new Error('该字段有后续不同表述，请明确最新值，不能沿用历史数字或对象')
    }
    output[path] = { value, source: { ...source, text: source.text }, ...(row && field === 'quantity' ? { lineFragment: sourceClauses(source, row, field, anchors)[0] } : {}) }
  }
  const consumedLines = new Set<string>()
  for (let index = 0; index < (lineItems?.length ?? 0); index++) {
    const evidence = output[`lineItems.${index}.quantity`]
    if (!evidence?.source || !evidence.lineFragment) throw new Error('明细数量缺少独立员工行来源，不能增加数量')
    const lineKey = `${evidence.source.messageId}:${evidence.source.eventSeq}:${evidence.source.sha256}:${evidence.lineFragment}`
    if (consumedLines.has(lineKey)) throw new Error('同一员工明细来源不能重复形成多行，请明确每一行的独立来源')
    consumedLines.add(lineKey)
  }
  return output
}
export function assertDraftSourcesCurrent(evidence: DraftEvidence, sources: BusinessInputSource[]) {
  for (const proof of Object.values(evidence)) if (proof.source) {
    const current = sources.find(source => source.source_ref === proof.source!.source_ref)
    if (!current || current.messageId !== proof.source.messageId || current.eventSeq !== proof.source.eventSeq
      || current.sha256 !== proof.source.sha256 || current.transcriptSha256 !== proof.source.transcriptSha256 || digest(current.text) !== current.sha256) throw new Error('固定参数的员工来源已变化或丢失，未发送业务请求')
  }
}
