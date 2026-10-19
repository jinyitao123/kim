import type { QuotationApprovalLines } from '../../../src/types/api'
import { rejectUnknownKeys, requireRecord, requireString } from '../validation'

const round4 = (value: number) => Math.round((value + Number.EPSILON) * 10_000) / 10_000
function amount(value: unknown, maximum = Number.MAX_VALUE): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum) throw new Error('冻结报价明细数值不可核验')
  return value
}

/** Accept only complete, business-only rows from the native approval payload. */
export function parseQuotationApprovalLines(value: unknown, objectName: string): QuotationApprovalLines | undefined {
  if (value === undefined) return undefined
  if (objectName !== 'forge_quotation') throw new Error('冻结报价明细与当前审批对象不一致')
  const source = requireRecord(value, 'quotation approval lines')
  rejectUnknownKeys(source, ['version', 'pricingVersion', 'itemCount', 'totalAmount', 'rows'], 'quotation approval lines')
  const { pricingVersion, itemCount } = source
  if (source.version !== '1' || !Number.isSafeInteger(pricingVersion) || Number(pricingVersion) < 0
    || !Number.isInteger(itemCount) || Number(itemCount) < 1 || Number(itemCount) > 100
    || !Array.isArray(source.rows) || source.rows.length !== itemCount) throw new Error('冻结报价明细不完整')
  const totalAmount = amount(source.totalAmount)
  const rows = source.rows.map((value, index) => {
    const row = requireRecord(value, 'quotation approval row')
    rejectUnknownKeys(row, ['position', 'name', 'lineType', 'quantity', 'taxedUnitPrice', 'taxRate', 'discountRate', 'taxedSubtotal', 'unitName'], 'quotation approval row')
    if (row.position !== index + 1 || !['material', 'service'].includes(String(row.lineType))) throw new Error('冻结报价明细顺序或类型无效')
    const name = requireString(row.name, '明细名称', { min: 1, max: 255 })
    const quantity = amount(row.quantity), taxedUnitPrice = amount(row.taxedUnitPrice)
    const taxRate = amount(row.taxRate, 100), discountRate = amount(row.discountRate, 100), taxedSubtotal = amount(row.taxedSubtotal)
    const calculated = round4(quantity * taxedUnitPrice * (1 - discountRate / 100))
    if (quantity <= 0 || !Number.isFinite(calculated) || calculated !== taxedSubtotal) throw new Error('冻结报价明细小计不一致')
    const unitName = row.unitName === undefined ? undefined : requireString(row.unitName, '明细单位', { min: 1, max: 128 })
    return { position: index + 1, name, lineType: row.lineType as 'material' | 'service', quantity, taxedUnitPrice,
      taxRate, discountRate, taxedSubtotal, ...(unitName ? { unitName } : {}) }
  })
  if (round4(rows.reduce((sum, row) => sum + row.taxedSubtotal, 0)) !== totalAmount) throw new Error('冻结报价明细与合计不一致')
  return { version: '1', pricingVersion: Number(pricingVersion), itemCount: Number(itemCount), totalAmount, rows }
}
