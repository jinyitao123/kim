import { randomUUID } from 'node:crypto'
import { rejectUnknownKeys } from '../validation'
import { digest, type HandoffStore } from './handoff-store'
import type { EnterpriseService, EnterpriseWorkContinuationContext } from '../enterprise'
import type { FrozenAuthorizationRenewal, RenewalProgress } from './task-renewal'

/** An employee turn renews one pinned original input; it cannot choose a scope or replay a stage. */
export async function renewFromEmployeeTurn(params: Record<string, unknown>, access: {
  opening: boolean
  prompt: string
  accountKey: string
  context?: EnterpriseWorkContinuationContext
  store: HandoffStore
  renew?: EnterpriseService['renewWorkAuthorization']
  assertCurrent(): Promise<string | undefined>
}): Promise<unknown> {
  rejectUnknownKeys(params, ['turn_key', 'employee_request'], 'work authorization renewal')
  if (access.opening || !access.context) throw new Error('打开工作消息只授权查看，请由员工在新消息中明确要求继续原工作')
  if (params.employee_request !== access.prompt) throw new Error('续授权必须使用本轮员工明确要求，不能代入旧消息')
  const messageID = await access.assertCurrent()
  if (!messageID) throw new Error('无法核对当前员工续授权要求，请从原工作重新打开')
  const authorization = access.context.run.authorization
  if (!authorization?.canRenew || !['renewal_required', 'active'].includes(authorization.status) || !authorization.scope || !authorization.generation || !authorization.retryNodeID) throw new Error('平台没有确认这项工作可安全续授权，请先核对原业务回执')
  if (!access.renew) throw new Error('当前平台尚未接通原工作续授权，请保留原工作并核对回执')
  const source = access.context.source
  const key = `${access.accountKey}:${source.inputRevisionID}:${source.runID}:${messageID}:renew-authorization`
  const fingerprint = digest(JSON.stringify({ source, scope: authorization.scope, generation: authorization.generation, retryNodeID: authorization.retryNodeID }))
  const intent = await access.store.freeze<FrozenAuthorizationRenewal>(key, fingerprint, async () => ({
    accountKey: access.accountKey, source: structuredClone(source), expectedGeneration: authorization.generation!, scope: structuredClone(authorization.scope!), retryNodeID: authorization.retryNodeID!, requestID: randomUUID(), retryRequestID: randomUUID(),
  }))
  const progressKey = `${key}:progress`
  return access.renew(intent, {
    assertCurrent: async () => { await access.assertCurrent() },
    readProgress: async () => (await access.store.inspect<RenewalProgress>(progressKey))?.value,
    checkpoint: async (progress) => { await access.store.checkpoint(progressKey, fingerprint, progress) },
  })
}
