import { projectWorkActionFact } from '../../../src/lib/work-action-outcomes'
import type { EnterpriseWorkRunDetails } from '../../../src/types/api'
import type { WorkbenchRunLookup } from './work-sources'
import { parseWorkContinuationContext } from './work-continuation'

const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
// Public cards receive prose/names only. Runtime configuration, IDs, paths,
// tool inputs/outputs, and raw failure strings never leave this projection.
const internal = /[0-9a-f]{8}-[0-9a-f-]{27,}|\b[0-9a-f]{24,}\b|https?:\/\/|(?:^|[\s("'（：:])(?:\/[\w.-]+(?:\/|$)|[a-z]:\\)|\/(?:Users|home|tmp|private|var|etc|opt|Volumes|mnt|root|srv)\/|(?:^|[\s("'（：:])(?:\.{1,2}\/)?[\w.-]+\/[\w./-]+\.[a-z0-9]{1,8}\b|\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b|\$\./i
function prose(value: unknown, max = 500): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= max && !internal.test(value) && !value.includes('\\') && !Array.from(value).some((char) => char.charCodeAt(0) < 32 && ![9, 10, 13].includes(char.charCodeAt(0))) ? value.trim() : undefined
}
function readableSummary(value: string | undefined): { text: string; excerpt: boolean } | undefined {
  if (!value) return undefined
  if (prose(value, 2000)) return { text: value, excerpt: false }
  // Never remove words or clauses within a sentence. If a rejected sentence
  // limits preceding text, discard that context too; dependent follow-ups and
  // forward-scoped conditions cannot become standalone business conclusions.
  const dependent = /^(?:[\s“"'（(]*)(?:因此|所以|故|这|该|上述|以上|对此|其|即|否则|但|然而|不过|同时|而且|由此|thus\b|therefore\b|this\b|it\b|these\b|however\b|but\b)/i
  const limitation = /不|未|无|仅|只|除非|否则|前提|限制|条件|须|需要|仍|待核|\b(?:not|only|unless|except|however|pending|rejected|cancelled)\b/i
  const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'sentence' })
  const retained: string[] = []
  let gap = false, blocked = false
  for (const paragraph of value.split(/\n\s*\n/)) {
    if (blocked) break
    const sentences: string[] = []
    for (const { segment } of segmenter.segment(paragraph)) {
      const sentence = segment.trim()
      if (!sentence) continue
      if (!prose(sentence, 2000)) {
        sentences.length = 0
        if (limitation.test(sentence) || dependent.test(sentence)) retained.length = 0
        gap = true
        if (/以下|下列|如下|下文|后文|\bthe following\b/i.test(sentence)) { blocked = true; break }
        continue
      }
      if (gap && dependent.test(sentence) || /[：:]$/.test(sentence)) continue
      sentences.push(sentence)
      gap = false
    }
    if (sentences.length) retained.push(sentences.join(''))
  }
  const text = retained.join('\n\n')
  return prose(text, 2000) ? { text, excerpt: true } : undefined
}
function filename(value: string): string | undefined {
  return value.trim() && value.length <= 255 && !value.includes('/') && !value.includes('\\')
    && !/[0-9a-f]{8}-[0-9a-f-]{27,}|\b[0-9a-f]{24,}\b/i.test(value)
    && !Array.from(value).some((char) => char.charCodeAt(0) < 32) ? value : undefined
}
function time(value: unknown): string | undefined { return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined }
const statuses = new Set(['pending', 'queued', 'running', 'waiting', 'parked', 'completed', 'succeeded', 'failed', 'cancelled', 'stopped', 'not_recorded', 'partially_completed', 'skipped'])
const state = (value: unknown): string => typeof value === 'string' && statuses.has(value) ? value : 'not_recorded'

export function workRunDetails(owned: WorkbenchRunLookup, rawActivity: unknown, rawContext: unknown): EnterpriseWorkRunDetails {
  const activity = record(rawActivity), context = parseWorkContinuationContext(rawContext)
  if (activity?.run_id !== owned.runId || context.source.runID !== owned.runId
    || context.source.inputRevisionID !== owned.inputRevisionID || context.source.workbenchSessionID !== owned.workbenchSessionID
    || activity.status !== context.run.status || owned.status !== context.run.status) throw new Error('执行详情正在更新，请稍后核对')
  const completeness = record(activity.completeness)
  const rawMembers = Array.isArray(activity.members) ? activity.members : []
  const failureKinds: string[] = []
  let incomplete = !Array.isArray(activity.members) || rawMembers.length > 32
  const members = rawMembers.slice(0, 32).flatMap((value, index): EnterpriseWorkRunDetails['members'] => {
    const member = record(value)
    if (!member) { incomplete = true; return [] }
    const rawStages = Array.isArray(member.stages) ? member.stages : []
    if (!Array.isArray(member.stages) || rawStages.length > 24) incomplete = true
    const stages = rawStages.slice(0, 24).flatMap((value, stageIndex) => {
      const stage = record(value)
      if (!stage) { incomplete = true; return [] }
      if (stage.status === 'failed' && typeof stage.failure_class === 'string') failureKinds.push(stage.failure_class)
      return [{ name: prose(stage.name, 200) ?? `执行步骤 ${stageIndex + 1}`, status: state(stage.status),
        ...(typeof stage.duration_ms === 'number' && Number.isFinite(stage.duration_ms) && stage.duration_ms >= 0 ? { durationMs: stage.duration_ms } : {}) }]
    })
    return [{ name: prose(member.name, 200) ?? `团队成员 ${index + 1}`, status: state(member.status), stages }]
  })
  const actionOutcomes = context.run.actionOutcomes?.map(projectWorkActionFact)
  const final = context.run.finalResult
  const summary = readableSummary(final?.summary)
  // Every missing item is listed. One too long for this panel shows its
  // opening; one that cannot be shown at all is left out. Either way the panel
  // says it shows only part and where the whole result is.
  let missingExcerpt = false
  const missingItems = (final?.missingItems ?? []).flatMap((item) => {
    const whole = prose(item, 2000)
    if (whole) return [whole]
    missingExcerpt = true
    const opening = Array.from(item).length > 2000 ? prose(Array.from(item).slice(0, 2000).join(''), 2000) : undefined
    return opening ? [`${opening}…`] : []
  })
  // Expired grants can remain on terminal runs. Only the current parked input
  // with server-confirmed renewal eligibility can actually continue this run.
  const authorizationRequired = owned.isCurrent && context.run.status === 'parked' && context.source.inputStatus === 'current'
    && context.run.authorization?.status === 'renewal_required' && context.run.authorization.canRenew === true
  let explanation = ''
  if (authorizationRequired) explanation = '继续执行需要更新本次工作的授权，请从“我的工作”核对后办理。'
  else if (context.run.businessResult === 'action_failed') explanation = '业务动作未成功，正式业务状态仍需在业务系统中核对。'
  else if (context.run.businessResult === 'action_unknown') explanation = '业务动作的回执尚未确认，请先核对原工作，避免重复提交。'
  else if (context.run.status === 'failed') {
    explanation = failureKinds.includes('configuration') ? '流程配置未通过检查，执行未能继续。请联系团队维护人员检查配置。'
      : failureKinds.some((kind) => ['verification', 'validation', 'schema'].includes(kind)) ? '步骤结果未通过要求，尚未形成有效结论。请查看工作记录后安排后续处理。'
      : failureKinds.includes('infrastructure') ? '执行服务暂时无法完成处理。请从“我的工作”查看记录后安排后续处理。'
        : '本次团队执行未完成，尚未形成有效结论。请查看工作记录，核对原因后再安排后续处理。'
  } else if (context.run.status === 'cancelled') explanation = '本次团队执行已停止。已发生的业务动作仍以业务系统中的记录为准。'
  else if (context.run.status === 'succeeded' && context.run.businessResult !== 'needs_input') explanation = '团队执行已完成；正式业务结果以业务系统中的记录为准。'
  else if (context.run.businessResult === 'needs_input') explanation = '本次检查需要补充材料或说明，补齐后可从原工作继续。'
  else if (context.run.status === 'parked') explanation = '团队工作当前处于等待状态，等待原因尚未核对。'
  if (summary?.excerpt || missingExcerpt) explanation += `${explanation ? ' ' : ''}这里只展示部分检查意见；完整结果请从“我的工作”的原工作消息查看。`
  return {
    runId: owned.runId, status: context.run.status,
    acceptedAt: time(activity.created_at), finishedAt: time(activity.finished_at), observedAt: time(activity.observed_at),
    members, activityComplete: !incomplete && completeness?.members === 'complete' && completeness?.activity_events === 'complete',
    materials: context.input.materials.map((item, index) => ({ name: filename(item.name) ?? `材料 ${index + 1}`,
      format: item.mediaType === 'application/pdf' ? 'PDF' : item.mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ? 'DOCX'
        : item.mediaType === 'text/markdown' ? 'MD' : item.mediaType === 'text/csv' ? 'CSV' : item.mediaType === 'application/json' ? 'JSON' : 'TXT', bytes: item.bytes })),
    ...(summary ? { result: { title: summary.excerpt ? '检查意见摘录' : prose(final?.title, 300) ?? '团队结果', summary: summary.text, missingItems } } : {}),
    ...(actionOutcomes !== undefined ? { actionOutcomes } : {}),
    explanation, authorizationRequired, ...(owned.actionCounts ? { actionCounts: owned.actionCounts } : {}),
  }
}
