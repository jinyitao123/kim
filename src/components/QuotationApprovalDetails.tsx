import type { QuotationApprovalLines } from '../types/api'

export function QuotationApprovalDetails({ lines }: { lines?: QuotationApprovalLines }) {
  if (!lines) return null
  return <section className="work-quotation-lines">
    <h4>报价明细</h4>
    <p>提交核价版本 {lines.pricingVersion} · {lines.itemCount} 项 · 合计 {lines.totalAmount}</p>
    <div className="work-quotation-lines-scroll" role="region" aria-label="提交时冻结的报价明细" tabIndex={0}>
      <table><thead><tr><th>明细</th><th>类型</th><th>数量</th><th>含税单价</th><th>税率</th><th>折扣</th><th>小计</th></tr></thead>
        <tbody>{lines.rows.map((row) => <tr key={row.position}>
          <td>{row.name}</td><td>{row.lineType === 'material' ? '物料' : '服务'}</td><td>{row.quantity}{row.unitName ? ` ${row.unitName}` : ''}</td>
          <td>{row.taxedUnitPrice}</td><td>{row.taxRate}%</td><td>{row.discountRate}%</td><td>{row.taxedSubtotal}</td>
        </tr>)}</tbody></table>
    </div>
  </section>
}
