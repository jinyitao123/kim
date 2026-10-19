import { canonicalJSON, issueTaskToken, type DelegationTransport, type ForgeTaskScope } from './task-handoff'
import type { EnterpriseWorkContinuationContext } from '../enterprise'

export interface FrozenAuthorizationRenewal {
  accountKey: string
  source: EnterpriseWorkContinuationContext['source']
  expectedGeneration: number
  scope: ForgeTaskScope
  retryNodeID: string
  requestID: string
  retryRequestID: string
}
export interface RenewalProgress {
  phase: 'issue_started' | 'authorization_started' | 'authorized' | 'retry_started' | 'receipt'
  generation?: number
  expiresAt?: string
  result?: AuthorizationRenewalResult
}
export interface AuthorizationRenewalResult { status: 'resumed' | 'unknown'; authorizationRenewed: boolean; message: string }
export interface RenewalObserver {
  assertCurrent(): Promise<void>
  readProgress(): Promise<RenewalProgress | undefined>
  checkpoint(progress: RenewalProgress): Promise<void>
}
export async function renewFixedAuthorization(intent: FrozenAuthorizationRenewal, transport: DelegationTransport,
  read: () => Promise<EnterpriseWorkContinuationContext>, observer: RenewalObserver): Promise<AuthorizationRenewalResult> {
  await observer.assertCurrent()
  let progress = await observer.readProgress()
  if (progress?.phase === 'receipt' && progress.result) return progress.result
  const current = await read()
  const auth = current.run.authorization
  if (current.source.inputRevisionID !== intent.source.inputRevisionID || current.source.runID !== intent.source.runID
    || current.source.workbenchSessionID !== intent.source.workbenchSessionID || current.source.inputStatus !== 'current'
    || !auth?.scope || canonicalJSON(auth.scope) !== canonicalJSON(intent.scope)) throw new Error('原工作输入或授权范围已变化，请刷新工作消息')
  if (progress?.phase === 'retry_started') return {
    status: 'unknown', authorizationRenewed: auth.status === 'active' && auth.generation === progress.generation,
    message: '原输入续授权请求已处理，但恢复执行回执尚未确认。桌面只读取当前状态，没有重发业务动作或另建工作；请从工作消息核对平台结果。',
  }
  const alreadyAuthorized = progress?.generation !== undefined && auth.status === 'active' && auth.generation === progress.generation
  if (!alreadyAuthorized && (current.run.status !== 'parked' || !['renewal_required', 'active'].includes(auth.status) || !auth.canRenew
    || auth.generation !== intent.expectedGeneration || auth.retryNodeID !== intent.retryNodeID)) {
    throw new Error('平台未确认原运行可无副作用续办，请先核对原业务回执；不能续授权重放或另建工作')
  }
  if (!alreadyAuthorized) {
    await observer.checkpoint({ phase: 'issue_started' })
    const grant = await issueTaskToken(transport, intent.requestID, intent.scope, intent.expectedGeneration)
    progress = { phase: 'authorization_started', generation: grant.generation, expiresAt: grant.expiresAt }
    await observer.checkpoint(progress)
    try {
      const replaced = object((await transport.weave(`/v1/workbench/dispatch-inputs/${encodeURIComponent(intent.source.inputRevisionID)}/authorization`, { expected_generation: intent.expectedGeneration }, grant.token)).body)
      if (replaced?.input_revision_id !== intent.source.inputRevisionID || replaced.status !== 'active'
        || replaced.generation !== grant.generation || typeof replaced.expires_at !== 'string' || Date.parse(replaced.expires_at) !== Date.parse(grant.expiresAt)) throw new Error('续授权回执与原输入或授权代际不一致')
    } catch (error) {
      await observer.assertCurrent()
      if (error instanceof Error && 'status' in error && [403, 404, 409].includes(error.status as number)) throw new Error('原工作授权状态已变化或当前账号无权续办，请刷新后核对原业务回执')
      return { status: 'unknown', authorizationRenewed: false, message: '原输入续授权回执暂时无法确认。固定请求已保留，桌面没有恢复执行、重发业务动作或另建工作；请核对原工作授权状态。' }
    }
  }
  progress = { phase: 'authorized', generation: progress!.generation, expiresAt: progress!.expiresAt }
  await observer.checkpoint(progress)
  await observer.assertCurrent()
  const ready = await read()
  if (ready.source.inputStatus !== 'current' || ready.run.status !== 'parked' || ready.run.authorization?.status !== 'active'
    || ready.run.authorization.generation !== progress.generation || canonicalJSON(ready.run.authorization.scope) !== canonicalJSON(intent.scope)
    || ready.run.authorization.retryNodeID !== undefined && ready.run.authorization.retryNodeID !== intent.retryNodeID) {
    throw new Error('原输入授权已更新，但运行已不在原安全等待位置；请只读核对平台结果，桌面没有再次恢复执行')
  }
  await observer.checkpoint({ ...progress, phase: 'retry_started' })
  try {
    const response = await transport.weave(`/v1/runs/${encodeURIComponent(intent.source.runID)}/stages/${encodeURIComponent(intent.retryNodeID)}/retry`, { idempotency_key: intent.retryRequestID })
    const receipt = object(response.body)
    if (receipt?.run_id !== intent.source.runID || receipt.node_id !== intent.retryNodeID || receipt.preserved_completed_stages !== true
      || !['queued', 'dispatched', 'running', 'completed'].includes(receipt.status as string)) throw new Error('恢复执行回执不完整')
    await observer.assertCurrent()
    const result: AuthorizationRenewalResult = { status: 'resumed', authorizationRenewed: true, message: '已为原工作续授权，并从平台确认的等待位置恢复执行。原输入和已完成步骤保留，业务结果以正式回执为准。' }
    await observer.checkpoint({ ...progress, phase: 'receipt', result })
    return result
  } catch {
    await observer.assertCurrent()
    return { status: 'unknown', authorizationRenewed: true, message: '原输入授权已更新，但恢复执行回执尚未确认。桌面没有重发业务动作或另建工作，请从工作消息核对平台结果。' }
  }
}
function object(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined }
