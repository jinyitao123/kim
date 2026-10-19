import { Bell, CheckCircle2, ChevronRight, CircleAlert, ClipboardCheck, FileText, Info, RefreshCw, Sparkles, TimerReset } from 'lucide-react'
import { WORKBENCH_RUN_CONTINUATION_TYPE } from '@/lib/team-work-continuation'
import { enterprisePendingWorkCount, isPendingEnterpriseWorkItem } from '@/lib/enterprise-work-count'
import { type KeyboardEvent, type ReactNode, useId, useState } from 'react'
import { QuotationApprovalDetails } from '@/components/QuotationApprovalDetails'
import type { EmployeeBusinessRecord, EmployeeBusinessWork } from '@/types/employee-business'
import type { EnterpriseApprovalContextView, EnterpriseHumanTask, EnterpriseRunObservation, EnterpriseWorkChoice, EnterpriseWorkItem, EnterpriseWorkOverview, EnterpriseWorkReadStatus } from '@/types/api'

interface EnterpriseWorkPageProps {
  overview?: EnterpriseWorkOverview
  loading: boolean
  error: string
  onRefresh(): void
  onComplete(task: EnterpriseHumanTask, decision: string, comment: string, actionVersion?: string): Promise<void>
  onInspect(task: EnterpriseHumanTask): Promise<EnterpriseApprovalContextView>
  onAssist(task: EnterpriseHumanTask): Promise<void>
  onContinue(item: EnterpriseWorkItem, context?: EnterpriseApprovalContextView): void | Promise<void>
  onCancel?(run: EnterpriseRunObservation): Promise<void>
  onOpenBusiness?(record: EmployeeBusinessRecord): Promise<void>
}

type WorkTab = 'todo' | 'mine' | 'messages'
type TodoSource = 'approval' | 'team' | 'business'
type Tone = 'prime' | 'neutral' | 'success' | 'warning' | 'danger'
type WorkEntry =
  | { key: string; type: 'task'; task: EnterpriseHumanTask }
  | { key: string; type: 'item'; item: EnterpriseWorkItem }
  | { key: string; type: 'business'; work: EmployeeBusinessWork }
  | { key: string; type: 'submitted'; task: EnterpriseHumanTask }
  | { key: string; type: 'run'; run: EnterpriseRunObservation }
  | { key: string; type: 'message'; item: EnterpriseWorkItem }
interface EntryView { title: string; time: string; meta: string; summary?: string; accent: Tone; unread?: boolean; badges: Array<{ label: string; tone: Tone }> }

const statusCopy = (status: string) => ({ parked: '等待中', queued: '排队中', running: '处理中', cancel_requested: '取消中', success: '已完成', succeeded: '已完成', completed: '已完成', failed: '失败', cancelled: '已取消' })[status] ?? readableName(status, '状态更新中')
const statusTone = (status: string): Tone => ['success', 'succeeded', 'completed'].includes(status) ? 'success' : ['failed', 'cancelled'].includes(status) ? 'danger' : status === 'running' ? 'prime' : 'warning'
const activeRunStatuses = ['queued', 'running', 'parked', 'cancel_requested']
const itemSourceCopy = (item: EnterpriseWorkItem) => item.source === 'weave' ? '团队执行消息' : item.kind === 'notification' ? 'Forge 通知' : 'Forge 业务通知'
const itemActionCopy = (item: EnterpriseWorkItem) => item.kind === 'human_review' ? '团队等待人工处理' : item.kind === 'revision_required' ? '团队需要补充' : 'Forge 业务退回'
const canContinueItem = (item: EnterpriseWorkItem) => item.source === 'forge' && (item.kind === 'result' || item.kind === 'notification') && Boolean(item.notificationType) || item.source === 'weave' && (
  Boolean(item.workReference && item.runReference && item.sessionReference)
  || /^weave\.team_run\.(result|failure|revision_required|cancelled)$/.test(item.notificationType ?? '')
)
const itemSummary = (item: EnterpriseWorkItem) => {
  if (item.source === 'weave') {
    if (item.summary) return `运行消息摘要：${item.summary}`
    if (item.kind === 'human_review') return '团队工作等待员工处理。'
    return item.kind === 'failure' ? '团队运行失败，业务结果需要在 Forge 核对。' : item.kind === 'cancelled' ? '团队运行已取消；Forge 业务状态需单独核对。' : '团队运行已返回结果，业务是否完成需单独核对。'
  }
  if (item.kind === 'notification') return item.summary ?? '打开后核对可信消息来源。'
  return item.summary ?? (item.kind === 'failure' ? '业务处理失败，请打开原事项查看。' : '业务状态有更新，请打开原事项核对。')
}
const assignmentCopy = (work: EmployeeBusinessWork) => `待明确负责人：${work.assignmentReason === 'multiple_eligible_employees' ? '有多位符合条件的员工' : '尚无符合条件的员工'}`
const formatTime = (value?: string) => value ? new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '团队协作记录'
const internalIdentifier = /[0-9a-f]{8}-[0-9a-f-]{27,}/i
const readableName = (value?: string, fallback = '团队协作') => value?.trim() && !internalIdentifier.test(value.trim())
  ? value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (part) => part.toUpperCase())
  : fallback
const runChoice = (run: EnterpriseRunObservation, choices: EnterpriseWorkChoice[]) => choices.find((choice) => (
  Boolean(run.step?.includes(choice.workflowId)) || Boolean(run.agent?.includes(choice.workflowId))
))
const runTitle = (run: EnterpriseRunObservation, choices: EnterpriseWorkChoice[]) => runChoice(run, choices)?.workflowName ?? readableName(run.step || run.agent)
const failureMessage = (failure: unknown, fallback: string) => failure instanceof Error ? failure.message : fallback

const sourceCopy: Record<TodoSource, string> = { approval: '业务审批', team: '团队步骤', business: '业务事项' }
const sourceTone: Record<TodoSource, Tone> = { approval: 'prime', team: 'neutral', business: 'success' }
const isUnassigned = (entry: WorkEntry) => entry.type === 'business' && entry.work.assignment === 'needs_assignment'
const todoSource = (entry: WorkEntry): TodoSource => entry.type === 'task' ? (entry.task.source === 'forge' ? 'approval' : 'team') : entry.type === 'item' && entry.item.source === 'weave' ? 'team' : 'business'

function entryView(entry: WorkEntry, choices: EnterpriseWorkChoice[]): EntryView {
  switch (entry.type) {
    case 'task': {
      const { task } = entry, source = todoSource(entry)
      return { title: task.title, time: formatTime(task.updatedAt), meta: task.source === 'forge' ? '业务审批' : '团队人工步骤', summary: task.instructions, accent: sourceTone[source],
        badges: [{ label: sourceCopy[source], tone: sourceTone[source] }, task.mode === 'revision' ? { label: '需补充', tone: 'warning' } : { label: '待处理', tone: 'warning' }] }
    }
    case 'item': {
      const { item } = entry, source = todoSource(entry)
      return { title: item.title, time: formatTime(item.createdAt), meta: item.source === 'weave' ? itemActionCopy(item) : 'Forge 业务退回', summary: item.returnReason ?? item.instructions ?? item.summary, accent: sourceTone[source],
        badges: [{ label: sourceCopy[source], tone: sourceTone[source] }, { label: item.kind === 'human_review' ? '待处理' : '需补充', tone: 'warning' }] }
    }
    case 'business': {
      const { work } = entry
      const summary = [!work.title.includes(work.record.label) ? work.record.label : '', work.assignment === 'needs_assignment' ? assignmentCopy(work) : ''].filter(Boolean).join(' · ')
      return { title: work.title, time: formatTime(work.updatedAt), meta: '本人业务事项', summary: summary || undefined, accent: 'success',
        badges: [{ label: sourceCopy.business, tone: 'success' }, work.assignment === 'needs_assignment' ? { label: '待明确负责人', tone: 'neutral' } : { label: '待处理', tone: 'warning' }] }
    }
    case 'submitted':
      return { title: entry.task.title, time: formatTime(entry.task.updatedAt), meta: '销售订单审批', summary: entry.task.instructions, accent: 'prime',
        badges: [{ label: '我发起的审批', tone: 'prime' }, { label: '审批中', tone: 'warning' }] }
    case 'run': {
      const choice = runChoice(entry.run, choices)
      return { title: runTitle(entry.run, choices), time: formatTime(entry.run.startedAt), meta: choice?.teamName ?? '团队执行', summary: choice?.teamName, accent: 'neutral',
        badges: [{ label: `团队执行 · ${statusCopy(entry.run.status)}`, tone: statusTone(entry.run.status) }] }
    }
    case 'message':
      return { title: entry.item.title, time: formatTime(entry.item.createdAt), meta: itemSourceCopy(entry.item), summary: itemSummary(entry.item), accent: entry.item.read ? 'neutral' : 'prime', unread: !entry.item.read,
        badges: [{ label: itemSourceCopy(entry.item), tone: 'neutral' }, { label: entry.item.read ? '已读' : '新消息', tone: entry.item.read ? 'neutral' : 'prime' }] }
  }
}

const Badge = ({ label, tone }: { label: string; tone: Tone }) => <span className={`work-badge work-badge--${tone}`}>{label}</span>
const Hint = ({ text }: { text: string }) => text ? <span className="work-hint"><Info size={13}/>{text}</span> : null

function ApprovalContext({ context, pageTitle, frozen }: { context: EnterpriseApprovalContextView; pageTitle: string; frozen?: boolean }) {
  return <section className="work-approval-context">
    <header>{context.title && context.title !== pageTitle ? <h3>{context.title}</h3> : null}<small>{context.step}</small></header>
    {context.fields.length ? <dl>{context.fields.map((field) => <div key={field.label}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}</dl> : null}
    <QuotationApprovalDetails lines={context.quotationLines}/>
    {context.files.map((file) => <details key={file.name} className="work-file">
      <summary><FileText size={15}/><span><strong>{file.name}</strong><small>已核对提交版本</small></span><ChevronRight size={14} className="work-file__chevron"/></summary>
      <pre>{file.content}</pre>
    </details>)}
    {context.originalFiles?.map((file, index) => <details key={`${file.name}:${index}`} className="work-file">
      <summary><FileText size={15}/><span><strong>{file.name}</strong><small>PDF/DOCX 原件 · {file.bytes} 字节 · 已核验 · {file.extraction.status === 'complete' ? '文本提取完整' : file.extraction.status === 'partial' ? '部分内容未提取' : '未提取到可读文本'}</small></span><ChevronRight size={14} className="work-file__chevron"/></summary>
      <pre>{file.extraction.content}</pre>
      {file.extraction.limitations.length ? <small className="work-file__gap">提取结果有内容缺口，请在 Forge 查看完整原件。</small> : null}
    </details>)}
    <p className="work-approval-context__note">此处仅列出本审批已绑定且可读取的{frozen ? '冻结材料' : '文件'}。</p>
  </section>
}

function WorkEmpty({ done, title }: { done?: boolean; title: string }) {
  return <div className="work-empty">
    {done ? <span className="work-empty__icon"><CheckCircle2 size={22}/></span> : null}
    <strong>{title}</strong>
  </div>
}

export function EnterpriseWorkPage({ overview, loading, error, onRefresh, onComplete, onInspect, onAssist, onContinue, onCancel, onOpenBusiness }: EnterpriseWorkPageProps) {
  const [tab, setTab] = useState<WorkTab>('todo')
  const [filter, setFilter] = useState<TodoSource | 'all'>('all')
  const [selectedKeys, setSelectedKeys] = useState<Partial<Record<WorkTab, string>>>({})
  const [comments, setComments] = useState<Record<string, string>>({})
  const [busyTask, setBusyTask] = useState('')
  const [contexts, setContexts] = useState<Record<string, EnterpriseApprovalContextView>>({})
  const [contextErrors, setContextErrors] = useState<Record<string, string>>({})
  const [busyContext, setBusyContext] = useState('')
  const [busyRun, setBusyRun] = useState('')
  const baseId = useId()
  const setContextError = (key: string, message: string) => setContextErrors((current) => ({ ...current, [key]: message }))
  const inspect = (task: EnterpriseHumanTask) => {
    setBusyContext(task.interactionId)
    setContextError(task.interactionId, '')
    void onInspect(task).then((context) => setContexts((current) => ({ ...current, [task.interactionId]: context })))
      .catch((failure) => setContextError(task.interactionId, failureMessage(failure, '材料读取失败')))
      .finally(() => setBusyContext(''))
  }
  const complete = (task: EnterpriseHumanTask, decision: string, actionVersion?: string, fallback?: string) => {
    setBusyTask(task.interactionId)
    const pending = onComplete(task, decision, comments[task.interactionId] ?? '', actionVersion)
    void (fallback ? pending.catch((failure) => setContextError(task.interactionId, failureMessage(failure, fallback))) : pending).finally(() => setBusyTask(''))
  }
  const continueRevision = (task: EnterpriseHumanTask) => {
    setBusyContext(task.interactionId)
    void onInspect(task).then((context) => onContinue({ id: task.interactionId, kind: 'revision_required', title: task.title, instructions: task.instructions, status: 'pending', actionable: true, read: false, source: 'forge', createdAt: task.updatedAt, materialLabel: task.materialLabel, returnReason: context.returnReason }, context))
      .catch((failure) => setContextError(task.interactionId, failureMessage(failure, '材料读取失败')))
      .finally(() => setBusyContext(''))
  }

  const pendingCount = enterprisePendingWorkCount(overview, loading || Boolean(error))
  const choices = overview?.choices ?? []
  const pendingEntries: WorkEntry[] = overview ? [
    ...overview.items.filter(isPendingEnterpriseWorkItem).map((item): WorkEntry => ({ key: `item:${item.id}`, type: 'item', item })),
    ...overview.tasks.map((task): WorkEntry => ({ key: `task:${task.interactionId}`, type: 'task', task })),
    ...(overview.businessWork ?? []).map((work): WorkEntry => ({ key: `business:${work.workKey}`, type: 'business', work })),
  ] : []
  // Unassigned business work is listed after the employee's own work and is not part of the pending total.
  const todoEntries = [...pendingEntries.filter((entry) => !isUnassigned(entry)), ...pendingEntries.filter(isUnassigned)]
  const countedEntries = todoEntries.filter((entry) => !isUnassigned(entry))
  const mineEntries: WorkEntry[] = overview ? [
    ...(overview.submittedApprovals ?? []).map((task): WorkEntry => ({ key: `submitted:${task.interactionId}`, type: 'submitted', task })),
    ...overview.runs.map((run): WorkEntry => ({ key: `run:${run.id}`, type: 'run', run })),
  ] : []
  const messageEntries: WorkEntry[] = overview ? overview.items.filter((item) => !item.actionable).map((item): WorkEntry => ({ key: `message:${item.id}`, type: 'message', item })) : []
  const todoSources = (['approval', 'team', 'business'] as const).filter((source) => todoEntries.some((entry) => todoSource(entry) === source))
  const activeFilter = filter !== 'all' && todoSources.includes(filter) ? filter : 'all'
  const entries = tab === 'todo' ? todoEntries.filter((entry) => activeFilter === 'all' || todoSource(entry) === activeFilter) : tab === 'mine' ? mineEntries : messageEntries
  const selected = entries.find((entry) => entry.key === selectedKeys[tab]) ?? entries[0]
  const select = (key: string) => setSelectedKeys((current) => ({ ...current, [tab]: key }))

  const tabs: Array<{ key: WorkTab; label: string; icon: ReactNode; count?: number }> = [
    { key: 'todo', label: '待我处理', icon: <ClipboardCheck size={14}/>, count: pendingCount },
    { key: 'mine', label: '我发起的工作', icon: <TimerReset size={14}/>, count: overview ? (overview.submittedApprovals?.length ?? 0) + overview.runs.filter((run) => activeRunStatuses.includes(run.status)).length : undefined },
    { key: 'messages', label: '工作消息', icon: <Bell size={14}/>, count: overview ? messageEntries.filter((entry) => entry.type === 'message' && !entry.item.read).length : undefined },
  ]
  const reads: Array<[string, EnterpriseWorkReadStatus | undefined]> = overview ? [
    ['团队人工步骤', overview.reads.weaveTasks], ['业务审批', overview.reads.forgeApprovals], ['工作通知', overview.reads.notifications],
    ['本人业务事项', overview.reads.businessWork], ['工作进度', overview.reads.runs], ['团队目录', overview.reads.teamChoices],
  ] : []
  const failedReads = reads.filter(([, status]) => status?.status === 'failed')
  const truncatedReads = reads.filter(([, status]) => status?.status === 'loaded' && status.truncated).map(([label]) => label)

  const moveSelection = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowDown' || event.key === 'j' ? 1 : event.key === 'ArrowUp' || event.key === 'k' ? -1 : 0
    if (!step || !entries.length) return
    event.preventDefault()
    const index = Math.min(entries.length - 1, Math.max(0, entries.findIndex((entry) => entry.key === selected?.key) + step))
    select(entries[index]!.key)
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]')[index]?.focus()
  }

  const renderTaskDetail = (task: EnterpriseHumanTask) => {
    const key = task.interactionId, context = contexts[key], comment = comments[key] ?? '', reading = busyContext === key
    const commentBox = <textarea className="work-input-surface" rows={3} placeholder={task.source === 'forge' ? '填写本次办理意见' : '补充处理意见（可选）'} value={comment}
      onChange={(event) => setComments((current) => ({ ...current, [key]: event.target.value }))}/>
    let hint = '', actions: ReactNode
    if (task.mode === 'revision') {
      actions = <button type="button" className="button button--primary" disabled={reading} onClick={() => continueRevision(task)}>交给助手继续</button>
    } else if (task.source === 'forge') {
      hint = !context ? '查看材料后可办理' : !context.actionVersion ? '当前材料版本不可办理，请重新读取材料' : !comment.trim() ? '填写办理意见后可提交' : ''
      actions = context?.actions?.map((action) => <button key={action.actionRef} type="button" className={action.semantic === 'approve' ? 'button button--primary' : 'button'}
        disabled={busyTask === key || !context.actionVersion || !comment.trim()} onClick={() => complete(task, action.actionRef, context.actionVersion, '审批办理结果待核对')}>{action.label}</button>)
    } else {
      actions = <>
        <button type="button" className="button" disabled={busyTask === key} onClick={() => complete(task, 'rejected')}>退回</button>
        <button type="button" className="button button--primary" disabled={busyTask === key} onClick={() => complete(task, 'approved')}>确认接收</button>
      </>
    }
    return <>
      <div className="work-callout"><h4>需要你做什么</h4><p>{task.instructions}</p>{task.materialLabel ? <small>材料：{task.materialLabel}</small> : null}</div>
      {task.source === 'forge' ? <div className="work-detail__tools">
        <button type="button" className="button" disabled={reading} onClick={() => inspect(task)}>{reading ? '正在读取…' : context ? '重新读取材料' : '查看材料'}</button>
        {context ? <button type="button" className="button" disabled={reading} onClick={() => {
          setBusyContext(key)
          void onAssist(task).catch((failure) => setContextError(key, failureMessage(failure, '无法交给助手核对'))).finally(() => setBusyContext(''))
        }}><Sparkles size={14}/>让助手协助复核</button> : null}
      </div> : null}
      {contextErrors[key] ? <p className="development-inline-error" role="alert">{contextErrors[key]}</p> : null}
      {context ? <ApprovalContext context={context} pageTitle={task.title}/> : null}
      <div className="work-action-bar">
        {task.mode !== 'revision' ? commentBox : null}
        <div className="work-action-bar__row"><Hint text={hint}/>{actions}</div>
      </div>
    </>
  }

  const renderSubmittedDetail = (task: EnterpriseHumanTask) => {
    const key = task.interactionId, context = contexts[key], recall = context?.actions?.find((action) => action.semantic === 'recall'), reason = comments[key] ?? ''
    return <>
      <div className="work-callout"><p>{task.instructions}</p>{task.materialLabel ? <small>材料：{task.materialLabel}</small> : null}</div>
      <div className="work-detail__tools">
        <button type="button" className="button" disabled={busyContext === key} onClick={() => inspect(task)}>{busyContext === key ? '正在读取…' : context ? '重新读取冻结版本' : '查看冻结版本'}</button>
      </div>
      {contextErrors[key] ? <p className="development-inline-error" role="alert">{contextErrors[key]}</p> : null}
      {context ? <ApprovalContext context={context} pageTitle={task.title} frozen/> : null}
      <div className="work-action-bar">
        <textarea className="work-input-surface" rows={2} aria-label="撤回原因" placeholder="填写撤回原因" value={reason} onChange={(event) => setComments((current) => ({ ...current, [key]: event.target.value }))}/>
        <div className="work-action-bar__row">
          <Hint text={!recall ? '查看冻结版本后可撤回' : reason.trim() ? '' : '填写撤回原因后可撤回'}/>
          {recall ? <button type="button" className="button button--danger" disabled={busyTask === key || !context?.actionVersion || !reason.trim()}
            onClick={() => complete(task, recall.actionRef, context?.actionVersion, '审批办理结果待核对')}>{busyTask === key ? '正在核对…' : recall.label}</button> : null}
        </div>
      </div>
    </>
  }

  const renderDetail = (entry: WorkEntry) => {
    switch (entry.type) {
      case 'task': return renderTaskDetail(entry.task)
      case 'submitted': return renderSubmittedDetail(entry.task)
      case 'item': {
        const { item } = entry, openable = canContinueItem(item)
        return <>
          <div className={`work-callout${item.returnReason ? ' work-callout--warning' : ''}`}><h4>{item.returnReason ? '退回 / 需补充原因' : '需要你做什么'}</h4><p>{item.returnReason ?? item.instructions ?? item.summary}</p>{item.materialLabel ? <small>材料：{item.materialLabel}</small> : null}</div>
          <div className="work-action-bar"><div className="work-action-bar__row">
            <Hint text={openable ? '' : '请从本人业务事项或完整的团队消息打开原工作。'}/>
            <button type="button" className="button button--primary" disabled={!openable} onClick={() => { void onContinue(item) }}>交给助手继续</button>
          </div></div>
        </>
      }
      case 'business': {
        const { work } = entry
        return <>
          <div className="work-callout"><h4>业务记录</h4><p>{work.record.label}</p></div>
          {contextErrors[work.workKey] ? <p className="development-inline-error" role="alert">{contextErrors[work.workKey]}</p> : null}
          <div className="work-action-bar"><div className="work-action-bar__row">
            {work.assignment === 'needs_assignment' ? <Hint text={assignmentCopy(work)}/>
              : <button type="button" className="button button--primary" disabled={!onOpenBusiness || busyContext === work.workKey} onClick={() => {
                setBusyContext(work.workKey)
                void onOpenBusiness?.(work.record).catch((failure) => setContextError(work.workKey, failureMessage(failure, '业务事项读取失败'))).finally(() => setBusyContext(''))
              }}>交给助手查看</button>}
          </div></div>
        </>
      }
      case 'run': {
        const { run } = entry, choice = runChoice(run, choices), title = runTitle(run, choices)
        const cancellable = onCancel && activeRunStatuses.includes(run.status)
        return <>
          <dl className="work-facts">
            <div><dt>状态</dt><dd>团队执行 · {statusCopy(run.status)}</dd></div>
            <div><dt>团队</dt><dd>{choice?.teamName ?? '团队协作'}</dd></div>
            <div><dt>发起时间</dt><dd>{formatTime(run.startedAt)}</dd></div>
          </dl>
          {run.status === 'parked' || cancellable ? <div className="work-action-bar"><div className="work-action-bar__row">
            {cancellable ? <button type="button" className="button" disabled={busyRun === run.id} onClick={() => {
              setBusyRun(run.id)
              void (onCancel?.(run) ?? Promise.resolve()).catch(() => undefined).finally(() => setBusyRun(''))
            }}>{busyRun === run.id ? '正在核对…' : run.status === 'cancel_requested' ? '核对取消' : '取消工作'}</button> : null}
            {run.status === 'parked' ? <button type="button" className="button button--primary" onClick={() => onContinue({ id: run.id, source: 'weave', notificationType: WORKBENCH_RUN_CONTINUATION_TYPE, kind: 'result', title, status: 'unknown', actionable: false, read: true, createdAt: run.startedAt ?? overview?.loadedAt ?? '' })}>查看原工作</button> : null}
          </div></div> : null}
        </>
      }
      case 'message': {
        const { item } = entry, openable = canContinueItem(item)
        return <>
          <div className="work-callout"><p>{itemSummary(item)}</p></div>
          <div className="work-action-bar"><div className="work-action-bar__row">
            <Hint text={openable ? '' : '这条消息缺少可信的原工作来源。'}/>
            <button type="button" className="button button--primary" disabled={!openable} onClick={() => onContinue(item)}>{openable ? '交给助手查看' : '原工作暂不可续接'}</button>
          </div></div>
        </>
      }
    }
  }

  const renderEmpty = () => {
    if (tab === 'todo') {
      if (activeFilter !== 'all') return <WorkEmpty title={`没有${sourceCopy[activeFilter]}待办`}/>
      return pendingCount === 0 ? <WorkEmpty done title="当前没有待处理事项。"/> : <WorkEmpty title="暂时无法确认是否还有待办"/>
    }
    if (tab === 'mine') return overview?.reads.runs.status === 'loaded' ? <WorkEmpty title="你还没有通过 Workbench 发起工作。"/> : <WorkEmpty title="工作进度暂时无法读取。"/>
    return <WorkEmpty title="暂无工作消息。"/>
  }

  const renderList = () => {
    if (!overview) return loading
      ? <div className="work-list" aria-busy="true" aria-label="正在读取待办…">{[0, 1, 2].map((index) => <div key={index} className="work-skeleton"><span/><span/><span/></div>)}</div>
      : <WorkEmpty title="待办暂时无法读取。"/>
    if (!entries.length) return renderEmpty()
    const groups = tab === 'mine'
      ? [{ label: '我发起的审批', items: entries.filter((entry) => entry.type === 'submitted') }, { label: '团队执行', items: entries.filter((entry) => entry.type === 'run') }].filter((group) => group.items.length)
      : tab === 'todo' ? [{ label: '', items: entries.filter((entry) => !isUnassigned(entry)) }, { label: '待明确负责人', items: entries.filter(isUnassigned) }].filter((group) => group.items.length)
      : [{ label: '', items: entries }]
    return <div className="work-list" role="listbox" tabIndex={-1} aria-label={tabs.find((item) => item.key === tab)?.label} onKeyDown={moveSelection}>
      {groups.map((group) => [
        group.label ? <div key={`label:${group.label}`} className="work-list__group" role="presentation">{group.label}<span>{group.items.length}</span></div> : null,
        ...group.items.map((entry) => {
          const view = entryView(entry, choices), active = entry.key === selected?.key
          return <button key={entry.key} type="button" role="option" aria-selected={active} tabIndex={active ? 0 : -1}
            className={`work-card work-card--${view.accent}${active ? ' is-selected' : ''}${view.unread ? ' is-unread' : ''}`} onClick={() => select(entry.key)}>
            <span className="work-card__top"><strong>{view.title}</strong><small>{view.time}</small></span>
            {view.summary ? <span className="work-card__summary">{view.summary}</span> : null}
            <span className="work-card__badges">{view.badges.map((badge) => <Badge key={badge.label} {...badge}/>)}</span>
          </button>
        }),
      ])}
    </div>
  }

  const selectedView = selected ? entryView(selected, choices) : undefined
  return <div className="page scroll-area"><div className="page-container enterprise-work-page">
    <header className="work-header">
      <div><h1>我的工作</h1>{overview ? <small>{loading ? '正在更新…' : `更新于 ${formatTime(overview.loadedAt)}`}</small> : null}</div>
      <button type="button" className="icon-button" aria-label="刷新工作" title="刷新工作" onClick={onRefresh}><RefreshCw size={14} className={loading ? 'spin' : ''}/></button>
    </header>
    <div className="work-tabs-row">
      <div className="work-tabs" role="tablist" aria-label="工作分类">
        {tabs.map((item) => <button key={item.key} type="button" role="tab" id={`${baseId}-tab-${item.key}`} aria-controls={`${baseId}-panel`} aria-selected={tab === item.key}
          className={`work-tab${tab === item.key ? ' is-active' : ''}`} onClick={() => setTab(item.key)}>
          {item.icon}<span className="work-tab__label">{item.label}</span>{item.count !== undefined ? <span className="work-tab__count">{item.count}</span> : null}
        </button>)}
      </div>
      {tab === 'todo' && todoSources.length > 1 ? <div className="work-filters" role="group" aria-label="按来源筛选">
        {(['all', ...todoSources] as const).map((source) => <button key={source} type="button" aria-pressed={activeFilter === source} className={activeFilter === source ? 'is-active' : ''} onClick={() => setFilter(source)}>
          {source === 'all' ? '全部' : sourceCopy[source]}<span>{source === 'all' ? countedEntries.length : countedEntries.filter((entry) => todoSource(entry) === source).length}</span>
        </button>)}
      </div> : null}
    </div>
    {error ? <div className="development-inline-error" role="alert">{error}</div> : null}
    {failedReads.length ? <div className="work-banner" role="alert">
      <CircleAlert size={15}/>
      <div>{failedReads.map(([label, status]) => <p key={label}>{label}暂时不可用：{status?.error ?? '服务暂时不可用'}</p>)}</div>
      <button type="button" className="button button--compact" onClick={onRefresh}>重试读取</button>
    </div> : null}
    {truncatedReads.length ? <p className="work-read-note" role="status">{truncatedReads.join('、')}较多，当前只显示最近一部分。</p> : null}
    <div className={`work-split${selected ? '' : ' work-split--single'}`} role="tabpanel" id={`${baseId}-panel`} aria-labelledby={`${baseId}-tab-${tab}`}>
      <div className="work-split__list scroll-area">{renderList()}</div>
      {selected && selectedView ? <section className="work-split__detail scroll-area" aria-label="事项详情">
        <div className="work-detail" key={selected.key}>
          <div className="work-detail__badges">{selectedView.badges.map((badge) => <Badge key={badge.label} {...badge}/>)}</div>
          <h2>{selectedView.title}</h2>
          <p className="work-detail__meta">{selectedView.meta} · {selectedView.time}</p>
          {renderDetail(selected)}
        </div>
      </section> : null}
    </div>
  </div></div>
}
