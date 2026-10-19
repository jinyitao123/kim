/** Display only whole, safe platform-authored action facts; never infer effects. */
export interface WorkActionFact { actionName: string; status: 'succeeded' | 'failed' | 'unknown'; summary: string }
const internal = /[0-9a-f]{8}-[0-9a-f-]{27,}|\b[0-9a-f]{24,}\b|https?:\/\/|\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{12,}|[\\/]|\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b|\b(?:Bearer|password|secret|token|authorization|api.?key)\s*[:= ]|(?:Error|Exception):|\bat\s+\w+\./i
function safe(value: string): boolean {
  return Boolean(value.trim()) && value.length <= 500 && !internal.test(value)
    && !Array.from(value).some((char) => char.charCodeAt(0) < 32)
}
export function projectWorkActionFact(outcome: WorkActionFact): WorkActionFact {
  const quoted = /业务动作“([^”]{1,128})”/.exec(outcome.summary)?.[1]
  const actionName = quoted && safe(quoted) ? quoted : safe(outcome.actionName) ? outcome.actionName : '业务动作'
  return { actionName, status: outcome.status, summary: safe(outcome.summary) ? outcome.summary : '未取得可展示的业务原因，请从原工作核对。' }
}
export function workActionTitle(outcome: WorkActionFact): string {
  return `${outcome.actionName}${outcome.status === 'failed' ? '未完成' : outcome.status === 'unknown' ? '结果待核对' : '：工具调用返回成功'}`
}
export function workActionReceiptMeaning(status: WorkActionFact['status']): string {
  return status === 'succeeded' ? '已取得成功回执；最终业务状态以业务系统记录为准。'
    : status === 'unknown' ? '结果尚未确认，本次未取得成功回执；请先核对原工作，避免重复提交。'
      : '本次未取得成功回执；是否产生业务效果仍需核对。'
}
