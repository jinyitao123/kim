import { projectWorkActionFact, workActionTitle, workActionReceiptMeaning } from '@/lib/work-action-outcomes'
import { useState } from 'react'
import { ArrowUpRight, Check, ChevronDown, CircleAlert, Clock3, Layers3, Pause, Square } from 'lucide-react'
import type { EnterpriseTaskScopeDisplay, EnterpriseWorkCancellationResult, MessagePart, TranscriptMessage } from '@/types/api'
import type { EnterpriseRunView } from '@/hooks/useEnterpriseRunStates'
import { enterpriseRunDisplay } from './enterprise-run-display'
import { RunExecutionDetails, RunExecutionTime, RunMaterials } from './RunExecutionDetails'

const hostTools = new Set(['gooeypi_enterprise_work_submit', 'gooeypi_enterprise_work_recover'])
const internalID = /[0-9a-f]{8}-[0-9a-f-]{27,}|^forge:action:/i
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const label = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= 300 && !internalID.test(value)

function scopeReceipt(part: MessagePart, toolName?: string): EnterpriseTaskScopeDisplay | undefined {
  if (!part || part.type !== 'toolResult' || part.isError || part.streaming || typeof part.text !== 'string'
    || !hostTools.has(toolName ?? part.name ?? '') || part.text.length > 200_000) return undefined
  try {
    const result = record(JSON.parse(part.text)), scope = record(result?.scope_display), receipt = record(result?.receipt)
    if (result?.status !== 'accepted' || scope?.version !== '1' || scope.source !== 'workbench-host'
      || typeof scope.runReference !== 'string' || !scope.runReference || scope.runReference.length > 128
      || receipt?.runId !== scope.runReference || !label(scope.team) || !label(scope.workflow)
      || !Array.isArray(scope.reads) || scope.reads.length < 1 || scope.reads.length > 128 || !scope.reads.every(label)
      || !Array.isArray(scope.writes) || scope.writes.length > 32 || !scope.writes.every(label)) return undefined
    return scope as unknown as EnterpriseTaskScopeDisplay
  } catch { return undefined }
}

/** Only native Host tool receipts become cards; narrative JSON cannot create an authorization display. */
export function enterpriseScopeProjection(message: TranscriptMessage): { message: TranscriptMessage; scopes: EnterpriseTaskScopeDisplay[] } {
  if (!Array.isArray(message.parts)) return { message, scopes: [] }
  const scopes = new Map<string, EnterpriseTaskScopeDisplay>(), hidden = new Set<number>()
  message.parts.forEach((part, index) => {
    const previous = message.parts[index - 1]
    const scope = scopeReceipt(part, previous?.type === 'toolCall' ? previous.name : undefined)
    if (!scope) return
    scopes.set(scope.runReference, scope); hidden.add(index)
    if (previous?.type === 'toolCall' && hostTools.has(previous.name)) hidden.add(index - 1)
  })
  return { message: hidden.size ? { ...message, parts: message.parts.filter((_part, index) => !hidden.has(index)) } : message, scopes: [...scopes.values()] }
}

export function EnterpriseScopeCards({ scopes, states = {}, onCancelWork, onRefresh, expandedRun, onSelectRun, onOpenWork }: {
  scopes: EnterpriseTaskScopeDisplay[]
  states?: Record<string, EnterpriseRunView>
  onCancelWork?(runId: string): Promise<EnterpriseWorkCancellationResult>
  onRefresh?(): void
  expandedRun?: string
  onSelectRun?(id: string): void
  onOpenWork?(): void
}) {
  const [busy, setBusy] = useState('')
  const [results, setResults] = useState<Record<string, EnterpriseWorkCancellationResult>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  if (!scopes.length) return null
  return <div className="enterprise-scope-cards">{scopes.map((scope) => {
    const result = results[scope.runReference]
    const view = states[scope.runReference]
    const display = enterpriseRunDisplay(view, result)
    const expanded = !onSelectRun || expandedRun === scope.runReference
    const details = view?.details?.status === view?.run?.status && !view?.detailStale ? view?.details : undefined
    const firstIssue = details?.actionOutcomes?.find((item) => item.status !== 'succeeded')
    const issue = firstIssue ? projectWorkActionFact(firstIssue) : undefined
    const Icon = display.state === 'succeeded' ? Check : ['failed', 'unavailable'].includes(display.state) ? CircleAlert : ['parked', 'needs_input'].includes(display.state) ? Pause : ['cancelled', 'abandoned', 'ended'].includes(display.state) ? Square : display.state === 'queued' ? Clock3 : Layers3
    return <section className={`enterprise-scope-card is-${display.state}${display.animate ? ' is-animating' : ''}${expanded ? ' is-expanded' : ' is-collapsed'}`} aria-label="本次团队授权" key={scope.runReference}>
      <div className="enterprise-scope-light" aria-hidden="true" />
      <header><div className="enterprise-scope-heading"><span className="enterprise-scope-emblem" aria-hidden="true"><Icon size={18} strokeWidth={1.7} /></span><div><strong>{scope.team}</strong><span className="enterprise-scope-workflow">{scope.workflow}</span></div></div><span className="enterprise-scope-status" role="status" aria-live="polite" aria-atomic="true"><i aria-hidden="true" />{display.label}</span></header>
      {issue && !expanded ? <p className="enterprise-scope-detail"><strong>{workActionTitle(issue)}</strong> · {issue.summary} {workActionReceiptMeaning(issue.status)}</p> : null}
      {!expanded ? <button type="button" className="enterprise-expand" onClick={() => onSelectRun?.(scope.runReference)}>查看执行详情<ChevronDown size={13} aria-hidden="true" /></button> : <>
      <RunExecutionTime details={details} />
      <div className="enterprise-scope-track" aria-hidden="true"><span /></div>
      <RunExecutionDetails view={view} />
      <RunMaterials scope={scope} details={details} />
      <footer>{display.detail ? <p className="enterprise-scope-detail">{display.detail}</p> : <span />}
      <div className="enterprise-scope-actions">{onOpenWork ? <button type="button" className="button enterprise-work-action" onClick={onOpenWork}>查看我的工作<ArrowUpRight size={13} aria-hidden="true" /></button> : null}
      {onCancelWork && !display.ended ? <button type="button" className="button enterprise-scope-cancel" disabled={busy === scope.runReference} onClick={() => {
        setBusy(scope.runReference); setErrors((current) => ({ ...current, [scope.runReference]: '' }))
        void onCancelWork(scope.runReference).then((value) => setResults((current) => ({ ...current, [scope.runReference]: value })))
          .catch(() => setErrors((current) => ({ ...current, [scope.runReference]: '取消结果待核对，请重试核对' })))
          .finally(() => { setBusy(''); onRefresh?.() })
      }}>{busy === scope.runReference ? '正在核对…' : result ? '核对取消' : '取消工作'}</button> : null}</div></footer>
      </>}
      {result && (!display.ended || result.status === 'completed' || result.status === 'cancelled') ? <p role="status">{result.message}</p> : null}
      {errors[scope.runReference] ? <p role="alert">{errors[scope.runReference]}</p> : null}
    </section>
  })}</div>
}
