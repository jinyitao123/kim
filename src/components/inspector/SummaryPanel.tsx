import { memo, useMemo, useState } from 'react'
import { CalendarClock, Check, ChevronDown, HeartPulse, LoaderCircle } from 'lucide-react'
import type { AutomationScheduleRecord, GitStatus, NativeHeartbeatRecord, ProjectRecord, RuntimeInfo, TranscriptMessage } from '@/types/api'
import { useEnterpriseRunStates } from '@/hooks/useEnterpriseRunStates'
import { EnterpriseScopeCards, enterpriseScopeProjection } from '../transcript/EnterpriseScopeCards'
import type { EnterpriseWorkCancellationResult, EnterpriseWorkRunDetails, EnterpriseWorkRunStates } from '@/types/api'
import { MarkdownText } from '../MarkdownText'
import { formatRelative } from '@/lib/data'
import { projectMaterialDisplayMessages } from '@/lib/workspace-material-display'

export interface EnterpriseSummaryWork {
  accountScope: string
  sessionKey: string
  read(runIds: string[]): Promise<EnterpriseWorkRunStates>
  cancel(runId: string): Promise<EnterpriseWorkCancellationResult>
  readDetails?(runId: string): Promise<EnterpriseWorkRunDetails>
  openWork?(): void
}

interface SummaryPanelProps {
  teamWork?: EnterpriseSummaryWork
  /** Active harness agent name. */
  agentName?: string
  /** Short harness name for working copy. */
  shortName?: string
  project?: ProjectRecord
  runtime?: RuntimeInfo | null
  messages: TranscriptMessage[]
  git: GitStatus
  automations: AutomationScheduleRecord[]
  heartbeats: NativeHeartbeatRecord[]
  onOpenAutomation(id: string): void
}

export interface TranscriptSummary {
  toolCount: number
  lastText?: string
}

/** One pass for the tool count; one reverse walk that stops at the first text part. */
export function summarizeTranscript(messages: TranscriptMessage[]): TranscriptSummary {
  messages = projectMaterialDisplayMessages(messages)
  let toolCount = 0
  for (const message of messages) {
    for (const part of message.parts) if (part.type === 'toolCall') toolCount += 1
  }
  let lastText: string | undefined
  for (let index = messages.length - 1; index >= 0 && lastText === undefined; index -= 1) {
    const parts = messages[index].parts
    for (let cursor = parts.length - 1; cursor >= 0; cursor -= 1) {
      const part = parts[cursor]
      if (part.type === 'text') {
        lastText = part.text
        break
      }
    }
  }
  return { toolCount, lastText }
}

export const SummaryPanel = memo(function SummaryPanel({ shortName = 'Prime', runtime, messages, teamWork, automations, heartbeats, onOpenAutomation }: SummaryPanelProps) {
  const { lastText } = useMemo(() => summarizeTranscript(messages), [messages])
  const scopes = useMemo(() => [...new Map(messages.flatMap((message) => enterpriseScopeProjection(message).scopes).map((scope) => [scope.runReference, scope])).values()], [messages])
  const [selectedRun, setSelectedRun] = useState<string>()
  const expandedRun = selectedRun && scopes.some((scope) => scope.runReference === selectedRun) ? selectedRun : scopes.at(-1)?.runReference
  const runStates = useEnterpriseRunStates(scopes.map((scope) => scope.runReference), teamWork?.accountScope, teamWork?.read, expandedRun, teamWork?.readDetails)
  const active = Boolean(runtime?.isStreaming || runtime?.isCompacting)
  const conversationSummary = <section className="summary-hero">
    <span className={`run-state ${active ? 'is-running' : ''}`}>{active ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}{active ? `${shortName} 正在处理` : '已就绪'}</span>
    {!scopes.length ? <h2>工作摘要</h2> : null}
    <MarkdownText text={lastText !== undefined ? lastText.slice(0, 220) : '暂无工作摘要'} />
  </section>
  return (
    <div className="inspector-scroll scroll-area summary-panel">
      <EnterpriseScopeCards scopes={[...scopes].reverse()} states={runStates.views} onCancelWork={teamWork?.cancel} onRefresh={runStates.refresh} expandedRun={expandedRun} onSelectRun={setSelectedRun} onOpenWork={teamWork?.openWork} />
      {scopes.length ? <details className="summary-conversation"><summary>会话摘要<ChevronDown size={13} aria-hidden="true" /></summary>{conversationSummary}</details> : conversationSummary}
      {automations.length || heartbeats.length ? <section className="summary-section"><h3>定时任务</h3><div className="summary-automation-list">
        {automations.slice(0, 2).map((task) => <button type="button" key={task.id} onClick={() => onOpenAutomation(task.id)}>
          <span className="summary-automation-icon"><CalendarClock size={14}/></span><span><strong>{task.title}</strong><small>{task.status}{task.nextRunAt ? ` · 下次 ${formatRelative(task.nextRunAt)}` : ''}</small></span>
        </button>)}
        {heartbeats.slice(0, Math.max(0, 2 - automations.length)).map((heartbeat) => <button type="button" key={heartbeat.id} onClick={() => onOpenAutomation(heartbeat.id)}>
          <span className="summary-automation-icon is-heartbeat"><HeartPulse size={14}/></span><span><strong>{heartbeat.label ?? (heartbeat.source === 'heartbeat' ? '对话心跳' : '智能体心跳')}</strong><small>{heartbeat.status}{heartbeat.nextRunAt ? ` · 下次 ${formatRelative(heartbeat.nextRunAt)}` : ''}</small></span>
        </button>)}
        {automations.length + heartbeats.length > 2 ? <button type="button" className="summary-automation-more" onClick={() => onOpenAutomation(automations[0]?.id ?? heartbeats[0]!.id)}>查看全部 {automations.length + heartbeats.length} 个定时任务</button> : null}
      </div></section> : null}
    </div>
  )
})
