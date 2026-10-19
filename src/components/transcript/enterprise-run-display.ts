import type { EnterpriseWorkCancellationResult } from '@/types/api'
import { enterpriseRunTerminal, type EnterpriseRunView } from '@/hooks/useEnterpriseRunStates'

export function enterpriseRunDisplay(view?: EnterpriseRunView, cancellation?: EnterpriseWorkCancellationResult) {
  const run = view?.run
  let state: string = run?.status ?? 'accepted'
  if (cancellation?.status === 'cancelled') state = 'cancelled'
  else if (cancellation?.status === 'completed' && (!run || !enterpriseRunTerminal(run.status))) state = 'ended'
  else if (cancellation?.status === 'cancel_requested' && (!run || !enterpriseRunTerminal(run.status))) state = 'cancel_requested'
  else if (cancellation?.status === 'unknown' && (!run || !enterpriseRunTerminal(run.status))) state = 'cancel_unknown'
  const ended = enterpriseRunTerminal(state) || state === 'ended'
  if (run?.businessResult === 'needs_input' && ['running', 'parked', 'succeeded'].includes(state)) state = 'needs_input'
  const labels: Record<string, string> = { accepted: '状态待核对', queued: '等待执行', running: '团队执行中', parked: '等待中', cancel_requested: '正在停止', cancel_unknown: '取消待核对', succeeded: '团队执行完成', failed: '团队执行失败', cancelled: '已取消', abandoned: '已结束', ended: '工作已结束', needs_input: '需要补充' }
  const cancellationConfirmed = cancellation?.status === 'cancelled' || cancellation?.status === 'completed'
  const stale = !cancellationConfirmed && Boolean(view?.stale || view?.unavailable)
  const label = stale ? view?.unavailable ? '状态暂不可用' : '状态未更新' : labels[state]
  const detail = view?.stale && run ? `上次状态：${labels[run.status]}`
    : view?.unavailable ? '当前账号暂时无法读取这项工作'
    : run?.businessResult === 'action_failed' ? '业务动作未成功'
    : run?.businessResult === 'action_unknown' ? '业务回执待核对'
    : run?.isCurrent === false ? '已有后续工作'
    : state === 'needs_input' ? '从“我的工作”查看补充要求'
    : state === 'parked' ? '等待原因尚未核对' : undefined
  return { state: stale ? 'unavailable' : state, label, detail, ended, animate: !stale && state === 'running' && run?.isCurrent === true }
}
