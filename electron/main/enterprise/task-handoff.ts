import { createHash } from 'node:crypto'
import { WorkRegistrationRejectedError } from '../enterprise'
import type { EnterpriseWorkChoice, EnterpriseWorkReceipt, EnterpriseWorkResource } from '../../../src/types/api'
import { submissionUUID } from './handoff-store'

export interface ForgeTaskScope {
  input_revision_id: string
  registration_id: string
  task_sha256: string
  workflow_id: string
  workflow_version: number
  allowed_actions: string[]
  resources: EnterpriseWorkResource[]
  business_record?: { object_name: string; record_id: string }
}
export interface DelegationIntent { inputRevisionID: string; requestID: string }
export interface FixedWorkSource {
  idempotencySeed: string
  sessionKey: string
  sourceMessages: Array<{ messageId: string; eventSeq: number; sha256: string }>
  accountKey: string
  resources: EnterpriseWorkResource[]
  businessContext?: { objectName: string; recordId: string; recordVersion?: string }
  continuation?: { workbenchSessionID: string; inputRevisionID: string; runID: string; teamID: string; restartAfterFailedRun?: boolean }
  authorizedBusinessCapabilityIds: string[]
  assertCurrent(): Promise<void>
  fixDelegationIntent(inputRevisionID: string, scope: ForgeTaskScope): Promise<DelegationIntent>
}
export interface DelegationTransport {
  projectID: string
  issuer: string
  identityIssuer: string
  nativeIdentity(): Promise<{ id: string; organizationID: string }>
  forge(path: string, body: unknown): Promise<{ status: number; body: unknown }>
  weave(path: string, body: unknown, taskToken?: string): Promise<{ status: number; body: unknown }>
  assertCurrent(): Promise<void>
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function taskScopeSHA256(value: unknown): string {
  return createHash('sha256').update(canonicalJSON(value)).digest('hex')
}
export function canonicalJSON(value: unknown): string {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort)
    : item !== null && typeof item === 'object' ? Object.fromEntries(Object.entries(item).filter(([, val]) => val !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, val]) => [key, sort(val)])) : item
  return JSON.stringify(sort(value))
}
export async function issueTaskToken(transport: DelegationTransport, requestID: string, scope: ForgeTaskScope, expectedGeneration?: number): Promise<{ token: string; generation: number; expiresAt: string }> {
  await transport.assertCurrent()
  const identity = await transport.nativeIdentity()
  const { body } = await transport.forge('/api/v1/apps/forge/task-delegations', { request_id: requestID, scope, ...(expectedGeneration !== undefined ? { expected_generation: expectedGeneration } : {}) })
  await transport.assertCurrent()
  const result = object(body), subject = object(result?.subject)
  const issued = typeof result?.issued_at === 'string' ? Date.parse(result.issued_at) : NaN
  const expires = typeof result?.expires_at === 'string' ? Date.parse(result.expires_at) : NaN
  if (result?.version !== '1' || result.token_type !== 'forge_task' || typeof result.access_token !== 'string' || !result.access_token
    || typeof result.grant_id !== 'string' || !result.grant_id || !Number.isSafeInteger(result.generation) || (result.generation as number) < 1
    || !Number.isFinite(issued) || !Number.isFinite(expires) || expires <= Date.now() || expires <= issued || expires - issued > 24 * 60 * 60_000
    || issued > Date.now() + 30_000 || result.issuer !== transport.issuer || result.identity_issuer !== transport.identityIssuer
    || subject?.id !== identity.id || subject.organization_id !== identity.organizationID
    || expectedGeneration !== undefined && result.generation !== expectedGeneration + 1
    || result.scope_sha256 !== taskScopeSHA256(scope) || canonicalJSON(result.scope) !== canonicalJSON(scope)) {
    throw new WorkRegistrationRejectedError('Forge 返回的任务授权与当前员工、组织或固定工作范围不一致，已停止交接')
  }
  return { token: result.access_token, generation: result.generation as number, expiresAt: result.expires_at as string }
}

export async function fixedWorkHandoff(choice: EnterpriseWorkChoice, task: string, source: FixedWorkSource, transport: DelegationTransport): Promise<EnterpriseWorkReceipt> {
  const workID = submissionUUID(`${source.accountKey}:${source.idempotencySeed}`)
  const sessionID = source.continuation?.workbenchSessionID ?? `${transport.projectID}-${source.sessionKey}-${workID}`
  const request = {
    registration_id: workID, workbench_session_id: sessionID,
    ...(source.continuation ? { expected_revision_id: source.continuation.inputRevisionID,
      ...(source.continuation.restartAfterFailedRun ? {} : { revision_context: { parent_input_revision_id: source.continuation.inputRevisionID, parent_run_id: source.continuation.runID } }) } : {}),
    team_id: choice.teamId, workflow_id: choice.workflowId, workflow_version: choice.version, project_id: transport.projectID, task,
    resources: source.resources,
    ...(source.businessContext ? { business_record: { object_name: source.businessContext.objectName, record_id: source.businessContext.recordId } } : {}),
    authorized_business_capability_ids: source.authorizedBusinessCapabilityIds,
    source_messages: source.sourceMessages.map(({ messageId, eventSeq, sha256 }) => ({ message_id: messageId, event_seq: eventSeq, sha256 })),
  }
  let registered: { status: number; body: unknown }
  try {
    const prepared = object((await transport.weave('/v1/workbench/dispatch-inputs/prepare', request)).body)
    const inputID = prepared?.input_revision_id
    if (typeof inputID !== 'string' || !UUID.test(inputID)) throw new WorkRegistrationRejectedError('Weave 没有返回准确固定输入，已停止交接')
    const scope: ForgeTaskScope = JSON.parse(JSON.stringify({ input_revision_id: inputID, registration_id: workID,
      task_sha256: createHash('sha256').update(task).digest('hex'), workflow_id: choice.workflowId, workflow_version: choice.version,
      allowed_actions: source.authorizedBusinessCapabilityIds, resources: source.resources, ...(request.business_record ? { business_record: request.business_record } : {}) }))
    const intent = await source.fixDelegationIntent(inputID, scope)
    await transport.assertCurrent()
    if (intent.inputRevisionID !== inputID || !UUID.test(intent.requestID)) throw new WorkRegistrationRejectedError('持久授权意图与原固定工作输入不一致，已停止交接')
    const grant = await issueTaskToken(transport, intent.requestID, scope)
    registered = await transport.weave('/v1/workbench/dispatch-inputs', { ...request, input_revision_id: inputID }, grant.token)
    const registration = object(registered.body)
    if (registration?.input_revision_id !== inputID || registration.task_sha256 !== scope.task_sha256) throw new Error('Weave 输入回执与本次固定材料不一致，结果待核对')
  } catch (error) {
    if (error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code.startsWith('business_delegation_')) throw new WorkRegistrationRejectedError(error.message)
    if (error instanceof Error && 'code' in error && error.code === 'business_completion_check_required') {
      throw new WorkRegistrationRejectedError('该团队流程尚未配置业务办理的回执检查，暂不能授权团队办理业务动作；本次未接单。可只交给团队核对，或请团队维护人员更新流程后再交接')
    }
    if (error instanceof Error && 'status' in error && error.status === 409) throw new WorkRegistrationRejectedError('code' in error && error.code === 'dispatch_input_too_many_resources'
      ? '团队交接最多允许 10 份材料，新文件和明确复用的原材料合计已超限；本次未接单，请减少材料后重新发起'
      : source.continuation ? '原工作已有更新输入，或交付结果不可修订；请打开最新团队结果消息继续，旧事项不能覆盖后来的工作' : '本次固定交接与已登记内容冲突，请核对当前员工要求后重新发起')
    throw error
  }
  const registration = object(registered.body), inputID = registration?.input_revision_id, clientID = registration?.client_request_id
  if (typeof inputID !== 'string' || typeof clientID !== 'string' || !clientID) throw new Error('Weave 输入回执不完整，结果待核对')
  const dispatched = await transport.weave(`/v1/teams/${encodeURIComponent(choice.teamId)}/dispatch`, { input_revision_id: inputID, client_request_id: clientID })
  const result = object(dispatched.body)
  if (typeof result?.run_id !== 'string' || !result.run_id || typeof result.task_id !== 'string' || !result.task_id || result.workflow_id !== choice.workflowId || result.workflow_version !== choice.version) throw new Error('Weave 没有返回匹配的接单回执，结果待核对')
  return { workId: workID, runId: result.run_id, taskId: result.task_id, workflowId: choice.workflowId, workflowVersion: choice.version,
    inputRevisionId: inputID, clientRequestId: clientID, taskSha256: registration!.task_sha256 as string, repeated: dispatched.status === 200 }
}
function object(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined }
