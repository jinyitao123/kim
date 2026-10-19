import type { EnterpriseHumanTask, EnterpriseWorkItem } from '../../../src/types/api'

// Parsers for server projections behind "我的工作". They validate shape;
// the servers own the meaning of current input, business result, and approvals.

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

export interface WorkbenchRunLookup {
  runId: string
  inputRevisionID: string
  workbenchSessionID: string
  status: string
  isCurrent: boolean
  businessResult?: 'completed' | 'needs_input' | 'action_failed' | 'action_unknown'
  actionCounts?: { succeeded: number; failed: number; unknown: number }
}

export interface WorkbenchRunLookupResponse {
  runs: WorkbenchRunLookup[]
  missing: string[]
}

export interface ApprovalWorkItem {
  requestId: string
  mode: 'approval' | 'revision' | 'submitted'
  title: string
  updatedAt: string
  processLabel?: string
  stepLabel?: string
  returnReason?: string
  materialLabel?: string
}

export function parseApprovalWorkPage(value: unknown): { items: ApprovalWorkItem[]; nextCursor?: string } {
  const body = record(value)
  const nextCursor = body?.nextCursor
  if (body?.version !== '1' || !Array.isArray(body.items) || body.items.length > 100
    || nextCursor !== undefined && nextCursor !== null && (typeof nextCursor !== 'string' || !nextCursor || nextCursor.length > 8192)) {
    throw new Error('Forge 返回了无法识别的审批事项')
  }
  const items = body.items.map((entry): ApprovalWorkItem => {
    const item = record(entry)
    const requestId = text(item?.requestId), mode = item?.mode, title = text(item?.title), updatedAt = text(item?.updatedAt)
    if (!requestId || requestId.length > 128 || requestId.trim() !== requestId || (mode !== 'approval' && mode !== 'revision' && mode !== 'submitted')
      || !title || title.length > 300 || !updatedAt || !Number.isFinite(Date.parse(updatedAt))) throw new Error('Forge 返回了无法识别的审批事项')
    return { requestId, mode, title, updatedAt,
      ...(text(item?.processLabel) ? { processLabel: text(item?.processLabel) } : {}),
      ...(text(item?.stepLabel) ? { stepLabel: text(item?.stepLabel) } : {}),
      ...(text(item?.returnReason) ? { returnReason: text(item?.returnReason) } : {}),
      ...(text(item?.materialLabel) ? { materialLabel: text(item?.materialLabel) } : {}) }
  })
  return { items, ...(typeof nextCursor === 'string' ? { nextCursor } : {}) }
}

export function parseRunLookup(value: unknown): WorkbenchRunLookupResponse {
  const body = record(value)
  if (body?.version !== '1' || !Array.isArray(body.runs) || !Array.isArray(body.missing)) throw new Error('Weave 返回了无法识别的团队运行状态')
  const runs = body.runs.map((entry): WorkbenchRunLookup => {
    const run = record(entry)
    const runId = text(run?.runId), inputRevisionID = text(run?.inputRevisionId), workbenchSessionID = text(run?.workbenchSessionId)
    const status = text(run?.status), businessResult = text(run?.businessResult), counts = record(run?.actionCounts)
    const validBusinessResult = businessResult === undefined || businessResult === 'completed' || businessResult === 'needs_input'
      || businessResult === 'action_failed' || businessResult === 'action_unknown'
    if (!runId || runId.length > 512 || runId.trim() !== runId || !inputRevisionID || inputRevisionID.length > 128 || inputRevisionID.trim() !== inputRevisionID
      || !workbenchSessionID || workbenchSessionID.length > 256 || workbenchSessionID.trim() !== workbenchSessionID
      || !status || !['queued', 'running', 'parked', 'cancel_requested', 'succeeded', 'failed', 'cancelled', 'abandoned'].includes(status)
      || typeof run?.isCurrent !== 'boolean' || !counts || !validBusinessResult
      || Object.keys(counts).some((key) => !['succeeded', 'failed', 'unknown'].includes(key))
      || ['succeeded', 'failed', 'unknown'].some((key) => !Number.isSafeInteger(counts[key]) || (counts[key] as number) < 0)) {
      throw new Error('Weave 返回了无法识别的团队运行状态')
    }
    return { runId, inputRevisionID, workbenchSessionID, status, isCurrent: run.isCurrent,
      actionCounts: { succeeded: counts.succeeded as number, failed: counts.failed as number, unknown: counts.unknown as number },
      ...(businessResult === 'completed' || businessResult === 'needs_input' || businessResult === 'action_failed' || businessResult === 'action_unknown' ? { businessResult } : {}) }
  })
  const missing = body.missing.map((entry) => {
    if (typeof entry !== 'string' || !entry || entry.trim() !== entry || entry.length > 512) throw new Error('Weave 返回了无法识别的团队运行状态')
    return entry
  })
  if (new Set(runs.map((run) => run.runId)).size !== runs.length || new Set(missing).size !== missing.length
    || runs.some((run) => missing.includes(run.runId))) throw new Error('Weave 返回了重复的团队运行状态')
  return { runs, missing }
}

/** A Weave human step named by an inbox message, or undefined when the run now waits on another interaction. */
export function parseWeaveHumanTask(value: unknown, references: { runId: string; interactionId: string; workReference: string; sessionReference: string }): EnterpriseHumanTask | undefined {
  const task = record(value)
  const { runId, interactionId, workReference, sessionReference } = references
  if (text(task?.interaction_id) !== interactionId || text(task?.run_id) !== runId) return undefined
  if (task?.input_revision_id !== workReference || task?.workbench_session_id !== sessionReference) throw new Error('团队人工事项与原工作来源不一致')
  const teamId = text(task?.team_id), workflowId = text(task?.workflow_id)
  const workflowVersion = typeof task?.workflow_version === 'number' && Number.isInteger(task.workflow_version) ? task.workflow_version : undefined
  const title = text(task?.title), instructions = text(task?.instructions), updatedAt = text(task?.updated_at)
  if (!teamId || !workflowId || workflowVersion === undefined || workflowVersion < 1 || !title || !instructions
    || !updatedAt || !Number.isFinite(Date.parse(updatedAt))) throw new Error('团队人工事项格式无效，请刷新工作消息')
  return { interactionId, runId, inputRevisionID: workReference, workbenchSessionID: sessionReference, teamId, workflowId, workflowVersion, title, instructions, updatedAt, source: 'weave', mode: 'human_step',
    ...(text(task?.audience_ref) ? { audience: text(task?.audience_ref) } : {}) }
}

/**
 * Native inbox rows as work items. Weave kinds come only from exact native
 * topics. Other inbox entries stay generic until Forge's trusted source
 * endpoint identifies them.
 */
export function inboxWorkItems(rawNotifications: unknown[]): EnterpriseWorkItem[] {
  return rawNotifications.flatMap((value): EnterpriseWorkItem[] => {
    const notification = record(value), data = record(notification?.data), continuation = record(data?.continuation), material = record(data?.material)
    const id = text(notification?.id), title = text(notification?.title), createdAt = text(notification?.createdAt) ?? text(notification?.created_at)
    if (!id || !title || !createdAt) return []
    const notificationType = text(notification?.type) ?? ''
    const weaveKind = /^weave\.team_run\.(result|failure|revision_required|cancelled|human_review)$/.exec(notificationType)?.[1] as Exclude<EnterpriseWorkItem['kind'], 'notification'> | undefined
    const kind: EnterpriseWorkItem['kind'] = weaveKind ?? 'notification'
    const actionable = kind === 'revision_required' || kind === 'human_review'
    const displayTitle = /[0-9a-f]{8}-[0-9a-f-]{27,}/i.test(title)
      ? kind === 'failure' ? '团队处理失败' : kind === 'revision_required' ? '团队工作需要修改' : kind === 'human_review' ? '团队工作等待处理' : kind === 'notification' ? '工作通知' : kind === 'cancelled' ? '团队工作已取消' : '团队工作已完成'
      : title
    const statusValue = text(data?.status)
    const status: EnterpriseWorkItem['status'] = statusValue === 'pending' || statusValue === 'in_progress' || statusValue === 'completed' || statusValue === 'cancelled'
      ? statusValue : actionable ? 'pending' : 'unknown'
    const returnTarget = text(continuation?.returnTarget)
    const reviewScope = text(continuation?.reviewScope)
    return [{
      id, kind, title: displayTitle, status, actionable, read: notification?.read === true,
      source: weaveKind ? 'weave' : 'forge',
      notificationType, createdAt,
      ...(kind === 'failure'
        ? { summary: '本次团队执行未完成，请打开工作记录核对结果及业务动作回执。' }
        : text(notification?.body) ? { summary: text(notification?.body) } : {}),
      ...(text(data?.instructions) ? { instructions: text(data?.instructions) } : {}),
      ...(text(notification?.actionUrl) ?? text(notification?.action_url) ? { actionUrl: text(notification?.actionUrl) ?? text(notification?.action_url) } : {}),
      ...(text(material?.label) ? { materialLabel: text(material?.label) } : {}),
      ...(text(continuation?.reason) ? { returnReason: text(continuation?.reason) } : {}),
      ...(returnTarget === 'origin_review' || returnTarget === 'team' || returnTarget === 'member' || returnTarget === 'human_step' ? { returnTarget } : {}),
      ...(reviewScope === 'whole_team' || reviewScope === 'affected_members' || reviewScope === 'human_step' ? { reviewScope } : {}),
    }]
  }).filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index)
}
