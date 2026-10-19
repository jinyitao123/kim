type Row = Record<string, unknown>
const row = (value: unknown): Row | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined
const labels: Record<string, string> = {
  gooeypi_enterprise_initialization: '读取企业准备项',
  gooeypi_enterprise_initialization_list: '查看原生初始化动作',
  gooeypi_enterprise_initialization_run: '办理原生初始化动作',
  gooeypi_enterprise_initialization_workbook: '读取初始化工作簿',
  gooeypi_enterprise_initialization_preview: '预检企业资料',
  gooeypi_enterprise_initialization_apply: '应用初始化方案',
  gooeypi_enterprise_initialization_result: '核对原批办理结果',
}
const privateValue = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b[0-9a-f]{64}\b|operation_key|nativeRequestDigest|operationId|fields_json|plan_key/i
function businessText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() && !privateValue.test(value) ? value : undefined
}
function payload(text: string): Row | undefined {
  try {
    const value = row(JSON.parse(text))
    if (Array.isArray(value?.content)) {
      const first = row(value.content[0])
      return typeof first?.text === 'string' ? row(JSON.parse(first.text)) : undefined
    }
    return value
  } catch { return undefined }
}
/** Display business facts while keeping protocol handles in the model/Host channel. */
export function initializationToolView(name: string | undefined, text?: string): { label: string; output: string } | undefined {
  if (!name || !labels[name]) return undefined
  const value = text ? payload(text) : undefined, lines: string[] = []
  const native = name === 'gooeypi_enterprise_initialization_list' || name === 'gooeypi_enterprise_initialization_run'
  const summary = businessText(value?.summary), actionLabel = businessText(value?.actionLabel)
  if (actionLabel) lines.push(actionLabel)
  if (summary) lines.push(summary)
  const states: Record<string, string> = { succeeded: '已完成', failed: '未完成', unknown: '结果待核对', rejected: '未办理', stocked: '已入库', pending_approval: '待审批' }
  if (typeof value?.status === 'string' && states[value.status]) lines.push(states[value.status])
  for (const raw of Array.isArray(value?.actions) ? value.actions : []) {
    const action = row(raw), label = businessText(action?.label)
    if (label) lines.push(label)
  }
  for (const raw of Array.isArray(value?.operations) ? value.operations : []) {
    const operation = row(raw)
    const label = businessText(operation?.actionLabel), status = typeof operation?.status === 'string' ? states[operation.status] : undefined
    if (label) lines.push(`${label}${status ? `：${status}` : ''}`)
  }
  for (const raw of Array.isArray(value?.changes) ? value.changes : Array.isArray(value?.outcomes) ? value.outcomes : []) {
    const change = row(raw)
    if (!change) continue
    const domain = businessText(change.domain) ?? '企业资料', businessName = businessText(change.name)
    const effect = change.effect === 'create' ? '新增 ' : change.effect === 'update' ? '更新 ' : change.effect === 'unchanged' ? '保持 ' : ''
    if (businessName) lines.push(`${effect}${domain}：${businessName}`)
    if (!native) for (const [label, field] of Object.entries(row(change.fields) ?? {})) if (businessText(label) && businessText(String(field)) && ['string', 'number', 'boolean'].includes(typeof field)) lines.push(`${label}：${String(field)}`)
  }
  for (const raw of Array.isArray(value?.errors) ? value.errors : []) { const error = row(raw); if (typeof error?.message === 'string') lines.push(`第${Number(error.row)}行：${error.message}`) }
  for (const raw of Array.isArray(value?.domains) ? value.domains : []) { const domain = row(raw); if (typeof domain?.label === 'string') lines.push(`${domain.label}：${domain.state === 'present' ? '已有资料' : domain.state === 'missing' ? '待准备' : '暂不可读取'}`) }
  for (const raw of Array.isArray(value?.sheets) ? value.sheets : []) {
    const sheet = row(raw)
    if (typeof sheet?.name !== 'string') continue
    lines.push(`工作表：${sheet.name}${sheet.visibility === 'hidden' || sheet.visibility === 'veryHidden' ? '（隐藏表）' : ''}`)
    for (const rawRow of Array.isArray(sheet.rows) ? sheet.rows : []) {
      const sourceRow = row(rawRow)
      for (const rawCell of Array.isArray(sourceRow?.cells) ? sourceRow.cells : []) {
        const cell = row(rawCell)
        if (typeof cell?.cell === 'string') lines.push(`${cell.cell}：${cell.unread ? '未可靠读取' : cell.value == null ? '空白' : String(cell.value)}`)
      }
    }
  }
  for (const raw of Array.isArray(value?.warnings) ? value.warnings : []) {
    const warning = row(raw)
    if (typeof warning?.reason === 'string') lines.push(`${typeof warning.sheet === 'string' ? warning.sheet : ''}${typeof warning.cell === 'string' ? ` ${warning.cell}` : ''}：${warning.reason}`)
  }
  return { label: labels[name], output: lines.filter(line => !privateValue.test(line)).join('\n') || (text ? '本步骤结果需结合当前资料核对。' : '正在办理。') }
}
