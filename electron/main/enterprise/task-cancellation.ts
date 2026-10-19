import type { EnterpriseWorkContinuationContext } from '../enterprise'
import type { EnterpriseWorkCancellationResult } from '../../../src/types/api'

interface CancellationAccess {
  readContext(): Promise<EnterpriseWorkContinuationContext | undefined>
  revoke(grantID: string): Promise<{ status: number; body: unknown }>
  stop(idempotencyKey: string): Promise<{ status: number; body: unknown }>
  assertCurrent(): Promise<void>
}
interface PinnedCancellation { inputRevisionID?: string; sessionID?: string; grantID?: string; idempotencyKey: string }

/** Pin one employee cancellation to its original run and grant across uncertain receipts. */
export class EmployeeWorkCanceller {
  private readonly attempts = new Map<string, PinnedCancellation>()
  clear(): void { this.attempts.clear() }

  async cancel(runId: string, accountKey: string, access: CancellationAccess): Promise<EnterpriseWorkCancellationResult> {
    await access.assertCurrent()
    const context = await access.readContext()
    await access.assertCurrent()
    if (context && context.source.runID !== runId) throw new Error('取消请求与原工作不一致，请刷新工作列表')
    const key = `${accountKey}:${runId}`
    const observed: PinnedCancellation = {
      inputRevisionID: context?.source.inputRevisionID, sessionID: context?.source.workbenchSessionID,
      grantID: context?.run.authorization?.grantID, idempotencyKey: `workbench-cancel-${runId}`,
    }
    const pinned = this.attempts.get(key) ?? observed
    if (pinned.inputRevisionID !== observed.inputRevisionID || pinned.sessionID !== observed.sessionID || pinned.grantID !== observed.grantID) {
      throw new Error('原工作授权已变化，请刷新后核对；桌面没有取消替换后的授权')
    }
    if (context?.run.authorization && context.run.authorization.status !== 'not_applicable'
      && !pinned.grantID) throw new Error('原工作缺少可核对的任务授权，取消尚未确认')
    this.attempts.set(key, pinned)
    let authorizationRevoked = false
    try {
      if (pinned.grantID) {
        const revoked = await access.revoke(pinned.grantID)
        await access.assertCurrent()
        const receipt = record(revoked.body)
        if (revoked.status !== 200 || receipt?.version !== '1' || receipt.grant_id !== pinned.grantID || receipt.revoked !== true
          || !['employee_cancel', 'run_terminal', 'subject_inactive'].includes(String(receipt.reason))) {
          throw new Error('任务授权吊销回执未能确认')
        }
        authorizationRevoked = true
        const current = await access.readContext()
        await access.assertCurrent()
        if (!current || current.source.runID !== runId || current.source.inputRevisionID !== pinned.inputRevisionID
          || current.source.workbenchSessionID !== pinned.sessionID || current.run.authorization?.grantID !== pinned.grantID) {
          throw new Error('原工作授权在取消期间已变化')
        }
      }
      const stopped = await access.stop(pinned.idempotencyKey)
      await access.assertCurrent()
      const receipt = record(stopped.body), status = receipt?.status
      if (stopped.status !== 202 || receipt?.run_id !== runId || receipt.idempotency_key !== pinned.idempotencyKey
        || !['cancel_requested', 'cancelled', 'succeeded', 'failed', 'abandoned'].includes(String(status))) {
        throw new Error('原工作取消回执未能确认')
      }
      if (status === 'cancel_requested') return { runId, status, authorizationRevoked, message: '已请求取消，等待团队停止。已发生的业务结果请在 Forge 核对。' }
      if (status === 'cancelled') return { runId, status, authorizationRevoked, message: '团队工作已取消。已发生的业务结果请在 Forge 核对。' }
      return { runId, status: 'completed', authorizationRevoked, message: '原工作已经结束，请在 Forge 核对已发生的业务结果。' }
    } catch {
      await access.assertCurrent()
      return { runId, status: 'unknown', authorizationRevoked, message: authorizationRevoked
        ? '任务授权已吊销，团队停止结果待核对。再次取消会沿原工作核对。'
        : '取消结果待核对，请再次取消以核对原工作和原授权。' }
    }
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
