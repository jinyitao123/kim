import { projectWorkActionFact, workActionTitle, workActionReceiptMeaning } from '@/lib/work-action-outcomes'
import { Check, ChevronDown, CircleAlert, FileText } from 'lucide-react'
import type { EnterpriseTaskScopeDisplay, EnterpriseWorkRunDetails } from '@/types/api'
import type { EnterpriseRunView } from '@/hooks/useEnterpriseRunStates'

const stageLabels: Record<string, string> = { pending: '待执行', queued: '等待执行', running: '处理中', waiting: '等待处理', parked: '等待中', completed: '执行完成', succeeded: '执行完成', failed: '失败', cancelled: '已停止', stopped: '已停止', not_recorded: '未记录', partially_completed: '部分执行完成', skipped: '已跳过' }
export function executionDuration(ms: number): string {
  if (ms < 1000) return '不足 1 秒'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes} 分 ${seconds % 60} 秒` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}
const fileSize = (bytes: number): string => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`
export function RunExecutionTime({ details }: { details?: EnterpriseWorkRunDetails }) {
  if (!details) return null
  if (!details.acceptedAt) return <div className="enterprise-execution-time">接单时间未取得 · 耗时未取得</div>
  const end = details.finishedAt ?? details.observedAt
  const duration = end ? Date.parse(end) - Date.parse(details.acceptedAt) : undefined
  return <div className="enterprise-execution-time"><span>接单 <time dateTime={details.acceptedAt}>{new Date(details.acceptedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></span>{duration !== undefined && duration >= 0 ? <span>{details.finishedAt ? '总耗时' : '已持续'} {executionDuration(duration)}</span> : <span>耗时未取得</span>}</div>
}

export function RunExecutionDetails({ view }: { view?: EnterpriseRunView }) {
  const details = view?.details
  if (view?.detailStale) return <p className="enterprise-execution-unavailable" role="status">执行详情暂时无法核对，请稍后刷新。</p>
  if (!details || details.status !== view?.run?.status) return <p className="enterprise-execution-unavailable">正在核对执行详情…</p>
  const issues = details.actionOutcomes?.filter((item) => item.status !== 'succeeded').map(projectWorkActionFact) ?? []
  return <>
    {issues.length ? <section className="enterprise-execution-result" aria-label="业务动作未完成原因"><ul>{issues.map((outcome, index) => <li key={index}><h4>{workActionTitle(outcome)}</h4><p>{outcome.summary}</p><p>{workActionReceiptMeaning(outcome.status)}</p></li>)}</ul></section> : null}
    {(details.result || details.explanation) ? <section className="enterprise-execution-result"><h4>{details.result?.title ?? (details.status === 'failed' ? '本次未完成' : '执行结果')}</h4>{details.result ? <p>{details.result.summary}</p> : null}{details.explanation ? <p>{details.explanation}</p> : null}{details.result?.missingItems.length ? <ul>{details.result.missingItems.map((item, index) => <li key={index}>{item}</li>)}</ul> : null}</section> : null}
    <section className="enterprise-execution-process"><h4>执行过程<span>{details.members.length ? `${details.members.length} 名成员` : '暂无记录'}</span></h4>
      {details.members.map((member, index) => <details key={index} className={`enterprise-member is-${member.status}`} open={member.status === 'failed' || member.status === 'running' || undefined}>
        <summary><span className="enterprise-member-dot" aria-hidden="true">{['completed', 'succeeded'].includes(member.status) ? <Check size={11} /> : member.status === 'failed' ? <CircleAlert size={11} /> : null}</span><strong>{member.name}</strong><span>{stageLabels[member.status] ?? '未记录'}</span>{member.stages.length ? <ChevronDown size={12} aria-hidden="true" /> : null}</summary>
        {member.stages.length ? <ol>{member.stages.map((stage, stageIndex) => <li key={stageIndex} className={`is-${stage.status}`}><span>{stage.name}</span><small>{stageLabels[stage.status] ?? '未记录'}{stage.durationMs !== undefined ? ` · ${executionDuration(stage.durationMs)}` : ''}</small></li>)}</ol> : <p>尚无步骤记录</p>}
      </details>)}
      {!details.activityComplete ? <p className="enterprise-execution-note">仅显示已读取的执行记录</p> : null}
    </section>
    <section className="enterprise-action-counts"><h4>业务动作记录<span>{details.actionCounts ? `${details.actionCounts.succeeded + details.actionCounts.failed + details.actionCounts.unknown} 条` : '未取得'}</span></h4>{details.actionCounts ? <div><span>成功 <b>{details.actionCounts.succeeded}</b></span><span>未成功 <b>{details.actionCounts.failed}</b></span><span>待核对 <b>{details.actionCounts.unknown}</b></span></div> : null}</section>
  </>
}

export function RunMaterials({ scope, details }: { scope: EnterpriseTaskScopeDisplay; details?: EnterpriseWorkRunDetails }) {
  const materials = details?.materials ?? scope.reads.filter((name) => /\.(pdf|docx|md|txt|csv|json)$/i.test(name)).map((name) => ({ name, format: name.split('.').at(-1)!.toUpperCase(), bytes: undefined }))
  const otherReads = scope.reads.filter((name) => !materials.some((item) => item.name === name))
  return <>
    <section className="enterprise-materials"><h4>本次材料<span>{materials.length || details ? `${materials.length} 份` : '未取得'}</span></h4>{materials.length ? <ul>{materials.map((file, index) => <li key={index}><span className={`enterprise-file-format is-${file.format.toLowerCase()}`} aria-hidden="true"><FileText size={13} />{file.format}</span><span className="enterprise-file-name">{file.name}</span>{file.bytes !== undefined ? <small>{fileSize(file.bytes)}</small> : null}</li>)}</ul> : details ? <p>本次未附文件</p> : null}</section>
    <section className="enterprise-authorization"><h4>授权范围{scope.writes.length ? <span>限本次工作</span> : <span className="enterprise-readonly">只读分析</span>}</h4>{otherReads.length ? <p>可查看 · {otherReads.join('、')}</p> : null}{scope.writes.length ? <p>可写入 · {scope.writes.join('、')}</p> : null}</section>
  </>
}
