import type { EnterpriseBusinessNotificationContextView, EnterpriseWorkItem } from '../types/api'
import { businessDisplayValue, businessReadCompletenessText } from './business-display'

export function businessNotificationPrompt(item: EnterpriseWorkItem, context: EnterpriseBusinessNotificationContextView): string {
  const record = context.record
  const rowText = (row: typeof record.fields) => row.flatMap((field) => {
    const label = businessDisplayValue(field.label), value = businessDisplayValue(field.value)
    return label && value !== undefined ? [`${label}：${value}`] : []
  })
  const fields = rowText(record.fields).map((field) => `- ${field}`).join('\n')
  const relations = record.relations.map((relation) => {
    const rows = relation.records.flatMap((row, index) => { const values = rowText(row); return values.length ? [`  ${index + 1}. ${values.join('；')}`] : [] }).join('\n')
    return `### ${relation.label}${relation.complete ? '' : '（当前账号可读范围不完整）'}\n${rows || '没有读取到可展示的关联行。'}`
  }).join('\n\n')
  const materials = context.materialStatus === 'unavailable'
    ? 'Forge 当前无法读取这条消息关联的材料。材料未读取不代表没有材料；不要用历史通知正文替代原件内容。'
    : context.materialStatus === 'none'
      ? 'Forge 确认当前没有可读取的业务材料。'
      : context.materials.map((file) => `#### ${file.name}（原件已核验，提取${file.extraction.status === 'complete' ? '完整' : file.extraction.status === 'partial' ? '不完整' : '不可用'}）\n${file.extraction.content}${file.extraction.limitations.length ? '\n提取限制：部分页面、图片或文档内容未能提取，请查看完整原件。' : ''}`).join('\n\n')
  const readStatus = businessReadCompletenessText(record.completeness)
  const completeness = `当前读取情况：${[readStatus, ...record.completenessNotes.filter((note) => note !== readStatus)].join('；')}`
  return [
    '你打开的是一条历史 Forge 业务结果通知。通知标题和摘要只说明当时发出的消息，不代表当前业务事实。',
    `历史通知标题：${item.title}`,
    item.summary ? `历史通知摘要：\n${item.summary}` : '',
    `当前记录读取时间：${context.currentReadAt}`,
    `当前业务记录：${record.objectLabel} · ${record.name}${record.code ? ` · ${record.code}` : ''}${record.status ? ` · ${record.status}` : ''}${record.owner ? ` · ${record.owner}` : ''}`,
    fields ? `当前业务信息（摘录）：\n${fields}` : '',
    relations,
    completeness,
    `材料状态：${context.materialStatus === 'available' ? '已按当前账号读取并核验' : context.materialStatus === 'none' ? '没有可读取材料' : '暂时无法读取'}`,
    materials,
    '本次打开仅用于只读查看与整理，不提交业务动作、不发起团队工作。请按当前记录与已读取的材料回答，并把历史通知和当前状态分开说明。',
    '只有员工在之后的新消息中明确提出新的工作要求，才按该新要求使用现有工具；这条历史消息本身不构成业务写入或团队交接授权。',
  ].filter(Boolean).join('\n\n')
}
