import type { QuotationApprovalLines } from '../types/api'

/** Business names and values only; identity and cost fields never enter this projection. */
export function quotationApprovalText(lines?: QuotationApprovalLines): string {
  if (!lines) return ''
  return [
    `报价提交时冻结的完整明细：核价版本 ${lines.pricingVersion}，${lines.itemCount} 项，含税合计 ${lines.totalAmount}。`,
    ...lines.rows.map((row) => `- 第${row.position}项「${row.name}」：${row.lineType === 'material' ? '物料' : '服务'}，数量 ${row.quantity}${row.unitName ? ` ${row.unitName}` : ''}，含税单价 ${row.taxedUnitPrice}，税率 ${row.taxRate}%，折扣 ${row.discountRate}%，含税小计 ${row.taxedSubtotal}。`),
    '这些明细来自当前审批的提交版本；当前打开仍只授权查看，不授权审批或修改。',
  ].join('\n')
}
