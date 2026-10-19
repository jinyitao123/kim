import { useMemo } from 'react'
import { ArrowUpRight, Check, CircleAlert, Pause } from 'lucide-react'
import type { TranscriptMessage } from '@/types/api'
import { enterpriseRunTerminal, useEnterpriseRunStates } from '@/hooks/useEnterpriseRunStates'
import type { EnterpriseSummaryWork } from '../inspector/SummaryPanel'
import { enterpriseScopeProjection } from './EnterpriseScopeCards'
import { enterpriseRunDisplay } from './enterprise-run-display'

const returnedHeading: Record<string, string> = {
  succeeded: '团队工作已完成',
  needs_input: '团队需要你补充',
  parked: '团队在等你处理',
  failed: '团队工作没有完成',
  abandoned: '团队工作没有完成',
}

/**
 * The results of team work handed over in this conversation, shown at the end
 * of the conversation once each run finishes or needs the employee. Running
 * work stays in the summary panel; the agent is never started from here.
 */
export function TeamResultCards({ messages, teamWork, onOpenDetails }: {
  messages: TranscriptMessage[]
  teamWork?: EnterpriseSummaryWork
  onOpenDetails?(): void
}) {
  const scopes = useMemo(() => [...new Map(messages.flatMap((message) => enterpriseScopeProjection(message).scopes).map((scope) => [scope.runReference, scope])).values()], [messages])
  const latest = scopes.at(-1)?.runReference
  const states = useEnterpriseRunStates(scopes.map((scope) => scope.runReference), teamWork?.accountScope, teamWork?.read, latest, teamWork?.readDetails)
  if (!teamWork || !scopes.length) return null
  const returned = scopes.flatMap((scope) => {
    const view = states.views[scope.runReference]
    const display = enterpriseRunDisplay(view)
    if (!view?.run || view.stale || view.unavailable || view.run.isCurrent === false) return []
    const settled = enterpriseRunTerminal(view.run.status) || ['parked', 'needs_input'].includes(display.state)
    if (!settled || display.state === 'cancelled') return []
    return [{ scope, view, display }]
  })
  if (!returned.length) return null
  return <div className="team-result-cards">{returned.map(({ scope, view, display }) => {
    const details = view.details?.status === view.run?.status && !view.detailStale ? view.details : undefined
    const Icon = display.state === 'succeeded' ? Check : ['parked', 'needs_input'].includes(display.state) ? Pause : CircleAlert
    const finishedAt = details?.finishedAt ?? details?.observedAt
    return <section className={`team-result-card is-${display.state}`} aria-label="团队结果" key={scope.runReference}>
      <div className="team-result-card__divider" aria-hidden="true"><span>{finishedAt ? `${new Date(finishedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} ` : ''}团队结果已返回</span></div>
      <header><span className="team-result-card__icon" aria-hidden="true"><Icon size={15} /></span><div><strong>{returnedHeading[display.state] ?? display.label}</strong><small>{scope.team} · {scope.workflow}</small></div></header>
      {details?.result ? <div className="team-result-card__body"><h4>{details.result.title}</h4><p>{details.result.summary}</p>
        {details.result.missingItems.length ? <ul>{details.result.missingItems.map((item, index) => <li key={index}>{item}</li>)}</ul> : null}</div> : null}
      {details?.explanation ? <p className="team-result-card__note">{details.explanation}</p> : !details && scope.runReference === latest ? <p className="team-result-card__note">正在读取结果…</p> : null}
      <footer><span>回复这条对话，助手会在这里接着处理。</span>{onOpenDetails ? <button type="button" className="button" onClick={onOpenDetails}>执行详情<ArrowUpRight size={13} aria-hidden="true" /></button> : null}</footer>
    </section>
  })}</div>
}
