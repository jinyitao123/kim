export const WORKBENCH_RUN_CONTINUATION_TYPE = 'weave.workbench_run'
import type { EnterpriseWeaveWorkContinuationContextView } from '../types/api'

/** Without a recorded action, a team's wording cannot establish any business effect. */
export const TEAM_NO_RECORDED_ACTION_NOTE = '平台没有记录本轮任何业务动作，团队不会因本轮改变 Forge 业务记录；团队文字中“已转化”“已提交”“已办理”等说法不代表业务已发生，需要时请独立读取 Forge 当前状态。'

export const TEAM_RECORD_SOURCE_BOUNDARY_NOTE = '业务记录字段只证明系统当前记载了这些值，不自动等于客户确认；没有客户一手材料时，应说“记录载明”或“待核实”。'

export function teamRunContinuationBoundary(createdAt: string): string {
  const timestamp = new Date(createdAt).toLocaleString('zh-CN')
  return `这条工作消息形成于 ${timestamp}，记录的是当时这一次团队运行。Forge 当前业务记录可能已被之后的团队运行或员工操作改变；请把本次运行回执与当前业务状态分别说明，不能仅凭当前值把变化归因于本次动作。\n${TEAM_RECORD_SOURCE_BOUNDARY_NOTE}`
}

/** Server business results take precedence over the model's check opinion. */
export function teamRunResultNotice(context: EnterpriseWeaveWorkContinuationContextView): string {
  if (context.inputStatus === 'superseded') return '平台已确认同一工作有后续输入取代本次输入。请从最新工作消息继续，旧检查意见只作历史参考；这不表示 Forge 业务已完成。'
  const result = context.finalResult
  const businessResult = context.businessResult
    ?? (context.actionOutcomes?.some((outcome) => outcome.status === 'failed') ? 'action_failed'
      : context.actionOutcomes?.some((outcome) => outcome.status === 'unknown') ? 'action_unknown' : undefined)
  if (businessResult === 'action_failed' || businessResult === 'action_unknown') {
    return businessResult === 'action_failed'
      ? '平台确认本轮业务动作失败。请先核对 Forge 回执和当前业务状态，不要补件重跑或重放原业务动作。'
      : '平台尚未确认本轮业务动作结果。请先核对 Forge 回执和当前业务状态，不要补件重跑或重放原业务动作。'
  }
  if (context.runStatus === 'parked' && context.inputStatus === 'current'
    && context.authorization?.status === 'renewal_required' && context.authorization.canRenew === true) {
    return '这项工作原授权已过期，平台确认仍在无业务副作用的等待位置。只有员工在新消息明确要求继续原工作后，才调用续授权工具；保持原输入、材料和业务范围，不重新交接或重放未知动作。'
  }
  const hasSucceededAction = businessResult === undefined && context.runStatus === 'succeeded'
    && context.actionOutcomes?.some((outcome) => outcome.status === 'succeeded')
  const noRecordedAction = Array.isArray(context.actionOutcomes) && context.actionOutcomes.length === 0
  const needsInput = businessResult !== undefined ? businessResult === 'needs_input' : result?.disposition === 'needs_input'
  if (needsInput) return [
    hasSucceededAction
      ? 'Weave 本轮结构化结果列出的缺项是团队意见，供员工参考。本运行已有 Forge 确认成功的业务动作，这些意见不构成团队补材料待办，也不要求重跑团队；后续办理事项以 Forge 当前正式事项为准。'
      : '平台确认本轮需要员工补充。请按具体缺项继续，Forge 当前审批和业务状态仍需独立核对。',
    result?.summary ? `团队摘要：${result.summary}` : '',
    `${hasSucceededAction ? '团队列出的缺项意见（供参考）' : '本轮需要补充的内容'}：${result?.missingItems?.length ? result.missingItems.map((entry) => `- ${entry}`).join('\n') : '平台没有提供具体缺项。'}`,
  ].filter(Boolean).join('\n')
  if (businessResult === 'completed') return [
    '平台确认本轮团队工作已完成。模型列出的缺项仅作检查意见，不构成补材料待办，也不要求重跑团队；Forge 当前业务和审批状态必须独立读取，不能据此声称审批通过。',
    noRecordedAction ? TEAM_NO_RECORDED_ACTION_NOTE : '',
    result?.summary ? `团队检查意见：${result.summary}` : '',
  ].filter(Boolean).join('\n')
  if (result?.disposition === 'complete') return [
    'Weave 本轮结构化结果分类：团队检查已完成。该分类只表示团队检查结果，不表示 Forge 业务已完成。',
    noRecordedAction ? TEAM_NO_RECORDED_ACTION_NOTE : '',
    result.summary ? `团队摘要：${result.summary}` : '',
  ].filter(Boolean).join('\n')
  return context.runStatus === 'failed' && noRecordedAction ? TEAM_NO_RECORDED_ACTION_NOTE : ''
}
