import type { EnterpriseApprovalAction, EnterpriseApprovalContext } from '../../../src/types/api'
import { rejectUnknownKeys, requireString } from '../validation'
import type { CapabilityClaim } from '../lib/capability-bridge'
import type { EnterpriseService, NativeMcpActionArguments, NativeMcpActionAttempt } from '../enterprise'
import { parseCurrentItemActionObservation, parseCurrentItemActionReceipt } from './approval-actions'
import { APPROVAL_REVIEW_SESSION_MARKER } from '../../../src/lib/approval-review'
import { digest } from './handoff-store'
import { currentItemContextFingerprint } from './approval-context-binding'

export interface CurrentItemActionTurn {
  key: string
  prompt: string
  accountKey: string
  approvalContext?: CurrentItemActionBinding
  messageId?: string
  enterpriseReadOnly?: boolean
  pendingSessionPrompts?: string[]
}

export interface BoundCurrentItemAction {
  action: EnterpriseApprovalAction
  accountKey: string
  requestId: string
  sessionPath: string
  turnKey: string
  messageId: string
  contextFingerprint: string
  baselineHistoryIds: string[]
}

export interface CurrentItemActionAttempt {
  status: NativeMcpActionAttempt['status']
  actionFingerprint: string
  commentDigest: string
  nativeObservation?: ReturnType<typeof parseCurrentItemActionObservation>
  code?: string
  result?: unknown
  message?: string
  baselineHistoryIds: string[]
}

export interface CurrentItemActionBinding {
  purpose: 'review' | 'revision'
  accountKey: string
  sessionPath: string
  fingerprint: string
  context: EnterpriseApprovalContext
}

export interface CurrentItemActionRuntime {
  service: Pick<EnterpriseService, 'accountKey' | 'getSession' | 'getApprovalContext' | 'getApprovalActionHistory' | 'runNativeMcpAction'>
  claim: CapabilityClaim
  turn: CurrentItemActionTurn
  bound: CurrentItemActionBinding
  refs: Map<string, BoundCurrentItemAction>
  attempts: Map<string, CurrentItemActionAttempt>
  contextChanged: boolean
  getCurrentContext(): Promise<EnterpriseApprovalContext>
  assertCurrent(reference?: BoundCurrentItemAction): Promise<void>
}

export interface CurrentItemActionRuntimeSource extends Omit<CurrentItemActionRuntime, 'assertCurrent' | 'getCurrentContext'> {
  getCurrentTurn(): CurrentItemActionTurn | undefined
  getCurrentBinding(): CurrentItemActionBinding | undefined
}

export interface CurrentItemActionDispatchSource extends Omit<CurrentItemActionRuntimeSource, 'refs' | 'attempts' | 'bound' | 'getCurrentTurn' | 'getCurrentBinding'> {
  references: Map<string, Map<string, BoundCurrentItemAction>>
  attempts: Map<string, Map<string, CurrentItemActionAttempt>>
  turns: ReadonlyMap<string, CurrentItemActionTurn>
  bindings: ReadonlyMap<string, CurrentItemActionBinding>
}

interface ApprovalHistoryRow {
  id: string
  requestId: string
  action: string
  actorId: string
  comment: string
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && value.trim() === value && !value.includes('\0') ? value : undefined
}

function approvalHistoryRow(value: unknown): ApprovalHistoryRow | undefined {
  const row = objectRecord(value)
  const id = boundedText(row?.id, 128), requestId = boundedText(row?.request_id, 128)
  const action = boundedText(row?.action, 128), actorId = boundedText(row?.actor_id, 128)
  const comment = typeof row?.comment === 'string' ? row.comment : undefined
  return id && requestId && action && actorId && comment !== undefined ? { id, requestId, action, actorId, comment } : undefined
}

function approvalHistoryId(value: unknown): string | undefined {
  return boundedText(objectRecord(value)?.id, 128)
}


export function createCurrentItemActionRuntime(source: CurrentItemActionRuntimeSource, access: 'review-action' | 'read-directory' = 'review-action'): CurrentItemActionRuntime {
  const returnedDirectory = access === 'read-directory' && source.bound.purpose === 'revision'
  if (!returnedDirectory && (source.bound.purpose !== 'review' || source.turn.enterpriseReadOnly !== true)
    || !source.claim.sessionPath || source.bound.sessionPath !== source.claim.sessionPath
    || source.bound.accountKey !== source.turn.accountKey) {
    throw new Error('请从本人“我的工作”重新打开当前审批事项')
  }
  return {
    ...source,
    getCurrentContext: async () => {
      const current = await source.service.getApprovalContext(source.bound.context.requestId)
      if (currentItemContextFingerprint(current) !== source.bound.fingerprint) throw new Error('审批事项或动作目录已变化')
      return current
    },
    assertCurrent: async (reference) => {
      if (source.getCurrentTurn() !== source.turn || source.getCurrentBinding() !== source.bound
        || source.bound.sessionPath !== source.claim.sessionPath || source.bound.accountKey !== source.turn.accountKey
        || reference && (reference.accountKey !== source.turn.accountKey || reference.sessionPath !== source.claim.sessionPath
          || reference.turnKey !== source.turn.key || reference.contextFingerprint !== source.bound.fingerprint
          || reference.messageId !== source.turn.messageId)) {
        throw new Error('员工账号、会话或本轮意见已变化，请重新打开当前事项')
      }
      if (await source.service.accountKey() !== source.turn.accountKey) throw new Error('员工账号已变化，请重新打开当前事项')
    },
  }
}

export async function dispatchCurrentItemAction(
  method: 'list_current_item_actions' | 'run_current_item_action', params: Record<string, unknown>, source: CurrentItemActionDispatchSource,
): Promise<unknown> {
  const bound = source.turn.approvalContext
  if (!bound) throw new Error('请从本人“我的工作”重新打开当前审批事项')
  if (bound.purpose === 'revision' && method === 'run_current_item_action') {
    throw new Error('当前是本人退回修改事项，不能执行审批复核动作；修订递交须使用专用修订工具并取得员工本轮明确要求')
  }
  const refs = source.references.get(source.claim.token) ?? new Map<string, BoundCurrentItemAction>()
  const attempts = source.attempts.get(source.claim.token) ?? new Map<string, CurrentItemActionAttempt>()
  source.references.set(source.claim.token, refs)
  source.attempts.set(source.claim.token, attempts)
  const runtime = createCurrentItemActionRuntime({
    service: source.service, claim: source.claim, turn: source.turn, bound, refs, attempts, contextChanged: source.contextChanged,
    getCurrentTurn: () => source.turns.get(source.claim.token),
    getCurrentBinding: () => source.bindings.get(source.claim.token),
  }, method === 'list_current_item_actions' ? 'read-directory' : 'review-action')
  return method === 'list_current_item_actions'
    ? listCurrentItemActions(params, runtime)
    : runCurrentItemAction(params, runtime)
}

export async function listCurrentItemActions(params: Record<string, unknown>, runtime: CurrentItemActionRuntime) {
  rejectUnknownKeys(params, ['turn_key'], 'current item action directory')
  if (runtime.bound.purpose !== 'revision' && (runtime.bound.purpose !== 'review' || runtime.turn.enterpriseReadOnly !== true)
    || !runtime.claim.sessionPath || runtime.bound.sessionPath !== runtime.claim.sessionPath
    || !runtime.turn.messageId) {
    throw new Error('请从本人“我的工作”重新打开当前审批事项')
  }
  await runtime.assertCurrent()
  const currentContext = await runtime.getCurrentContext()
  const session = await runtime.service.getSession()
  if (session.status !== 'signed-in' || !session.user?.id || await runtime.service.accountKey() !== runtime.turn.accountKey) {
    throw new Error('员工账号已变化，请重新打开当前事项')
  }
  if (runtime.bound.purpose === 'revision') {
    if (currentContext.status !== 'returned' || currentContext.viewer !== 'original_submitter' || !currentContext.returnVersion) {
      throw new Error('当前退回事项已变化，请从本人“我的工作”重新打开')
    }
    await runtime.assertCurrent()
    runtime.refs.clear()
    return {
      actions: [],
      revision_submission: { tool: 'gooeypi_approval_revision_submit', requires_employee_request: true },
      message: '当前会话已绑定本人退回修改事项。打开只授权查看与整理材料；员工在后续消息明确要求递交时，使用专用修订工具沿原事项继续。',
    }
  }
  const history = await runtime.service.getApprovalActionHistory(runtime.bound.context.requestId)
  await runtime.assertCurrent()
  const baselineHistoryIds = history.flatMap((entry) => approvalHistoryId(entry) ?? [])
  const actions = currentContext.availableActions ?? []
  const references = new Map<string, BoundCurrentItemAction>()
  const presented = actions.map((action, index) => {
    const actionRef = String(index + 1)
    references.set(actionRef, {
      action, accountKey: runtime.turn.accountKey, requestId: runtime.bound.context.requestId,
      sessionPath: runtime.claim.sessionPath!, turnKey: runtime.turn.key, messageId: runtime.turn.messageId!,
      contextFingerprint: runtime.bound.fingerprint, baselineHistoryIds,
    })
    return {
      action_ref: actionRef, label: action.label, description: action.description,
      inputs: action.inputs.map(({ label, required }) => ({ label, required })),
    }
  })
  runtime.refs.clear()
  for (const [key, value] of references) runtime.refs.set(key, value)
  return currentContext.availableActions === undefined
    ? { status: 'unavailable', actions: [], message: 'Forge 没有提供当前事项的动作目录。' }
    : presented.length ? { status: 'available', actions: presented }
      : { status: 'none', actions: [], message: 'Forge 当前没有可办理动作。' }
}

async function reconcileCurrentItemAction(
  runtime: CurrentItemActionRuntime, reference: BoundCurrentItemAction, comment: string, attempt: CurrentItemActionAttempt,
): Promise<Record<string, unknown>> {
  let currentContext: EnterpriseApprovalContext | undefined
  try {
    const current = await runtime.service.getApprovalContext(reference.requestId)
    if (current.requestId === reference.requestId) currentContext = current
  } catch { /* Native action history may remain readable after the current item changes state. */ }
  let history: unknown[]
  try { history = await runtime.service.getApprovalActionHistory(reference.requestId) }
  catch {
    return {
      outcome: 'unknown', message: 'Forge 当前事项和动作历史暂时无法核对；没有重发动作。请刷新本人待办后继续。',
    }
  }
  const session = await runtime.service.getSession()
  if (session.status !== 'signed-in' || !session.user?.id
    || await runtime.service.accountKey() !== runtime.turn.accountKey) {
    return { outcome: 'unknown', message: '员工账号已变化，原生动作结果待该员工重新核对；没有重发动作。' }
  }
  const knownIds = new Set(reference.baselineHistoryIds)
  const matched = history.map(approvalHistoryRow).find((row) => row
    && row.requestId === reference.requestId && row.actorId === session.user!.id
    && row.comment === comment && !knownIds.has(row.id))
  const observed = attempt.nativeObservation?.history.find((row) => row.actorId === session.user!.id && row.comment === comment)
  await runtime.assertCurrent(reference)
  if (matched || observed) {
    const currentAction = currentContext?.availableActions?.find((action) => (
      action.execution.actionName === reference.action.execution.actionName
      && action.execution.objectName === reference.action.execution.objectName
      && action.execution.recordId === reference.action.execution.recordId
    ))
    const currentItemVersionMatches = currentAction?.execution.params.itemVersion === reference.action.execution.params.itemVersion
    attempt.status = 'unknown'
    attempt.result = {
      outcome: 'unknown', nativeStatus: 'history_observed', decision: 'unknown',
      nativeAction: matched?.action ?? observed?.action, comment: matched?.comment ?? observed?.comment,
      observedStatus: attempt.nativeObservation?.observedStatus,
      currentItemStatus: currentContext?.status,
      currentItemVersionMatches,
      returnReason: currentContext?.returnReason,
      message: 'Forge 原生动作历史出现了当前员工意见，但没有原生回执确认它对应所选动作；结果仍未知，且没有重发。请核对当前事项状态。',
    }
    return attempt.result as Record<string, unknown>
  }
  return {
    outcome: 'unknown',
    ...(currentContext ? { currentItemStatus: currentContext.status, returnReason: currentContext.returnReason } : {}),
    ...(attempt.code ? { errorCode: attempt.code } : {}),
    message: '已读取 Forge 当前事项和原生动作历史，但没有确认本轮动作结果；没有重发动作。请刷新本人待办后继续。',
  }
}

export async function runCurrentItemAction(
  params: Record<string, unknown>, runtime: CurrentItemActionRuntime,
): Promise<Record<string, unknown>> {
  rejectUnknownKeys(params, ['turn_key', 'action_ref', 'comment'], 'current item action')
  const actionRef = requireString(params.action_ref, 'action_ref', { min: 1, max: 64, trim: true })
  const comment = requireString(params.comment, 'comment', { min: 1, max: 4000, trim: false })
  if (!comment.trim() || comment.includes('\0')) throw new Error('请提供本轮明确的办理意见')
  const bound = runtime.bound
  if (bound.purpose !== 'review' || runtime.turn.enterpriseReadOnly !== true
    || !runtime.claim.sessionPath || bound.sessionPath !== runtime.claim.sessionPath) {
    throw new Error('请从本人“我的工作”重新打开当前审批事项')
  }
  if (runtime.turn.prompt.includes(APPROVAL_REVIEW_SESSION_MARKER) || runtime.turn.pendingSessionPrompts?.some((prompt) => prompt.includes(APPROVAL_REVIEW_SESSION_MARKER))) {
    throw new Error('打开审批材料只授权只读核对；请在后续员工消息中明确办理当前事项')
  }
  const reference = runtime.refs.get(actionRef)
  if (!reference || reference.requestId !== bound.context.requestId) throw new Error('动作目录已过期，请在当前员工轮次重新读取')
  await runtime.assertCurrent(reference)
  const attemptKey = digest(JSON.stringify([bound.accountKey, reference.sessionPath, reference.requestId, runtime.turn.messageId]))
  const actionFingerprint = digest(JSON.stringify(reference.action)), commentDigest = digest(comment)
  const previousAttempt = runtime.attempts.get(attemptKey)
  if (previousAttempt) {
    if (previousAttempt.actionFingerprint !== actionFingerprint || previousAttempt.commentDigest !== commentDigest) {
      throw new Error('本轮员工意见已用于另一项办理请求；请在新的员工消息中明确办理当前事项')
    }
    if (previousAttempt.status === 'unknown') return reconcileCurrentItemAction(runtime, reference, comment, previousAttempt)
    return previousAttempt.result as Record<string, unknown>
  }
  if (runtime.contextChanged) {
    const staleAttempt: CurrentItemActionAttempt = {
      status: 'unknown', actionFingerprint, commentDigest, baselineHistoryIds: reference.baselineHistoryIds,
      message: '审批事项或动作目录在本轮办理前发生变化。',
    }
    runtime.attempts.set(attemptKey, staleAttempt)
    return reconcileCurrentItemAction(runtime, reference, comment, staleAttempt)
  }
  let currentContext: EnterpriseApprovalContext
  try { currentContext = await runtime.getCurrentContext() }
  catch {
    const unavailableAttempt: CurrentItemActionAttempt = {
      status: 'unknown', actionFingerprint, commentDigest, baselineHistoryIds: reference.baselineHistoryIds,
      message: '发送前无法重新核对 Forge 当前事项。',
    }
    runtime.attempts.set(attemptKey, unavailableAttempt)
    return reconcileCurrentItemAction(runtime, reference, comment, unavailableAttempt)
  }
  await runtime.assertCurrent(reference)
  if (!currentContext.availableActions?.some((action) => digest(JSON.stringify(action)) === digest(JSON.stringify(reference.action)))) {
    const staleAttempt: CurrentItemActionAttempt = {
      status: 'unknown', actionFingerprint, commentDigest, baselineHistoryIds: reference.baselineHistoryIds,
      message: '审批事项或动作目录已变化。',
    }
    runtime.attempts.set(attemptKey, staleAttempt)
    return reconcileCurrentItemAction(runtime, reference, comment, staleAttempt)
  }
  const session = await runtime.service.getSession()
  if (session.status !== 'signed-in' || !session.user?.id) throw new Error('请先登录以办理当前 Forge 事项')
  const latestHistory = await runtime.service.getApprovalActionHistory(bound.context.requestId)
  const knownIds = new Set(reference.baselineHistoryIds)
  const alreadyRecorded = latestHistory.map(approvalHistoryRow).find((row) => row
    && row.requestId === reference.requestId && row.actorId === session.user!.id
    && row.comment === comment && !knownIds.has(row.id))
  if (alreadyRecorded) {
    const prior: CurrentItemActionAttempt = {
      status: 'unknown', actionFingerprint, commentDigest, baselineHistoryIds: reference.baselineHistoryIds,
      result: {
        outcome: 'unknown', nativeStatus: 'history_observed', decision: 'unknown', nativeAction: alreadyRecorded.action, comment: alreadyRecorded.comment,
        currentItemStatus: currentContext.status, returnReason: currentContext.returnReason,
        message: 'Forge 原生动作历史出现了当前员工意见，但没有原生回执确认它对应所选动作；结果仍未知，且没有重发。请核对当前事项状态。',
      },
    }
    runtime.attempts.set(attemptKey, prior)
    return prior.result as Record<string, unknown>
  }
  await runtime.assertCurrent(reference)
  const action = reference.action
  const requirement = action.execution.requiresConfirmation
  if (typeof requirement !== 'boolean') throw new Error('Forge 没有提供当前动作的明确确认声明，请重新读取当前事项目录')
  const input = action.inputs[0]
  const actionArgs: NativeMcpActionArguments = {
    actionName: action.execution.actionName,
    objectName: action.execution.objectName,
    recordId: action.execution.recordId,
    params: { ...action.execution.params, [input.name]: comment },
  }
  const pendingAttempt: CurrentItemActionAttempt = {
    status: 'unknown', actionFingerprint, commentDigest, baselineHistoryIds: reference.baselineHistoryIds,
  }
  runtime.attempts.set(attemptKey, pendingAttempt)
  const result = await runtime.service.runNativeMcpAction(actionArgs, async () => {
    await runtime.assertCurrent(reference)
  }, requirement, async () => {
    await runtime.assertCurrent(reference)
    const latest = await runtime.getCurrentContext()
    await runtime.assertCurrent(reference)
    const selected = latest.availableActions?.find((candidate) => digest(JSON.stringify(candidate)) === actionFingerprint)
    if (latest.status !== 'pending' || latest.viewer !== currentContext.viewer
      || latest.businessObject.objectName !== action.execution.objectName
      || latest.businessObject.recordId !== action.execution.recordId || !selected
      || selected.execution.requiresConfirmation !== requirement) {
      throw new Error('发送前当前审批、动作或确认声明已变化，请重新读取本人事项')
    }
  })
  pendingAttempt.status = result.status
  pendingAttempt.code = result.code
  pendingAttempt.message = result.message
  if (result.status === 'rejected') {
    pendingAttempt.result = {
      outcome: 'rejected', ...(result.code ? { errorCode: result.code } : {}),
      message: result.message ?? 'Forge 明确拒绝了当前事项动作。',
    }
    return pendingAttempt.result as Record<string, unknown>
  }
  if (result.status === 'returned') {
    const observation = parseCurrentItemActionObservation(result.result, action)
    if (observation) {
      pendingAttempt.status = 'unknown'
      pendingAttempt.nativeObservation = observation
      pendingAttempt.message = 'Forge返回原生history_observed；它不确认所选动作回执。'
      return reconcileCurrentItemAction(runtime, reference, comment, pendingAttempt)
    }
    const receipt = parseCurrentItemActionReceipt(result.result, action)
    if (receipt) {
      pendingAttempt.result = {
        outcome: 'returned', decision: receipt.decision, status: receipt.status,
        resumed: receipt.resumed, autoRejected: receipt.autoRejected, alreadyApplied: receipt.alreadyApplied,
        message: 'Forge 已返回当前事项的原生动作回执。该回执说明本次动作结果，不自动表示整个审批流程已完成。',
      }
      return pendingAttempt.result as Record<string, unknown>
    }
    pendingAttempt.status = 'unknown'
    pendingAttempt.message = 'Forge 返回了与当前事项或版本不匹配的动作回执。'
  }
  return reconcileCurrentItemAction(runtime, reference, comment, pendingAttempt)
}
