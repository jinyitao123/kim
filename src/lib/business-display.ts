const INTERNAL_VALUE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b[0-9a-f]{32,}\b/i
const FILE_PATH = /(?:^|[\s"'(])(?:file:\/\/|[a-z]:[\\/]|\\\\|\.{1,2}[\\/]|\/[^\s/]+(?:\/[^\s/]+)+)/i

export function businessDisplayValue(value: unknown): string | undefined {
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (!text || INTERNAL_VALUE.test(text) || FILE_PATH.test(text) || text.startsWith('/') || /^[{[]/.test(text)) return undefined
  return text.length > 600 ? `${text.slice(0, 600)}…（摘录）` : text
}

export function businessReadCompletenessText(value: 'complete' | 'partial' | 'truncated' | 'incomplete'): string {
  return {
    complete: '当前账号可见范围内的业务信息已读取。',
    partial: '部分关联信息未能完整读取，请在业务系统中核对。',
    truncated: '部分业务信息达到读取上限，请在业务系统中查看完整内容。',
    incomplete: '关联明细尚未完整核实，暂不能据此确认金额或数量。',
  }[value]
}
