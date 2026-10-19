import type { EmployeeBusinessInputs } from './employee-business-inputs'
import { storedUploadProgress } from './upload-progress'
import type { VerifiedCreationReference } from './employee-business-creation'
import { projectWorkActionFact } from '../../../src/lib/work-action-outcomes'
import { WORKBENCH_RUN_CONTINUATION_TYPE } from '../../../src/lib/team-work-continuation'
import { randomUUID } from 'node:crypto'
import { taskScopeDisplay } from './scope-display'
import { approvalContextView, WorkRegistrationRejectedError, type ApprovalRevisionSubmission, type EnterpriseBusinessNotificationContext, type EnterpriseService, type EnterpriseWorkContinuationContext } from '../enterprise'
import type { EnterpriseApprovalContext, HarnessId, EnterpriseApprovalContextView, EnterpriseBusinessCapability, EnterpriseBusinessNotificationContextView, EnterpriseWorkChoice, EnterpriseWorkContinuationContextView, EnterpriseWorkItem, EnterpriseWorkResource, TranscriptMessage, WorkspaceMaterialPromptReference } from '../../../src/types/api'
import { CapabilityBridge, type CapabilityClaim } from '../lib/capability-bridge'
import { canonicalSessionPath } from '../session-paths'
import { rejectUnknownKeys, requireString } from '../validation'
import { digest, HandoffStore, submissionUUID, type HandoffStorage } from './handoff-store'
import { executionText, freezeMaterials, makeFrozenTextMaterial, materialSelection, normalizeFrozenMaterial, normalizeFrozenMaterials, validateFrozenApprovalOriginalMaterial, validateFrozenMaterial, type FrozenMaterial, type MaterialLimits, type ReusedMaterial } from './materials'
import { searchTeams, type TeamSummary } from './team-catalog'
import { APPROVAL_REVIEW_SESSION_MARKER } from '../../../src/lib/approval-review'
import type { BusinessObjectDirectory, BusinessRecordCandidate, BusinessRecordRead, BusinessRecordSearchPage, BusinessRecordSnapshot } from './business-records'
import { businessReadErrorResult } from './business-read-error'
import type { BoundCurrentItemAction, CurrentItemActionAttempt } from './current-item-actions'
import type { EmployeeBusinessActions } from './employee-business-actions'
import type { PendingEmployeeBusinessContext } from './employee-business-open'
import type { EmployeeBusinessRecord } from '../../../src/types/employee-business'

interface EnterpriseSessionReader {
  read(filePath: unknown): Promise<TranscriptMessage[]>
}
export interface AgentEnterpriseBridgeOptions {
  service: Pick<EnterpriseService, 'accountKey' | 'getSession' | 'getApprovalContext' | 'getApprovalActionHistory' | 'runNativeMcpAction' | 'getWorkNotificationSource' | 'getBusinessNotificationContext' | 'getWorkContinuationContext' | 'getTeamCatalog' | 'getTeamChoices' | 'getBusinessCapabilities' | 'getBusinessObjectDirectory' | 'findBusinessRecords' | 'readBusinessRecord' | 'stageWorkMaterials' | 'submitWork' | 'submitApprovalRevision' | 'getApprovalRevisionReceipt'> & Partial<Pick<EnterpriseService, 'renewWorkAuthorization' | 'getRunContinuationReferences' | 'getEmployeeBusinessContext' | 'executeEmployeeBusinessAction' | 'getEmployeeBusinessOperation' | 'getEmployeeBusinessMaterial' | 'listOwnClientSessions' | 'revokeOwnClientSession' | 'listInitializationActions' | 'runNativeInitializationAction'>>
  sessions: Record<HarnessId, EnterpriseSessionReader>
  extensionPath: string
  storage?: HandoffStorage
  /** Asks the employee in the app window; absent where no window exists, which leaves unsettled wording refused. */
  confirmAction?: (request: import('./employee-business-actions').EmployeeBusinessConfirmation) => Promise<boolean>
  /** Asks the person to confirm an irreversible operation in the app window. */
  confirmOperation?: (question: { title: string; subject?: string; message: string }) => Promise<boolean>
}
interface FrozenHandoffIntent {
  task: string
  /** Materials attached in this employee turn; only these are uploaded during staging. */
  materials: FrozenMaterial[]
  /** Exact Forge references selected from an eligible zero-action terminal input. */
  reusedMaterials?: ReusedMaterial[]
  authorizedBusinessCapabilityIds: string[]
  sourceMessages: Array<{ messageId: string; eventSeq: number; sha256: string }>
  employeeMessageId: string
  choice: EnterpriseWorkChoice
  accountKey: string
  idempotencySeed: string
  sessionKey: string
  businessContext?: { objectName: string; recordId: string; name: string; code?: string; recordVersion?: string }
  businessSnapshot?: BusinessRecordSnapshot
  continuation?: { workbenchSessionID: string; inputRevisionID: string; runID: string; teamID: string }
}
interface FrozenHandoff extends FrozenHandoffIntent { resources: EnterpriseWorkResource[] }
interface EmployeeTurn {
  key: string
  prompt: string
  employeePrompt: string
  capturedEmployeeInput?: boolean
  accountKey: string
  baseline: Set<string>
  authorizedMaterials: WorkspaceMaterialPromptReference[]
  openingWorkContinuation?: boolean
  openingReturnedApproval?: boolean
  openingEmployeeBusiness?: boolean
  businessNotification?: BoundBusinessNotificationContext
  approvalContext?: BoundApprovalContext
  enterpriseReadOnly?: boolean
  pendingSessionPrompts?: string[]
  messageId?: string
  businessMutation?: 'employee' | 'initialization'
  workContinuation?: BoundWorkContinuation
}
type ApprovalContextPurpose = 'review' | 'revision'
interface PendingApprovalContext {
  purpose: ApprovalContextPurpose
  accountKey: string
  context: EnterpriseApprovalContext
  fingerprint: string
  createdAt: number
}
interface BoundApprovalContext extends PendingApprovalContext { sessionPath: string }
type BoundReturnedApproval = BoundApprovalContext & { purpose: 'revision' }
interface ApprovalReviewSessionMetadata {
  version: 1
  purpose: 'review'
  accountKey: string
  sessionPathDigest: string
  requestId: string
  objectName: string
  recordId: string
  status: 'pending' | 'returned'
  sourceMaterialVersion: string
  returnVersion?: string
}
interface PendingWeaveWorkContinuation {
  kind: 'weave'
  accountKey: string
  context: EnterpriseWorkContinuationContext
  fingerprint: string
  createdAt: number
}
interface PendingBusinessWorkContinuation {
  kind: 'business'
  accountKey: string
  context: EnterpriseBusinessNotificationContext
  fingerprint: string
  createdAt: number
}
type PendingWorkContinuation = PendingWeaveWorkContinuation | PendingBusinessWorkContinuation
interface BoundWorkContinuation extends PendingWeaveWorkContinuation { sessionPath: string }
interface BoundBusinessNotificationContext extends PendingBusinessWorkContinuation { sessionPath: string }
interface ScopedBusinessObject { objectName: string; label: string; accountKey: string; turnKey: string; directoryComplete: boolean }
interface ScopedBusinessRecord extends BusinessRecordCandidate {
  uniqueQuery?: string
  fromEmployeeOperation?: true
  accountKey: string
  turnKey: string
  snapshot?: BusinessRecordSnapshot
}
interface FrozenRevisionFile extends FrozenMaterial {}
interface LegacyFrozenRevisionFile { name: string; mediaType: 'text/plain; charset=utf-8'; bytes: number; sha256: string; bytesBase64: string }
interface FrozenRevisionSourceFile {
  fileId: string
  name: string
  mediaType: string
  bytes: number
  sha256: string
  bytesBase64: string
  sourceKind?: 'approval'
  requestId?: string
}
interface FrozenRevisionIntent {
  version: 1
  accountKey: string
  sessionKey: string
  employeeRoundId: string
  employeeMessageId: string
  employeeRequest: string
  employeeRequestSha256: string
  sourceMessages: Array<{ messageId: string; eventSeq: number; sha256: string }>
  requestId: string
  returnVersion: string
  sourceMaterialVersion: string
  idempotencyKey: string
  businessObject: EnterpriseApprovalContext['businessObject']
  returnReason: string
  sourceFiles: FrozenRevisionSourceFile[]
  body?: { name: string; content: string; bytes: number; sha256: string; bytesBase64: string }
  primaryMaterial?: FrozenRevisionFile
  materials: Array<FrozenRevisionFile | LegacyFrozenRevisionFile>
}
interface ReturnedRevisionFileReference { fileId: string; name: string; sha256: string; mediaType?: FrozenMaterial['mediaType']; bytes?: number }
interface ReturnedRevisionReceipt {
  requestId: string
  bindingId: string
  newVersionDigest: string
  state: 'prepared' | 'resumed' | 'resume_unknown'
  repeated: true
}
interface ReturnedRevisionProgress {
  version: 1
  phase: 'upload_started' | 'uploaded' | 'request_started' | 'receipt' | 'rejected'
  idempotencyKey: string
  rejectionState?: 'unavailable' | 'rejected'
  primary?: ReturnedRevisionFileReference
  attachments?: ReturnedRevisionFileReference[]
  receipt?: ReturnedRevisionReceipt
  message?: string
  /** The upload keeps a receipt per file, so an interrupted one resumes without duplicating files. */
  fileReceipts?: boolean
}
const REVISION_MATERIAL_LIMITS: MaterialLimits & { maxFiles: number } = { maxFiles: 10, maxFileBytes: 2 * 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024, maxTotalExtractedBytes: 700_000 }
function assertHandoffMaterialCount(newCount: number, reusedCount: number): void {
  if (newCount + reusedCount > 10) throw new WorkRegistrationRejectedError('团队交接最多允许 10 份材料，新文件和明确复用的原材料合计已超限；请减少材料后重新发起')
}
function messageText(message: TranscriptMessage): string {
  return message.parts.flatMap((part) => part.type === 'text' || part.type === 'agentMessage' ? [part.text] : []).join('\n').trim()
}
function handoffKey(choice: EnterpriseWorkChoice): string { return digest(JSON.stringify([choice.teamId, choice.workflowId, choice.version])).slice(0, 24) }
function returnedApprovalFingerprint(context: EnterpriseApprovalContext): string {
  return digest(JSON.stringify({
    requestId: context.requestId, status: context.status, viewer: context.viewer, title: context.title, step: context.step,
    businessObject: context.businessObject, sourceMaterialVersion: context.sourceMaterialVersion,
    availableActions: context.availableActions ?? null,
    returnVersion: context.returnVersion, returnReason: context.returnReason, fields: context.fields,
    quotationLines: context.quotationLines ?? null,
    files: context.files.map(({ fileId, name, mediaType, bytes, sha256 }) => ({ fileId, name, mediaType, bytes, sha256 })),
    originalFiles: context.originalFiles?.map(({ sourceKind, requestId, fileId, name, mediaType, bytes, sha256 }) => ({ sourceKind, requestId, fileId, name, mediaType, bytes, sha256 })),
  }))
}
function approvalReviewSessionKey(accountKey: string, sessionPath: string): string {
  return `approval-review-session:${accountKey}:${digest(canonicalSessionPath(sessionPath))}`
}
function approvalReviewSessionMetadata(accountKey: string, sessionPath: string, context: EnterpriseApprovalContext): ApprovalReviewSessionMetadata {
  return {
    version: 1, purpose: 'review', accountKey, sessionPathDigest: digest(canonicalSessionPath(sessionPath)),
    requestId: context.requestId, objectName: context.businessObject.objectName, recordId: context.businessObject.recordId,
    status: context.status, sourceMaterialVersion: context.sourceMaterialVersion,
    ...(context.returnVersion ? { returnVersion: context.returnVersion } : {}),
  }
}
function workContinuationFingerprint(context: EnterpriseWorkContinuationContext): string {
  return digest(JSON.stringify({ source: context.source, input: context.input, finalResult: context.run.finalResult ?? null, actionOutcomes: context.run.actionOutcomes ?? null, ...(context.run.businessResult !== undefined ? { businessResult: context.run.businessResult } : {}) }))
}
function isReusableReadOnlyContinuation(context: EnterpriseWorkContinuationContext | undefined): boolean {
  if (context?.source.inputStatus === 'superseded' || context?.source.inputStatus === 'closed') return false
  const run = context?.run
  if (!run || run.businessResult === 'action_failed' || run.businessResult === 'action_unknown' || !Array.isArray(run.actionOutcomes) || run.actionOutcomes.length !== 0) return false
  if (run.status === 'failed') return true
  return run.status === 'succeeded' && (run.businessResult !== undefined
    ? run.businessResult === 'needs_input' || run.businessResult === 'completed'
    : run.finalResult?.disposition === 'needs_input' || run.finalResult?.disposition === 'complete')
}
function assertContinuationSubmissionAuthorization(context: EnterpriseWorkContinuationContext): void {
  if (context.source.inputStatus === 'closed' || context.source.inputStatus === 'superseded') {
    throw new Error('原工作输入已关闭或已被更新输入取代，请从“我的工作”打开最新消息，不能沿旧事项创建新输入')
  }
  // A terminal read-only source, or an authoritative needs-input result with
  // no recorded action, can supply verified materials to a new input.
  // This source check is independent of the old grant's lifetime or whether
  // files are reused. submitWork issues a separate grant for the new message,
  // input and explicitly selected action scope; it never renews the old grant.
  const scope = context.input.authorizedBusinessCapabilityIDs
  const scopeReadable = Array.isArray(scope) && scope.length <= 32
    && scope.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 256 && id.trim() === id)
  const needsNewInput = context.run.status === 'succeeded' && context.run.businessResult === 'needs_input'
    && context.run.finalResult?.disposition === 'needs_input'
    && Array.isArray(context.run.finalResult.missingItems) && context.run.finalResult.missingItems.length > 0
    && context.run.authorization?.canRenew !== true
  if (context.source.inputStatus === 'current' && scopeReadable
    && (scope.length === 0 || needsNewInput) && isReusableReadOnlyContinuation(context)) return
  const authorization = context.run.authorization
  const canRenewOriginalWork = context.source.inputStatus === 'current' && context.run.status === 'parked'
    && authorization?.canRenew === true && ['renewal_required', 'active'].includes(authorization.status)
  if (canRenewOriginalWork) {
    throw new Error('原工作正在等待授权更新，不能用新交接或新输入替代；可安全续办时请继续原工作授权，否则先核对原业务回执')
  }
  const terminal = ['succeeded', 'failed', 'cancelled', 'abandoned'].includes(context.run.status)
  const hasBusinessActionReceipt = context.run.businessResult === 'action_failed' || context.run.businessResult === 'action_unknown'
    || (Array.isArray(context.run.actionOutcomes) && context.run.actionOutcomes.length > 0)
  if (context.source.inputStatus === 'current' && terminal && authorization?.status === 'renewal_required'
    && authorization.canRenew === false && hasBusinessActionReceipt) {
    throw new Error('原工作已结束且有业务动作回执，需核对 Forge 回执；不能沿旧工作恢复或重放')
  }
  throw new Error('当前团队运行状态、原授权范围或平台动作回执不允许复用原材料或创建新输入，请刷新工作消息并核对原结果')
}
function businessNotificationFingerprint(context: EnterpriseBusinessNotificationContext): string {
  const { capturedAt: _capturedAt, ...snapshot } = context.record.snapshot
  return digest(JSON.stringify({
    notificationID: context.notificationID, source: context.source, materialStatus: context.materialStatus,
    materialReferences: context.materialReferences,
    candidate: context.record.candidate, snapshot,
    materials: context.materials.map(({ sourceKind, requestId, fileId, name, mediaType, bytes, sha256, extraction }) => ({
      sourceKind, requestId, fileId, name, mediaType, bytes, sha256,
      content: extraction.content, status: extraction.status, coverage: extraction.coverage, limitations: extraction.limitations,
    })),
  }))
}
async function businessNotificationContextView(context: EnterpriseBusinessNotificationContext): Promise<EnterpriseBusinessNotificationContextView> {
  const { businessDisplayValue } = await import('./business-record-presentation')
  const snapshot = context.record.snapshot
  const presentation = context.record.presentation
  const name = businessDisplayValue(context.record.candidate.name) ?? '业务记录'
  const code = businessDisplayValue(context.record.candidate.code), status = businessDisplayValue(context.record.candidate.status), owner = businessDisplayValue(context.record.candidate.owner)
  return {
    kind: 'business', currentReadAt: context.currentReadAt, materialStatus: context.materialStatus,
    record: {
      objectLabel: businessDisplayValue(snapshot.objectLabel) ?? '业务事项', name,
      ...(code ? { code } : {}), ...(status ? { status } : {}), ...(owner ? { owner } : {}),
      fields: presentation?.record ?? [], relations: presentation?.relations ?? [],
      completeness: snapshot.completeness, pricingDetailCompleteness: snapshot.pricingDetailCompleteness,
      ...(snapshot.expectedDetailCount !== undefined ? { expectedDetailCount: snapshot.expectedDetailCount } : {}),
      completenessNotes: presentation?.notes ?? ['业务信息暂未展开，请重新读取。'],
    },
    materials: context.materials.map(({ name: fileName, mediaType, bytes, extraction }, index) => ({
      name: businessDisplayValue(fileName) ?? `${name}原件${index + 1}.${mediaType === 'application/pdf' ? 'pdf' : 'docx'}`, mediaType, bytes, verified: true,
      extraction: {
        status: extraction.status, content: extraction.content,
        coverage: { ...extraction.coverage }, limitations: [...extraction.limitations],
      },
    })),
  }
}
function reuseMaterialsFromContinuation(bound: BoundWorkContinuation | undefined, rawNames: unknown, accountKey: string): ReusedMaterial[] {
  if (rawNames === undefined) return []
  if (!Array.isArray(rawNames) || rawNames.some((name) => typeof name !== 'string')) {
    throw new Error('复用材料选择无效，请从当前工作中选择已冻结文件名')
  }
  if (!rawNames.length) return []
  if (!bound) throw new Error('当前会话没有绑定原工作。请从“我的工作”重新打开原工作消息，再明确授权复用材料；仅打开历史聊天不能恢复材料授权。')
  if (bound.accountKey !== accountKey) throw new Error('原工作不属于当前登录账号，请使用原员工账号从“我的工作”重新打开原消息。')
  if (!isReusableReadOnlyContinuation(bound.context)) throw new Error('原工作状态或平台业务动作回执不满足只读材料复用条件，请从“我的工作”刷新原消息并核对回执。')
  const names = rawNames.map((name) => {
    const normalized = name.trim()
    if (!normalized || normalized.length > 255 || normalized !== name || normalized.includes('\0')) {
      throw new Error('复用材料必须使用当前工作显示的完整文件名')
    }
    return normalized
  })
  if (new Set(names).size !== names.length) throw new Error('同一冻结材料不能重复选择')
  const selected = names.map((name) => {
    const matches = bound.context.input.materials.filter((material) => material.name === name)
    if (matches.length !== 1) throw new Error(matches.length
      ? `原工作中有多份同名材料“${name}”，无法安全判断要复用哪一份`
      : `原工作中没有唯一匹配的冻结材料“${name}”`)
    const material = matches[0]!
    if (!material.content || !material.mediaType || !material.materialId || !material.sha256
      || !material.bytes || !material.id) throw new Error(`原工作材料“${name}”缺少经核验的固定引用`)
    if (material.mediaType === 'application/pdf' || material.mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      if (!material.sourceKind || material.sourceKind === 'approval' && !material.requestId
        || material.sourceKind === 'owner' && material.requestId !== undefined) {
        throw new Error(`原工作材料“${name}”的受控来源与冻结引用不匹配`)
      }
    } else if (material.sourceKind !== undefined || material.requestId !== undefined) {
      throw new Error(`原工作材料“${name}”的来源字段不匹配`)
    }
    return {
      type: 'forge-file' as const,
      id: material.id,
      materialId: material.materialId,
      ...(material.sourceKind ? { sourceKind: material.sourceKind } : {}),
      ...(material.requestId ? { requestId: material.requestId } : {}),
      name: material.name,
      mediaType: material.mediaType as ReusedMaterial['mediaType'],
      bytes: material.bytes,
      sha256: material.sha256,
      content: material.content,
      ...(material.extraction ? { extraction: structuredClone(material.extraction) } : {}),
    }
  })
  return selected
}
function assertReturnedApproval(context: EnterpriseApprovalContext, requestId?: string): asserts context is EnterpriseApprovalContext & {
  status: 'returned'; viewer: 'original_submitter'; returnVersion: string; returnReason: string
} {
  if (context?.status !== 'returned' || context.viewer !== 'original_submitter'
    || (requestId && context.requestId !== requestId)
    || !context.requestId || context.requestId.length > 128 || !context.returnVersion || context.returnVersion.length > 128 || !/^[0-9a-f]{64}$/.test(context.sourceMaterialVersion)
    || !context.businessObject?.objectName || context.businessObject.objectName.length > 160
    || !context.businessObject.recordId || context.businessObject.recordId.length > 128
    || (context.businessObject.recordName !== undefined && context.businessObject.recordName.length > 300)
    || typeof context.returnReason !== 'string' || !Array.isArray(context.files)
    || context.files.some((file) => !file.fileId || file.fileId.length > 128 || !file.name || file.name.length > 255 || file.mediaType !== 'text/plain; charset=utf-8'
      || !Number.isInteger(file.bytes) || file.bytes < 0 || file.bytes > 2 * 1024 * 1024
      || !/^[0-9a-f]{64}$/.test(file.sha256) || file.verified !== true
      || Buffer.byteLength(file.content, 'utf8') !== file.bytes || digest(Buffer.from(file.content, 'utf8')) !== file.sha256)
    || context.originalFiles !== undefined && (!Array.isArray(context.originalFiles)
      || context.originalFiles.some((file) => file.sourceKind !== 'approval' || file.requestId !== context.requestId))) {
    throw new Error('当前退回事项或材料版本不完整，请刷新待办')
  }
  context.originalFiles?.forEach((file) => { validateFrozenApprovalOriginalMaterial(file) })
}
function assertApprovalReviewContext(context: EnterpriseApprovalContext, requestId: string): void {
  if (context?.requestId !== requestId
    || !(context.status === 'pending' && context.viewer === 'current_approver'
      || context.status === 'returned' && context.viewer === 'original_submitter')
    || !context.businessObject?.objectName || context.businessObject.objectName.length > 160
    || !context.businessObject.recordId || context.businessObject.recordId.length > 128
    || !/^[0-9a-f]{64}$/.test(context.sourceMaterialVersion)) {
    throw new Error('审批事项已变化或当前账号无权读取，请刷新待办')
  }
  if (context.status === 'returned') assertReturnedApproval(context, requestId)
}
function revisionFile(material: FrozenMaterial): FrozenRevisionFile {
  validateFrozenMaterial(material)
  return structuredClone(material)
}
function revisionReceipt(value: unknown, requestId: string): ReturnedRevisionReceipt | undefined {
  const envelope = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  const data = envelope?.data && typeof envelope.data === 'object' && !Array.isArray(envelope.data) ? envelope.data as Record<string, unknown> : envelope
  if (!data || data.requestId !== requestId || typeof data.bindingId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.bindingId)
    || typeof data.newVersionDigest !== 'string' || !/^[0-9a-f]{64}$/.test(data.newVersionDigest)
    || (data.state !== 'prepared' && data.state !== 'resumed' && data.state !== 'resume_unknown')
    || data.repeated !== true) return undefined
  return { requestId, bindingId: data.bindingId, newVersionDigest: data.newVersionDigest, state: data.state, repeated: true }
}
function restoreRevisionMaterial(file: FrozenRevisionFile | LegacyFrozenRevisionFile): FrozenMaterial {
  if ('extraction' in file && file.extraction) return normalizeFrozenMaterial(file)
  const bytes = Buffer.from(file.bytesBase64, 'base64')
  if (bytes.toString('base64') !== file.bytesBase64 || bytes.length !== file.bytes || digest(bytes) !== file.sha256) {
    throw new Error('本地固定材料包无法通过字节摘要校验，请勿重新读取文件')
  }
  try { new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  catch { throw new Error('本地固定材料不是有效的 UTF-8 文本') }
  return makeFrozenTextMaterial(file.name, bytes)
}
function revisionReceiptResult(receipt: ReturnedRevisionReceipt, files: Array<{ name: string }>, receiptConfirmed = true): Record<string, unknown> {
  const message = receipt.state === 'resumed'
    ? 'Forge 已确认修订材料递交，原审批已进入下一轮。'
    : receipt.state === 'prepared'
      ? receiptConfirmed ? 'Forge 已固定修订材料，但原审批是否继续尚未确认；请刷新待办核对。' : '上次 Forge 回执显示修订材料已固定，但当前无法刷新；审批是否继续仍未确认。'
      : 'Forge 修订请求状态尚未确认，桌面只查询了原回执，没有重提；请在 Forge 核对。'
  return {
    status: receipt.state, submitted: receipt.state === 'resumed', receiptConfirmed,
    message, materials: files.map((file) => ({ name: file.name })),
  }
}

export class AgentEnterpriseBridge extends CapabilityBridge {
  protected readonly rateLimit = 60
  protected readonly rateLimitError = '企业团队交接请求过于频繁，请稍后重试'
  private readonly teams = new Map<string, Map<string, TeamSummary>>()
  /** The person's own client sessions listed in this conversation, by the number shown. */
  private readonly clientSessions = new Map<string, Map<string, { id: string; client: string; createdAt: string }>>()
  private readonly handoffs = new Map<string, Map<string, EnterpriseWorkChoice>>()
  private readonly businessActions = new Map<string, Map<string, Map<string, EnterpriseBusinessCapability>>>()
  private readonly businessObjects = new Map<string, Map<string, ScopedBusinessObject>>()
  private readonly creationReferences = new Map<string, Map<string, VerifiedCreationReference>>()
  private readonly businessRecords = new Map<string, Map<string, ScopedBusinessRecord>>()
  private readonly runtimes = new Map<string, string>()
  private readonly pendingRuntimeTokens = new Map<string, string>()
  private readonly pendingFirstPrompts = new Set<string>()
  private readonly newSessionTokens = new Set<string>()
  private readonly turns = new Map<string, EmployeeTurn>()
  private readonly sessionBindingWaiters = new Map<string, Set<() => void>>()
  private readonly inputs = new Map<string, symbol>()
  private readonly pendingApprovalContextBinds = new Map<string, symbol>()
  private readonly inFlight = new Map<string, Promise<unknown>>()
  private readonly revisionInFlight = new Map<string, Promise<unknown>>()
  private readonly pendingApprovalContexts = new Map<string, PendingApprovalContext>()
  private readonly approvalContexts = new Map<string, BoundApprovalContext>()
  private readonly currentItemActionRefs = new Map<string, Map<string, BoundCurrentItemAction>>()
  private readonly currentItemActionAttempts = new Map<string, Map<string, CurrentItemActionAttempt>>()
  private readonly pendingWorkContinuations = new Map<string, PendingWorkContinuation>()
  private readonly pendingEmployeeBusiness = new Map<string, PendingEmployeeBusinessContext>()
  /** Source lineage survives employee prompts in this Pi session; it grants no write capabilities. */
  private readonly workLineages = new Map<string, BoundWorkContinuation>()
  private readonly workContinuations = new Map<string, BoundWorkContinuation>()
  private readonly store: HandoffStore
  private employeeBusiness?: Promise<EmployeeBusinessActions>
  private businessInputs?: Promise<EmployeeBusinessInputs>
  private inputSources() {
    this.businessInputs ??= import('./employee-business-inputs').then(({ EmployeeBusinessInputs }) => new EmployeeBusinessInputs(this.store))
    return this.businessInputs
  }
  private async rememberBusinessInput(claim: CapabilityClaim, turn: EmployeeTurn, transcript: TranscriptMessage[]) {
    if (!claim.sessionPath || !turn.capturedEmployeeInput || turn.openingEmployeeBusiness || turn.openingWorkContinuation
      || turn.openingReturnedApproval || turn.businessNotification || turn.employeePrompt.includes(APPROVAL_REVIEW_SESSION_MARKER)) return
    if (this.turns.get(claim.token) !== turn || this.claimForToken(claim.token) !== claim || await this.options.service.accountKey() !== turn.accountKey) return
    let index = transcript.length - 1
    while (index >= 0 && transcript[index].role !== 'user') index--
    const message = transcript[index]
    if (!message || turn.baseline.has(message.id) || messageText(message) !== turn.prompt) return
    await (await this.inputSources()).remember(turn.accountKey, claim.sessionPath, turn.employeePrompt, index,
      { id: message.id, role: message.role, text: messageText(message) })
  }

  constructor(private readonly options: AgentEnterpriseBridgeOptions) { super(); this.store = new HandoffStore(options.storage) }
  private employeeBusinessActions(): Promise<EmployeeBusinessActions> {
    this.employeeBusiness ??= import('./employee-business-actions').then(({ EmployeeBusinessActions }) => new EmployeeBusinessActions({
      getEmployeeBusinessContext: (selection) => { if (!this.options.service.getEmployeeBusinessContext) throw new Error('本人业务动作暂不可用'); return this.options.service.getEmployeeBusinessContext(selection) },
      executeEmployeeBusinessAction: (request) => { if (!this.options.service.executeEmployeeBusinessAction) throw new Error('本人业务动作暂不可用'); return this.options.service.executeEmployeeBusinessAction(request) },
      getEmployeeBusinessOperation: (key) => { if (!this.options.service.getEmployeeBusinessOperation) throw new Error('本人业务回执暂不可用'); return this.options.service.getEmployeeBusinessOperation(key) },
      stageWorkMaterials: (materials, assertCurrent, progress) => this.options.service.stageWorkMaterials(materials, assertCurrent, progress),
    }, this.store))
    return this.employeeBusiness
  }
  protected environmentEntries(url: string, token: string): NodeJS.ProcessEnv {
    return { GOOEYPI_ENTERPRISE_URL: url, GOOEYPI_ENTERPRISE_TOKEN: token, GOOEYPI_ENTERPRISE_EXTENSION_PATH: this.options.extensionPath }
  }
  protected onClaimRevoked(claim: CapabilityClaim): void {
    this.teams.delete(claim.token); this.clientSessions.delete(claim.token); this.handoffs.delete(claim.token); this.businessActions.delete(claim.token); this.businessObjects.delete(claim.token); this.businessRecords.delete(claim.token); this.creationReferences.delete(claim.token); this.turns.delete(claim.token); this.inputs.delete(claim.token); this.pendingApprovalContextBinds.delete(claim.token); this.approvalContexts.delete(claim.token); this.currentItemActionRefs.delete(claim.token); this.currentItemActionAttempts.delete(claim.token); this.workContinuations.delete(claim.token); this.workLineages.delete(claim.token)
    this.pendingFirstPrompts.delete(claim.token)
    this.newSessionTokens.delete(claim.token)
    this.notifySessionBinding(claim.token)
    for (const [runtime, token] of this.runtimes) if (token === claim.token) this.runtimes.delete(runtime)
    for (const [runtime, token] of this.pendingRuntimeTokens) if (token === claim.token) this.pendingRuntimeTokens.delete(runtime)
  }
  async pinReturnedApprovalContext(requestId: string): Promise<{ handle: string; context: EnterpriseApprovalContextView }> {
    if (!requestId || requestId.length > 128) throw new Error('退回事项上下文无效，请刷新待办')
    return this.pinApprovalContext(requestId, 'revision')
  }
  async pinEmployeeBusinessContext(record: EmployeeBusinessRecord) {
    const { prepareEmployeeBusinessOpen } = await import('./employee-business-open')
    const { pending, prompt } = await prepareEmployeeBusinessOpen(this.employeeBusinessAccess(), record)
    for (const [key, value] of this.pendingEmployeeBusiness) if (Date.now() - value.createdAt > 10 * 60_000) this.pendingEmployeeBusiness.delete(key)
    const handle = randomUUID(); this.pendingEmployeeBusiness.set(handle, pending)
    return { handle, prompt }
  }
  private employeeBusinessAccess() {
    return {
      accountKey: () => this.options.service.accountKey(),
      getEmployeeBusinessContext: (selection: import('../../../src/types/employee-business').EmployeeBusinessSelection) => { if (!this.options.service.getEmployeeBusinessContext) throw new Error('本人业务动作暂不可用'); return this.options.service.getEmployeeBusinessContext(selection) },
      readBusinessRecord: (objectName: string, recordId: string) => this.options.service.readBusinessRecord(objectName, recordId),
    }
  }
  async pinApprovalReviewContext(requestId: string): Promise<{ handle: string; context: EnterpriseApprovalContextView }> {
    if (!requestId || requestId.length > 128) throw new Error('审批事项上下文无效，请刷新待办')
    return this.pinApprovalContext(requestId, 'review')
  }
  private async pinApprovalContext(requestId: string, purpose: ApprovalContextPurpose): Promise<{ handle: string; context: EnterpriseApprovalContextView }> {
    const accountBefore = await this.options.service.accountKey()
    const context = await this.options.service.getApprovalContext(requestId)
    assertApprovalReviewContext(context, requestId)
    const accountAfter = await this.options.service.accountKey()
    if (accountBefore !== accountAfter) throw new Error('当前账号已变化，请重新打开审批事项')
    if (purpose === 'revision') assertReturnedApproval(context, requestId)
    const now = Date.now()
    for (const [handle, pending] of this.pendingApprovalContexts) if (now - pending.createdAt > 10 * 60_000) this.pendingApprovalContexts.delete(handle)
    const handle = randomUUID()
    this.pendingApprovalContexts.set(handle, { purpose, accountKey: accountAfter, context: structuredClone(context), fingerprint: returnedApprovalFingerprint(context), createdAt: now })
    return { handle, context: approvalContextView(context) }
  }
  private async persistApprovalReviewSession(context: BoundApprovalContext): Promise<void> {
    if (!this.options.storage?.directory) throw new Error('审批辅助会话无法安全保存绑定，请先恢复桌面交接存储')
    const metadata = approvalReviewSessionMetadata(context.accountKey, context.sessionPath, context.context)
    const fingerprint = digest(JSON.stringify(metadata))
    await this.store.checkpoint(approvalReviewSessionKey(context.accountKey, context.sessionPath), fingerprint, metadata)
  }
  private async restoreApprovalReviewSession(accountKey: string, sessionPath: string): Promise<BoundApprovalContext | undefined> {
    const key = approvalReviewSessionKey(accountKey, sessionPath)
    const saved = await this.store.inspect<ApprovalReviewSessionMetadata>(key)
    if (!saved) return undefined
    const value = saved.value
    if (value?.version !== 1 || value.purpose !== 'review' || value.accountKey !== accountKey
      || value.sessionPathDigest !== digest(canonicalSessionPath(sessionPath))
      || !value.requestId || !value.objectName || !value.recordId
      || value.status !== 'pending' && value.status !== 'returned'
      || !/^[0-9a-f]{64}$/.test(value.sourceMaterialVersion)
      || value.returnVersion !== undefined && !value.returnVersion) {
      throw new Error('审批辅助会话绑定无效，请从本人事项重新打开')
    }
    const context = await this.options.service.getApprovalContext(value.requestId)
    assertApprovalReviewContext(context, value.requestId)
    const expected = approvalReviewSessionMetadata(accountKey, sessionPath, context)
    if (JSON.stringify(expected) !== JSON.stringify(value) || digest(JSON.stringify(expected)) !== saved.fingerprint
      || await this.options.service.accountKey() !== accountKey) {
      throw new Error('审批事项或材料快照已变化，请从本人事项重新打开')
    }
    return {
      purpose: 'review', accountKey, context, fingerprint: returnedApprovalFingerprint(context),
      createdAt: Date.now(), sessionPath,
    }
  }
  async pinWorkContinuationContext(item: Pick<EnterpriseWorkItem, 'id' | 'notificationType' | 'workReference' | 'runReference' | 'sessionReference'> & { source: 'weave' }): Promise<{ handle: string; context: Extract<EnterpriseWorkContinuationContextView, { kind: 'weave' }> }>
  async pinWorkContinuationContext(item: Pick<EnterpriseWorkItem, 'id' | 'notificationType' | 'workReference' | 'runReference' | 'sessionReference'> & { source: 'forge' }): Promise<{ handle: string; context: EnterpriseBusinessNotificationContextView }>
  async pinWorkContinuationContext(item: Pick<EnterpriseWorkItem, 'id' | 'source' | 'notificationType' | 'workReference' | 'runReference' | 'sessionReference'>): Promise<{ handle: string; context: EnterpriseWorkContinuationContextView }> {
    if (!item?.id) throw new Error('工作消息无效，请刷新工作列表')
    const accountBefore = await this.options.service.accountKey()
    if (item.source === 'forge') {
      const context = await this.options.service.getBusinessNotificationContext(item.id)
      if (context.notificationID !== item.id || context.kind !== 'business') throw new Error('Forge 业务结果来源与当前消息不匹配')
      const view = await businessNotificationContextView(context)
      const accountAfter = await this.options.service.accountKey()
      if (accountBefore !== accountAfter) throw new Error('当前账号已变化，请重新打开业务结果消息')
      const now = Date.now()
      for (const [handle, pending] of this.pendingWorkContinuations) if (now - pending.createdAt > 10 * 60_000) this.pendingWorkContinuations.delete(handle)
      const handle = randomUUID()
      this.pendingWorkContinuations.set(handle, {
        kind: 'business', accountKey: accountAfter, context,
        fingerprint: businessNotificationFingerprint(context), createdAt: now,
      })
      return { handle, context: view }
    }
    if (item.source !== 'weave') throw new Error('当前消息不是可续接的工作结果')
    let references = { workReference: item.workReference ?? '', runReference: item.runReference ?? '', sessionReference: item.sessionReference ?? '' }
    if (item.notificationType === WORKBENCH_RUN_CONTINUATION_TYPE) {
      if (!this.options.service.getRunContinuationReferences) throw new Error('当前平台尚未接通原运行续办，请刷新工作列表')
      references = await this.options.service.getRunContinuationReferences(item.id)
      if (references.runReference !== item.id) throw new Error('原运行来源不匹配，请刷新工作列表')
    }
    const hasAllReferences = Boolean(references.workReference && references.runReference && references.sessionReference)
    if (!hasAllReferences) {
      const teamRunType = /^weave\.team_run\.(result|failure|revision_required|cancelled)$/.exec(item.notificationType ?? '')
      if (!teamRunType) throw new Error('工作消息缺少原工作引用，桌面无法安全继续')
      const source = await this.options.service.getWorkNotificationSource(item.id)
      if (source.kind === 'business' || source.notificationID !== item.id || source.kind !== teamRunType[1]
        || item.workReference && item.workReference !== source.source.workReference
        || item.runReference && item.runReference !== source.source.runReference
        || item.sessionReference && item.sessionReference !== source.source.sessionReference) {
        throw new Error('Forge 工作消息来源与当前通知不匹配，请刷新工作列表')
      }
      references = { ...source.source }
    }
    const context = await this.options.service.getWorkContinuationContext(references)
    if (context.source.inputRevisionID !== references.workReference || context.source.runID !== references.runReference
      || context.source.workbenchSessionID !== references.sessionReference) throw new Error('工作消息与原团队工作不匹配，请刷新工作消息')
    const accountAfter = await this.options.service.accountKey()
    if (accountBefore !== accountAfter) throw new Error('当前账号已变化，请重新打开工作消息')
    const materials = context.input.materials.map((material) => {
      if (!material.content || !material.mediaType) throw new Error('原工作包含固定材料，但没有取得经核验的原文，桌面不会仅凭文件引用继续')
      return {
        name: material.name, bytes: material.bytes, sha256: material.sha256, content: material.content,
        ...(material.extraction ? { extraction: { status: material.extraction.status, limitations: [...material.extraction.limitations] } } : {}),
      }
    })
    const now = Date.now()
    for (const [handle, pending] of this.pendingWorkContinuations) if (now - pending.createdAt > 10 * 60_000) this.pendingWorkContinuations.delete(handle)
    const handle = randomUUID()
    const fingerprint = workContinuationFingerprint(context)
    this.pendingWorkContinuations.set(handle, { kind: 'weave', accountKey: accountAfter, context, fingerprint, createdAt: now })
    return {
      handle,
      context: {
        kind: 'weave',
        task: context.input.task,
        runStatus: context.run.status,
        ...(context.run.authorization ? { authorization: { status: context.run.authorization.status, canRenew: context.run.authorization.canRenew, ...(context.run.authorization.reason ? { reason: context.run.authorization.reason } : {}) } } : {}),
        ...(context.source.inputStatus ? { inputStatus: context.source.inputStatus } : {}),
        ...(context.run.businessResult ? { businessResult: context.run.businessResult } : {}),
        materials,
        ...(context.run.finalResult ? { finalResult: {
          title: context.run.finalResult.title, contentType: context.run.finalResult.contentType, content: context.run.finalResult.content,
          ...(context.run.finalResult.disposition ? { disposition: context.run.finalResult.disposition } : {}),
          ...(context.run.finalResult.summary !== undefined ? { summary: context.run.finalResult.summary } : {}),
          ...(context.run.finalResult.missingItems !== undefined ? { missingItems: [...context.run.finalResult.missingItems] } : {}),
        } } : {}),
        ...(context.run.actionOutcomes !== undefined ? {
          actionOutcomes: context.run.actionOutcomes.map(({ actionName, objectName, status, summary }) => ({ actionName, objectName, status, summary: projectWorkActionFact({ actionName, status, summary }).summary })),
        } : {}),
      },
    }
  }
  bindSession(token: string | undefined, sessionFile: string | undefined, runtimeId?: string): void {
    if (!token) return
    const claim = this.claimForToken(token)
    if (!claim) {
      if (runtimeId) {
        this.runtimes.delete(runtimeId)
        this.pendingRuntimeTokens.delete(runtimeId)
      }
      return
    }
    if (runtimeId && !claim.sessionPath) this.newSessionTokens.add(token)
    if (runtimeId && !sessionFile) {
      this.runtimes.set(runtimeId, token)
      if (!claim.sessionPath) {
        this.pendingRuntimeTokens.set(runtimeId, token)
        this.pendingFirstPrompts.add(token)
      }
      return
    }
    if (!sessionFile) return
    if (claim.sessionPath && canonicalSessionPath(claim.sessionPath) !== canonicalSessionPath(sessionFile)) {
      this.revoke(token)
      throw new Error('桌面会话文件与授权会话不匹配，企业能力已失效')
    }
    if (claim && !claim.sessionPath) claim.sessionPath = sessionFile
    if (claim && runtimeId) {
      this.runtimes.set(runtimeId, token)
      this.pendingRuntimeTokens.delete(runtimeId)
      this.pendingFirstPrompts.delete(token)
      this.notifySessionBinding(token)
    }
  }
  bindRuntimeSession(runtimeId: string, sessionFile: string): void {
    const token = this.pendingRuntimeTokens.get(runtimeId) ?? this.runtimes.get(runtimeId)
    if (token) this.bindSession(token, sessionFile, runtimeId)
  }
  private notifySessionBinding(token: string): void {
    const waiters = this.sessionBindingWaiters.get(token)
    if (!waiters) return
    this.sessionBindingWaiters.delete(token)
    for (const wake of waiters) wake()
  }
  private async waitForSessionBinding(claim: CapabilityClaim, turn: EmployeeTurn): Promise<void> {
    if (claim.sessionPath) return
    if (!turn.pendingSessionPrompts) throw new Error('企业团队能力尚未绑定到当前桌面会话')
    await new Promise<void>((resolveWait) => {
      let settled = false
      let timer: NodeJS.Timeout
      const waiters = this.sessionBindingWaiters.get(claim.token) ?? new Set<() => void>()
      const wake = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        waiters.delete(wake)
        if (!waiters.size) this.sessionBindingWaiters.delete(claim.token)
        resolveWait()
      }
      timer = setTimeout(wake, 2_000)
      this.sessionBindingWaiters.set(claim.token, waiters)
      waiters.add(wake)
      if (claim.sessionPath || this.claimForToken(claim.token) !== claim || this.turns.get(claim.token) !== turn) wake()
    })
    if (this.claimForToken(claim.token) !== claim || this.turns.get(claim.token) !== turn
      || await this.options.service.accountKey() !== turn.accountKey) throw new Error('员工轮次或账号已变化，请按当前要求重新处理')
    if (!claim.sessionPath) throw new Error('桌面会话文件尚未绑定，请在会话准备完成后重试')
  }
  invalidateHandoff(runtimeId: string): void {
    const token = this.runtimes.get(runtimeId) ?? this.pendingRuntimeTokens.get(runtimeId)
    if (!token) return
    this.pendingRuntimeTokens.delete(runtimeId)
    this.pendingFirstPrompts.delete(token)
    this.pendingApprovalContextBinds.delete(token)
    this.inputs.set(token, Symbol())
    this.turns.delete(token); this.teams.delete(token); this.clientSessions.delete(token); this.handoffs.delete(token); this.businessActions.delete(token); this.businessObjects.delete(token); this.businessRecords.delete(token); this.creationReferences.delete(token); this.workContinuations.delete(token)
    this.notifySessionBinding(token)
  }
  invalidateAccount(): void {
    this.revokeAllClaims()
    this.turns.clear(); this.inputs.clear(); this.pendingApprovalContextBinds.clear(); this.teams.clear(); this.handoffs.clear(); this.businessActions.clear(); this.businessObjects.clear(); this.businessRecords.clear(); this.creationReferences.clear(); this.currentItemActionRefs.clear(); this.currentItemActionAttempts.clear()
    this.pendingApprovalContexts.clear(); this.approvalContexts.clear()
    this.pendingEmployeeBusiness.clear()
    this.pendingWorkContinuations.clear(); this.workContinuations.clear(); this.workLineages.clear()
  }
  /** Called only by the trusted desktop input path, before forwarding to the runtime. */
  async employeeCommand(runtimeId: unknown, command: unknown, returnedApprovalContextHandle?: unknown, workContinuationContextHandle?: unknown, approvalReviewContextHandle?: unknown, employeeInput?: unknown): Promise<void> {
    const value = command as { type?: string; message?: string } | null
    if (!value || !['prompt', 'steer', 'follow_up', 'abort', 'compact'].includes(value.type ?? '')) {
      if (returnedApprovalContextHandle !== undefined || workContinuationContextHandle !== undefined || approvalReviewContextHandle !== undefined) throw new Error('企业工作上下文只能绑定到桌面工作提示')
      return
    }
    const token = typeof runtimeId === 'string'
      ? this.runtimes.get(runtimeId) ?? this.pendingRuntimeTokens.get(runtimeId)
      : undefined
    if (!token) {
      if (returnedApprovalContextHandle !== undefined || workContinuationContextHandle !== undefined || approvalReviewContextHandle !== undefined) throw new Error('企业工作上下文未绑定到当前桌面会话')
      return
    }
    if (this.pendingApprovalContextBinds.has(token)) throw new Error('审批事项正在新会话中打开，请等待后重试')
    const priorTurn = this.turns.get(token), priorClaim = this.claimForToken(token)
    if (priorTurn && priorClaim?.sessionPath && priorClaim.harness && await this.options.service.accountKey() === priorTurn.accountKey) {
      await this.rememberBusinessInput(priorClaim, priorTurn, await this.options.sessions[priorClaim.harness].read(priorClaim.sessionPath))
    }
    const previousWorkLineage = this.workLineages.get(token)
    const previousApprovalContext = this.approvalContexts.get(token)
    const marker = Symbol()
    this.inputs.set(token, marker)
    this.turns.delete(token); this.teams.delete(token); this.clientSessions.delete(token); this.handoffs.delete(token); this.businessActions.delete(token); this.businessObjects.delete(token); this.businessRecords.delete(token); this.creationReferences.delete(token); this.currentItemActionRefs.delete(token); this.currentItemActionAttempts.delete(token); this.workContinuations.delete(token)
    this.notifySessionBinding(token)
    const claim = this.claimForToken(token)
    if (!claim?.harness || typeof value.message !== 'string') {
      if (returnedApprovalContextHandle !== undefined || workContinuationContextHandle !== undefined || approvalReviewContextHandle !== undefined) throw new Error('企业工作上下文未绑定到当前桌面会话')
      return
    }
    const pathPending = !claim.sessionPath
    const capturedInput = (await import('./employee-input')).captureEmployeeInput(value.message, employeeInput, claim)
    if (pathPending && (value.type !== 'prompt' || !this.pendingFirstPrompts.has(token))) {
      if (returnedApprovalContextHandle !== undefined || workContinuationContextHandle !== undefined || approvalReviewContextHandle !== undefined) throw new Error('企业工作上下文未绑定到当前桌面会话')
      return
    }
    if (pathPending) this.pendingFirstPrompts.delete(token)
    const suppliedContexts = [returnedApprovalContextHandle, workContinuationContextHandle, approvalReviewContextHandle].filter((handle) => handle !== undefined)
    if (suppliedContexts.length > 1) throw new Error('当前 Pi 提示不能同时绑定两项企业工作')
    if (previousApprovalContext && suppliedContexts.length > 0) {
      throw new Error('审批会话不能切换或升级为其他企业事项，请从本人事项重新打开')
    }
    let pendingApprovalContext: PendingApprovalContext | undefined
    let approvalContextHandle: string | undefined
    let pendingWorkContinuation: PendingWorkContinuation | undefined
    let pendingEmployeeBusiness: PendingEmployeeBusinessContext | undefined
    let workHandle: string | undefined
    const suppliedApprovalHandle = returnedApprovalContextHandle ?? approvalReviewContextHandle
    if (suppliedApprovalHandle !== undefined) {
      if (!claim.sessionPath || value.type !== 'prompt' || typeof suppliedApprovalHandle !== 'string' || suppliedApprovalHandle.length < 20 || suppliedApprovalHandle.length > 128) {
        throw new Error('审批事项上下文只能绑定到新的桌面会话')
      }
      approvalContextHandle = suppliedApprovalHandle
      pendingApprovalContext = this.pendingApprovalContexts.get(approvalContextHandle)
      if (!pendingApprovalContext || Date.now() - pendingApprovalContext.createdAt > 10 * 60_000) {
        this.pendingApprovalContexts.delete(approvalContextHandle)
        throw new Error('审批上下文已过期，请重新打开本人待办')
      }
      if (returnedApprovalContextHandle !== undefined && pendingApprovalContext.purpose !== 'revision'
        || approvalReviewContextHandle !== undefined && pendingApprovalContext.purpose !== 'review') {
        throw new Error('审批上下文用途与当前事项不匹配')
      }
      if (!this.newSessionTokens.has(token)) throw new Error('审批事项必须在独立的新会话中打开')
    }
    if (workContinuationContextHandle !== undefined) {
      if (!claim.sessionPath || value.type !== 'prompt' || typeof workContinuationContextHandle !== 'string' || workContinuationContextHandle.length < 20 || workContinuationContextHandle.length > 128) {
        throw new Error('团队工作上下文与当前会话不匹配')
      }
      workHandle = workContinuationContextHandle
      pendingEmployeeBusiness = this.pendingEmployeeBusiness.get(workHandle)
      pendingWorkContinuation = this.pendingWorkContinuations.get(workHandle)
      if ((!pendingWorkContinuation && !pendingEmployeeBusiness) || Date.now() - (pendingWorkContinuation ?? pendingEmployeeBusiness)!.createdAt > 10 * 60_000) {
        this.pendingWorkContinuations.delete(workHandle)
        throw new Error('团队工作上下文已过期，请重新打开工作消息')
      }
      if ((pendingEmployeeBusiness || pendingWorkContinuation?.kind === 'business') && !this.newSessionTokens.has(token)) {
        throw new Error('Forge 业务结果须在独立的新会话中打开')
      }
    }
    const requiresApprovalContextBind = Boolean(pendingApprovalContext || previousApprovalContext)
    if (requiresApprovalContextBind) this.pendingApprovalContextBinds.set(token, marker)
    let approvalReviewSessionDetected = false
    try {
      let activeWorkContinuation: BoundWorkContinuation | undefined
      let activeBusinessNotification: BoundBusinessNotificationContext | undefined
      const accountKey = await this.options.service.accountKey()
      if (pendingEmployeeBusiness) {
        const { verifyEmployeeBusinessOpen } = await import('./employee-business-open')
        await verifyEmployeeBusinessOpen(this.employeeBusinessAccess(), pendingEmployeeBusiness, value.message)
      }
      let activeApprovalContext = previousApprovalContext
      if (pendingApprovalContext) {
        if (pendingApprovalContext.accountKey !== accountKey) throw new Error('当前账号已变化，不能打开该审批上下文')
        const currentContext = await this.options.service.getApprovalContext(pendingApprovalContext.context.requestId)
        assertApprovalReviewContext(currentContext, pendingApprovalContext.context.requestId)
        if (pendingApprovalContext.purpose === 'revision') assertReturnedApproval(currentContext, pendingApprovalContext.context.requestId)
        if (returnedApprovalFingerprint(currentContext) !== pendingApprovalContext.fingerprint
          || await this.options.service.accountKey() !== accountKey) {
          throw new Error(pendingApprovalContext.purpose === 'revision'
            ? '退回意见或材料版本已变化，请重新打开待办'
            : '审批事项或材料快照已变化，请重新打开本人待办')
        }
        activeApprovalContext = { ...pendingApprovalContext, context: structuredClone(currentContext), sessionPath: claim.sessionPath! }
      } else if (previousApprovalContext) {
        if (previousApprovalContext.accountKey !== accountKey || previousApprovalContext.sessionPath !== claim.sessionPath) {
          throw new Error('审批会话与当前账号或事项不匹配')
        }
        const currentContext = await this.options.service.getApprovalContext(previousApprovalContext.context.requestId)
        assertApprovalReviewContext(currentContext, previousApprovalContext.context.requestId)
        if (previousApprovalContext.purpose === 'revision') assertReturnedApproval(currentContext, previousApprovalContext.context.requestId)
        if (returnedApprovalFingerprint(currentContext) !== previousApprovalContext.fingerprint
          || await this.options.service.accountKey() !== accountKey) {
          throw new Error(previousApprovalContext.purpose === 'revision'
            ? '退回意见或材料版本已变化，请重新打开待办'
            : '审批事项或材料快照已变化，请重新打开本人待办')
        }
      }
      if (pendingWorkContinuation) {
        if (pendingWorkContinuation.accountKey !== accountKey) throw new Error('当前账号已变化，团队工作不能继续')
        if (pendingWorkContinuation.kind === 'weave') {
          const source = pendingWorkContinuation.context.source
          const currentContext = await this.options.service.getWorkContinuationContext({
            workReference: source.inputRevisionID, runReference: source.runID, sessionReference: source.workbenchSessionID,
          })
          if (workContinuationFingerprint(currentContext) !== pendingWorkContinuation.fingerprint
            || await this.options.service.accountKey() !== accountKey) {
            throw new Error('团队工作或固定材料版本已变化，请刷新工作消息后重新继续')
          }
          pendingWorkContinuation.context.run.status = currentContext.run.status
          if (!claim.sessionPath) throw new Error('团队工作上下文未绑定到当前 Pi 会话')
          activeWorkContinuation = { ...pendingWorkContinuation, sessionPath: claim.sessionPath }
        } else {
          const currentContext = await this.options.service.getBusinessNotificationContext(pendingWorkContinuation.context.notificationID)
          if (businessNotificationFingerprint(currentContext) !== pendingWorkContinuation.fingerprint
            || await this.options.service.accountKey() !== accountKey) {
            throw new Error('Forge 当前记录或材料版本已变化，请刷新工作消息后重新打开')
          }
          if (!claim.sessionPath) throw new Error('Forge 业务结果上下文未绑定到当前 Pi 会话')
          activeBusinessNotification = { ...pendingWorkContinuation, context: currentContext, sessionPath: claim.sessionPath }
        }
      } else if (!pendingApprovalContext && !activeApprovalContext && previousWorkLineage && previousWorkLineage.accountKey === accountKey
        && previousWorkLineage.sessionPath === claim.sessionPath) {
        activeWorkContinuation = previousWorkLineage
      }
      const newSessionFirstPrompt = this.newSessionTokens.has(token) && value.type === 'prompt'
      const pendingSessionPrompts = pathPending || newSessionFirstPrompt ? [value.message.trim()] : undefined
      let messages: TranscriptMessage[] = []
      if (claim.sessionPath) {
        try { messages = await this.options.sessions[claim.harness].read(claim.sessionPath) }
        catch (error) {
          if (!(newSessionFirstPrompt && (error as NodeJS.ErrnoException)?.code === 'ENOENT')) throw error
          // Pi may report the future session path before creating its file.
          // This is only allowed for a runtime started without a resume path.
        }
      }
      let hasApprovalReviewMarker = messages.some((message) => message.role === 'user' && messageText(message).includes(APPROVAL_REVIEW_SESSION_MARKER))
        || pendingApprovalContext?.purpose === 'review' && value.message.includes(APPROVAL_REVIEW_SESSION_MARKER)
      approvalReviewSessionDetected = hasApprovalReviewMarker || previousApprovalContext?.purpose === 'review' || pendingApprovalContext?.purpose === 'review'
      if (pendingApprovalContext?.purpose === 'review'
        && (messages.some((message) => message.role === 'user') || !value.message.includes(APPROVAL_REVIEW_SESSION_MARKER))) {
        throw new Error('审批辅助必须在没有其他事项历史的新会话中打开')
      }
      if (pendingWorkContinuation?.kind === 'business' && (value.type !== 'prompt' || messages.some((message) => message.role === 'user'))) {
        throw new Error('Forge 业务结果必须在没有其他事项历史的新会话中打开')
      }
      if (!pendingApprovalContext && !previousApprovalContext && claim.sessionPath) {
        const restored = await this.restoreApprovalReviewSession(accountKey, claim.sessionPath)
        if (restored) {
          activeApprovalContext = restored
          approvalReviewSessionDetected = true
          hasApprovalReviewMarker ||= true
        } else if (hasApprovalReviewMarker) {
          throw new Error('审批辅助会话绑定已丢失，请从本人事项重新打开')
        }
      }
      if (activeApprovalContext?.purpose === 'review' && !hasApprovalReviewMarker) {
        throw new Error('审批辅助会话标记已丢失，请从本人事项重新打开')
      }
      const employeeInputMarkersCurrent = () => {
        const currentToken = typeof runtimeId === 'string'
          ? this.runtimes.get(runtimeId) ?? this.pendingRuntimeTokens.get(runtimeId)
          : undefined
        return this.inputs.get(token) === marker
          && (!requiresApprovalContextBind || this.pendingApprovalContextBinds.get(token) === marker)
          && this.claimForToken(token) === claim && currentToken === token
      }
      const assertEmployeeInputMarkersCurrent = () => {
        if (!employeeInputMarkersCurrent()) {
          throw new Error('员工账号或轮次已变化，审批辅助上下文没有绑定到新会话')
        }
      }
      const assertEmployeeInputCurrent = async () => {
        const currentAccountKey = await this.options.service.accountKey()
        assertEmployeeInputMarkersCurrent()
        if (currentAccountKey !== accountKey) {
          throw new Error('员工账号或轮次已变化，审批辅助上下文没有绑定到新会话')
        }
      }
      if (employeeInputMarkersCurrent()) {
        let boundWorkContinuation: BoundWorkContinuation | undefined
        if (pendingApprovalContext) {
          if (!activeApprovalContext || !claim.sessionPath || this.claimForToken(token) !== claim) throw new Error('审批上下文已失效，请重新打开待办')
          if (requiresApprovalContextBind) await assertEmployeeInputCurrent()
          if (pendingApprovalContext.purpose === 'review') {
            await this.persistApprovalReviewSession(activeApprovalContext)
            await assertEmployeeInputCurrent()
          }
          if (requiresApprovalContextBind && (this.inputs.get(token) !== marker
            || this.pendingApprovalContextBinds.get(token) !== marker || this.claimForToken(token) !== claim
            || (this.runtimes.get(String(runtimeId)) ?? this.pendingRuntimeTokens.get(String(runtimeId))) !== token)) {
            throw new Error('员工账号或轮次已变化，审批辅助上下文没有绑定到新会话')
          }
          if (requiresApprovalContextBind) this.pendingApprovalContextBinds.delete(token)
          this.approvalContexts.set(token, activeApprovalContext)
          this.workContinuations.delete(token)
          this.workLineages.delete(token)
          this.pendingApprovalContexts.delete(approvalContextHandle!)
        }
        if (previousApprovalContext && !pendingApprovalContext) {
          await assertEmployeeInputCurrent()
          assertEmployeeInputMarkersCurrent()
        }
        if (pendingWorkContinuation?.kind === 'weave') {
          if (!claim.sessionPath || this.claimForToken(token) !== claim) throw new Error('团队工作上下文已失效，请重新打开工作消息')
          boundWorkContinuation = activeWorkContinuation
          if (!boundWorkContinuation) throw new Error('团队工作上下文已失效，请重新打开工作消息')
          this.workLineages.set(token, boundWorkContinuation)
          this.pendingWorkContinuations.delete(workHandle!)
        } else if (pendingWorkContinuation?.kind === 'business') {
          if (!claim.sessionPath || this.claimForToken(token) !== claim || !activeBusinessNotification) throw new Error('Forge 业务结果上下文已失效，请重新打开消息')
          await (await this.employeeBusinessActions()).bind(accountKey, claim.sessionPath, {
            record: { objectName: activeBusinessNotification.context.source.objectName, recordId: activeBusinessNotification.context.source.recordId, label: activeBusinessNotification.context.record.candidate.name },
            source: { kind: 'business_notification', reference: activeBusinessNotification.context.notificationID },
          }, true)
          this.workContinuations.delete(token)
          this.workLineages.delete(token)
          this.pendingWorkContinuations.delete(workHandle!)
        } else if (pendingApprovalContext) {
          this.workLineages.delete(token)
        } else if (activeWorkContinuation) {
          this.workLineages.set(token, activeWorkContinuation)
          boundWorkContinuation = activeWorkContinuation
        } else {
          this.workLineages.delete(token)
        }
        if (boundWorkContinuation) {
          this.workContinuations.set(token, boundWorkContinuation)
        }
        this.pendingFirstPrompts.delete(token)
        if (pendingEmployeeBusiness) {
          if (!claim.sessionPath || this.claimForToken(token) !== claim) throw new Error('本人业务事项会话已失效')
          await (await this.employeeBusinessActions()).bind(accountKey, claim.sessionPath, pendingEmployeeBusiness.selection, true)
          this.pendingEmployeeBusiness.delete(workHandle!)
        }
        this.newSessionTokens.delete(token)
        if (activeApprovalContext) this.approvalContexts.set(token, activeApprovalContext)
        this.turns.set(token, {
          key: randomUUID(), prompt: value.message.trim(), employeePrompt: capturedInput.text, accountKey,
          ...(employeeInput !== undefined ? { capturedEmployeeInput: true } : {}),
          baseline: new Set(messages.filter((message) => message.role === 'user').map((message) => message.id)),
          authorizedMaterials: capturedInput.materials ?? [],
          ...(activeApprovalContext ? { approvalContext: activeApprovalContext, ...(activeApprovalContext.purpose === 'review' ? { enterpriseReadOnly: true } : {}) } : {}),
          ...(pendingSessionPrompts ? { pendingSessionPrompts } : {}),
          ...(boundWorkContinuation ? { workContinuation: boundWorkContinuation } : {}),
          ...(pendingWorkContinuation?.kind === 'weave' ? { openingWorkContinuation: true } : {}),
          ...(pendingApprovalContext?.purpose === 'revision' ? { openingReturnedApproval: true } : {}),
          ...(activeBusinessNotification ? { businessNotification: activeBusinessNotification } : {}),
          ...(pendingEmployeeBusiness ? { openingEmployeeBusiness: true } : {}),
        })
      } else if (pendingApprovalContext || previousApprovalContext || approvalReviewSessionDetected || pendingWorkContinuation) {
        throw new Error('员工轮次已变化，退回事项不能继续')
      }
    } catch (error) {
      if (pendingEmployeeBusiness) { this.pendingEmployeeBusiness.delete(workHandle!); throw error }
      if (pendingApprovalContext) {
        if (approvalContextHandle) this.pendingApprovalContexts.delete(approvalContextHandle)
        throw error
      }
      if (previousApprovalContext || approvalReviewSessionDetected) throw error
      if (pendingWorkContinuation) {
        if (workHandle) this.pendingWorkContinuations.delete(workHandle)
        throw error
      }
      /* Local work remains available without an enterprise account; handoff fails closed. */
    } finally {
      if (this.pendingApprovalContextBinds.get(token) === marker) this.pendingApprovalContextBinds.delete(token)
    }
  }
  protected async dispatch(method: string, params: Record<string, unknown>, claim: CapabilityClaim): Promise<unknown> {
    if (!claim.harness) throw new Error('企业团队能力尚未绑定到当前会话')
    const turn = this.turns.get(claim.token)
    const accountKey = await this.options.service.accountKey()
    if (!turn || this.claimForToken(claim.token) !== claim || accountKey !== turn.accountKey) throw new Error('员工轮次或账号已变化，请按当前要求重新处理')
    let approvalContextChanged = false
    if (turn.approvalContext) {
      const bound = turn.approvalContext
      if (this.approvalContexts.get(claim.token) !== bound || bound.sessionPath !== claim.sessionPath || bound.accountKey !== accountKey) {
        throw new Error('审批会话与当前员工事项不匹配，请重新打开本人待办')
      }
      let currentContext: EnterpriseApprovalContext | undefined
      try {
        currentContext = await this.options.service.getApprovalContext(bound.context.requestId)
        assertApprovalReviewContext(currentContext, bound.context.requestId)
        if (bound.purpose === 'revision') assertReturnedApproval(currentContext, bound.context.requestId)
      } catch (error) {
        if (bound.purpose !== 'review' || method !== 'run_current_item_action') throw error
        approvalContextChanged = true
      }
      if (currentContext && returnedApprovalFingerprint(currentContext) !== bound.fingerprint) {
        if (bound.purpose === 'review' && method === 'run_current_item_action') approvalContextChanged = true
        else throw new Error(bound.purpose === 'revision'
          ? '退回意见、业务对象或原材料版本已变化，请重新打开待办'
          : '审批事项或材料快照已变化，请重新打开本人待办')
      }
      if (await this.options.service.accountKey() !== accountKey) {
        throw new Error('审批事项或当前员工账号已变化，请重新打开本人待办')
      }
      if (bound.purpose === 'review' && ['submit', 'revision_submit', 'recover', 'authorization_renew'].includes(method)) {
        throw new Error('当前审批辅助会话只允许只读核对，企业交接、审批修订和恢复工具不可用')
      }
      if (bound.purpose === 'review' && !['activate', 'list_current_item_actions', 'run_current_item_action'].includes(method)) {
        throw new Error('当前审批辅助会话只能使用已固定的审批快照，不能读取或办理其他企业事项')
      }
    }
    if (turn.businessNotification) {
      const bound = turn.businessNotification
      if (bound.sessionPath !== claim.sessionPath || bound.accountKey !== accountKey) {
        throw new Error('业务结果消息与当前员工会话不匹配，请重新打开消息')
      }
      if (method !== 'activate') {
        throw new Error('打开业务结果消息只允许查看本次核验的记录与材料；请在新消息中明确提出后续需求')
      }
    }
    if (turn.openingEmployeeBusiness && method !== 'activate') throw new Error('打开本人业务事项只授权查看，请在新消息中明确办理')
    if (turn.workContinuation && (this.workContinuations.get(claim.token) !== turn.workContinuation || this.workLineages.get(claim.token) !== turn.workContinuation)) {
      throw new Error('团队工作上下文已失效，请重新打开工作消息')
    }
    if (this.turns.get(claim.token) !== turn || this.claimForToken(claim.token) !== claim) throw new Error('员工轮次或账号已变化，请按当前要求重新处理')
    if (method === 'activate') {
      if (params.prompt !== turn.prompt) throw new Error('运行时处理的员工输入与当前轮次不一致')
      return { turn_key: turn.key }
    }
    if (params.turn_key !== turn.key) throw new Error('员工要求已变化，旧交接不能继续')
    if (!claim.sessionPath) await this.waitForSessionBinding(claim, turn)
    await this.evidence(claim, turn)
    if (method === 'read_selected_material') {
      const { readSelectedWorkspaceMaterial } = await import('./workspace-material-reader')
      const material = await readSelectedWorkspaceMaterial(claim.cwd, turn.authorizedMaterials, params)
      await this.evidence(claim, turn)
      return material
    }
    if (method.startsWith('initialization_')) {
      if (turn.approvalContext || turn.workContinuation || turn.enterpriseReadOnly || turn.businessNotification) throw new Error('请在管理员普通会话中办理企业初始化')
      if (method === 'initialization_workbook') {
        rejectUnknownKeys(params, ['turn_key', 'path', 'sha256'], 'initialization workbook')
        const path = requireString(params.path, 'path', { min: 1, max: 4000 }), sha256 = requireString(params.sha256, 'sha256', { min: 64, max: 64 })
        if (!turn.authorizedMaterials.some(material => material.path === path && material.sha256 === sha256) && !turn.employeePrompt.includes(path)) throw new Error('该工作簿未由本轮管理员明确选择')
        const { readInitializationWorkbook } = await import('./initialization-workbook')
        const workbook = await readInitializationWorkbook(claim.cwd, { path, sha256 })
        await this.evidence(claim, turn)
        return workbook
      }
      const list = this.options.service.listInitializationActions, run = this.options.service.runNativeInitializationAction
      if (!list || !run) throw new Error('当前部署尚未开放原生企业初始化')
      const { dispatchInitialization } = await import('./initialization')
      return dispatchInitialization(method, params, {
        accountKey: turn.accountKey, sessionPath: claim.sessionPath!, messageId: turn.messageId!, employeePrompt: turn.employeePrompt,
        list: list.bind(this.options.service), run: run.bind(this.options.service), store: this.store,
        assertCurrent: async () => { await this.evidence(claim, turn) },
        reserveMutation: () => { if (turn.businessMutation === 'employee') throw new Error('本轮已办理其他业务动作，请先核对原结果'); turn.businessMutation = 'initialization' },
      })
    }
    if (method === 'read_current_business_material') {
      const { readBoundEmployeeBusinessMaterial } = await import('./employee-business-materials')
      if (turn.approvalContext || turn.workContinuation) throw new Error('请使用当前事项已有的材料读取入口')
      const actions = await this.employeeBusinessActions(), read = this.options.service.getEmployeeBusinessMaterial
      if (!read) throw new Error('当前原件读取入口不可用')
      return readBoundEmployeeBusinessMaterial(params, {
        selection: () => actions.selection(turn.accountKey, claim.sessionPath!),
        assertCurrent: async () => { await this.evidence(claim, turn) },
        read: (selection, assertCurrent) => read.call(this.options.service, selection, assertCurrent),
      })
    }
    if (method === 'list_current_item_actions' || method === 'run_current_item_action') {
      if (method === 'run_current_item_action') {
        if (turn.businessMutation === 'initialization') throw new Error('本轮已办理初始化批次，请在新消息中提出其他业务动作')
        turn.businessMutation = 'employee'
      }
      if (!turn.approvalContext) {
        if (turn.workContinuation) throw new Error('团队续办会话不能改为本人业务办理，请从当前业务事项打开')
        const current = {
          accountKey: turn.accountKey, sessionPath: claim.sessionPath!, messageId: turn.messageId!, employeePrompt: turn.employeePrompt,
          cwd: claim.cwd, materials: turn.authorizedMaterials, readOnly: Boolean(turn.businessNotification || turn.openingWorkContinuation),
          confirm: this.options.confirmAction,
          inputSources: async () => {
            await this.evidence(claim, turn)
            const transcript = await this.options.sessions[claim.harness!].read(claim.sessionPath!)
            return (await this.inputSources()).read(turn.accountKey, claim.sessionPath!, transcript.map(message => ({ id: message.id, role: message.role, text: messageText(message) })))
          },
          presentRecord: (record: EmployeeBusinessRecord) => {
            const key = randomUUID().replaceAll('-', '')
            const records = this.businessRecords.get(claim.token) ?? new Map<string, ScopedBusinessRecord>()
            records.set(key, { objectName: record.objectName, objectLabel: record.objectName, recordId: record.recordId, name: record.label, accountKey: turn.accountKey, turnKey: turn.key, fromEmployeeOperation: true })
            this.businessRecords.set(claim.token, records)
            return { name: record.label, record_key: key }
          },
          assertCurrent: async () => { await this.evidence(claim, turn) },
        }
        if (method === 'list_current_item_actions') {
          rejectUnknownKeys(params, ['turn_key', 'object_ref', 'reference_keys'], 'current item actions')
          const actions = await this.employeeBusinessActions()
          if (params.object_ref !== undefined || params.reference_keys !== undefined) {
            const { creationSelection } = await import('./employee-business-creation')
            await actions.selectCreation(current, creationSelection(params.object_ref, params.reference_keys,
              await actions.selection(turn.accountKey, claim.sessionPath!), this.businessObjects.get(claim.token), this.creationReferences.get(claim.token), turn.accountKey, turn.key))
          }
          return actions.list(current)
        }
        return (await this.employeeBusinessActions()).run(current, params)
      }
      const { dispatchCurrentItemAction } = await import('./current-item-actions')
      return dispatchCurrentItemAction(method, params, {
        service: this.options.service, claim, turn, contextChanged: approvalContextChanged,
        references: this.currentItemActionRefs, attempts: this.currentItemActionAttempts,
        turns: this.turns, bindings: this.approvalContexts,
      })
    }
    if (method === 'client_sessions') return this.listClientSessions(claim)
    if (method === 'client_session_revoke') return this.revokeClientSession(claim, params, accountKey)
    if (method === 'search') return this.search(claim, params, turn)
    if (method === 'describe') return this.describe(claim, params, turn)
    if (method === 'list_business_objects') return this.listBusinessObjects(claim, params, turn)
    if (method === 'find_business_record') return this.findBusinessRecord(claim, params, turn)
    if (method === 'read_business_record') return this.readBusinessRecord(claim, params, turn)
    if (method === 'submit') return this.submit(claim, params, turn)
    if (method === 'authorization_renew') return this.renewAuthorization(claim, params, turn)
    if (method === 'revision_submit') return this.submitReturnedRevision(claim, params, turn)
    if (method === 'recover') {
      rejectUnknownKeys(params, ['turn_key', 'recovery_key'], 'handoff recovery')
      const recoveryKey = requireString(params.recovery_key, 'recovery_key', { min: 64, max: 64 })
      const intent = await this.store.recover<FrozenHandoffIntent>(recoveryKey)
      this.assertRecoveryIntentScope(intent, claim, turn)
      await this.assertFrozenSourceMessages(intent, claim)
      return this.prepareDelivery(claim, turn, intent, recoveryKey)
    }
    throw new TypeError(`Unsupported enterprise method ${method}`)
  }
  private async listBusinessObjects(claim: CapabilityClaim, params: Record<string, unknown>, turn: EmployeeTurn) {
    rejectUnknownKeys(params, ['turn_key', 'handoff_key'], 'business object directory')
    let directory: BusinessObjectDirectory
    try { directory = await this.options.service.getBusinessObjectDirectory() }
    catch (error) {
      await this.evidence(claim, turn)
      return businessReadErrorResult(error)
    }
    await this.evidence(claim, turn)
    const boundRecord = turn.workContinuation?.context.input.businessRecord
    const visible = boundRecord ? directory.objects.filter((item) => item.objectName === boundRecord.objectName) : directory.objects
    if (boundRecord && !visible.length) return { status: 'not_found', message: '原工作绑定的业务对象当前不在员工可见目录中', objects: [], directory_complete: directory.complete }
    const objects = new Map<string, ScopedBusinessObject>()
    const presented = visible.map((item) => {
      const objectRef = randomUUID().replaceAll('-', '')
      objects.set(objectRef, { ...item, accountKey: turn.accountKey, turnKey: turn.key, directoryComplete: directory.complete })
      return { object_ref: objectRef, name: item.label }
    })
    this.businessObjects.set(claim.token, objects)
    this.businessRecords.delete(claim.token)
    return {
      status: directory.complete ? 'complete' : 'partial', objects: presented,
      ...(directory.totalCount !== undefined && directory.complete ? { total_count: directory.totalCount } : {}),
      directory_complete: directory.complete,
      message: '对象目录只表示当前账号可见元数据；记录读取仍由 Forge 原生 query_records 或 get_record 单独授权校验。',
    }
  }
  private async findBusinessRecord(claim: CapabilityClaim, params: Record<string, unknown>, turn: EmployeeTurn) {
    rejectUnknownKeys(params, ['turn_key', 'handoff_key', 'object_ref', 'work_summary', 'offset', 'limit'], 'business record search')
    const objectRef = requireString(params.object_ref, 'object_ref', { min: 32, max: 64, trim: true })
    const summary = requireString(params.work_summary, 'work_summary', { min: 1, max: 4_000, trim: true })
    const offset = params.offset === undefined ? 0 : params.offset
    const limit = params.limit === undefined ? 20 : params.limit
    if (!Number.isInteger(offset) || (offset as number) < 0 || (offset as number) > 10_000
      || !Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 50) throw new Error('业务记录分页参数无效')
    const object = this.businessObjects.get(claim.token)?.get(objectRef)
    if (!object || object.turnKey !== turn.key || object.accountKey !== turn.accountKey) throw new Error('业务对象引用已失效，请按当前员工轮次重新读取对象目录')
    const boundRecord = turn.workContinuation?.context.input.businessRecord
    if (boundRecord && object.objectName !== boundRecord.objectName) throw new Error('原工作只能继续使用已绑定的业务对象')
    let records: BusinessRecordSearchPage['records']
    let page: BusinessRecordSearchPage | BusinessRecordRead
    try {
      page = boundRecord
        ? await this.readBoundBusinessRecord(object, boundRecord, turn)
        : await this.options.service.findBusinessRecords(object.objectName, summary, offset as number, limit as number)
      records = 'candidate' in page ? [page.candidate] : page.records
    } catch (error) {
      await this.evidence(claim, turn)
      const failure = businessReadErrorResult(error)
      return { ...failure, records: [], directory_complete: object.directoryComplete }
    }
    await this.evidence(claim, turn)
    const mapped = new Map<string, ScopedBusinessRecord>()
    const presented = records.map((item) => {
      const recordKey = randomUUID().replaceAll('-', '')
      const bound = 'candidate' in page ? page : undefined
      mapped.set(recordKey, {
        ...item, accountKey: turn.accountKey, turnKey: turn.key,
        ...(!('candidate' in page) && object.directoryComplete && page.complete && !page.hasMore && page.offset === 0 && records.length === 1 && summary.length >= 2
          ? { uniqueQuery: summary } : {}),
        ...(bound ? { snapshot: bound.snapshot } : {}),
      })
      return {
        record_key: recordKey, name: item.name, object: object.label,
        ...(item.code ? { code: item.code } : {}), ...(item.status ? { status: item.status } : {}),
        ...(item.owner ? { owner: item.owner } : {}), ...(item.recordVersion ? { record_version: item.recordVersion } : {}),
      }
    })
    this.businessRecords.set(claim.token, mapped)
    const hasMore = 'candidate' in page ? false : page.hasMore
    const warning = 'warning' in page ? page.warning : undefined
    const complete = object.directoryComplete && ('candidate' in page ? page.snapshot.completeness === 'complete' : page.complete)
    const status = presented.length > 1 ? complete ? 'multiple_candidates' : 'partial_candidates'
      : presented.length ? complete ? 'candidate' : 'partial_candidates'
        : hasMore ? 'next_page' : complete ? 'not_found' : 'partial'
    return {
      status,
      message: warning ?? (presented.length ? complete
        ? '候选记录仅供结合员工原话选择；Host 尚未固定完整记录快照。唯一候选也不会由 Host 自动绑定。'
        : '当前对象目录或查询页不完整；以下仅为部分候选，不能证明没有其它匹配。唯一候选也不会由 Host 自动绑定。'
        : hasMore ? '当前页没有相关记录，仍有下一页可查。'
          : complete ? '当前页没有与检索意图相关的可见记录。' : '当前对象目录或查询页不完整，不能据此断言未找到。'),
      records: presented, selection_required: presented.length > 0, offset: 'candidate' in page ? 0 : page.offset,
      limit: 'candidate' in page ? 1 : page.limit, has_more: hasMore, complete, directory_complete: object.directoryComplete,
      ...(warning ? { warning } : {}),
    }
  }
  private async readBoundBusinessRecord(object: ScopedBusinessObject, boundRecord: NonNullable<EnterpriseWorkContinuationContext['input']['businessRecord']>, turn: EmployeeTurn) {
    if (object.objectName !== boundRecord.objectName) throw new Error('原工作只能继续使用已绑定的业务对象')
    const read = await this.options.service.readBusinessRecord(boundRecord.objectName, boundRecord.recordID)
    if (await this.options.service.accountKey() !== turn.accountKey) throw new Error('员工账号已变化，旧记录读取结果已丢弃')
    if (read.candidate.recordId !== boundRecord.recordID || read.candidate.objectName !== boundRecord.objectName) throw new Error('Forge 返回的业务记录与原工作绑定不一致')
    return read
  }
  private async readBusinessRecord(claim: CapabilityClaim, params: Record<string, unknown>, turn: EmployeeTurn) {
    rejectUnknownKeys(params, ['turn_key', 'handoff_key', 'record_key'], 'business record read')
    const recordKey = requireString(params.record_key, 'record_key', { min: 32, max: 64, trim: true })
    const selected = this.businessRecords.get(claim.token)?.get(recordKey)
    if (!selected || selected.turnKey !== turn.key || selected.accountKey !== turn.accountKey) throw new Error('业务记录选择已失效，请按当前员工轮次重新查找')
    const boundRecord = turn.workContinuation?.context.input.businessRecord
    if (boundRecord && (selected.objectName !== boundRecord.objectName || selected.recordId !== boundRecord.recordID)) throw new Error('原工作只能继续使用已绑定的业务记录')
    let read: BusinessRecordRead
    try { read = selected.snapshot ? { candidate: selected, snapshot: selected.snapshot } : await this.options.service.readBusinessRecord(selected.objectName, selected.recordId) }
    catch (error) {
      await this.evidence(claim, turn)
      return businessReadErrorResult(error)
    }
    await this.evidence(claim, turn)
    if (read.candidate.objectName !== selected.objectName || read.candidate.recordId !== selected.recordId) throw new Error('Forge 返回的业务记录与选择不一致')
    const updated = { ...selected, ...read.candidate, snapshot: read.snapshot }
    this.businessRecords.get(claim.token)?.set(recordKey, updated)
    const references = this.creationReferences.get(claim.token) ?? new Map<string, VerifiedCreationReference>()
    for (const [key, value] of references) if (value.turnKey !== turn.key || value.accountKey !== turn.accountKey) references.delete(key)
    if (!references.has(recordKey) && references.size >= 128) throw new Error('本轮已读取的创建引用过多，请保留明确选择后在新消息继续')
    references.set(recordKey, { name: updated.name, ...(updated.code ? { code: updated.code } : {}), ...(read.creationSku ?? {}),
      ...(selected.uniqueQuery && (updated.name.includes(selected.uniqueQuery) || updated.code === selected.uniqueQuery || read.creationSku?.materialName === selected.uniqueQuery) ? { uniqueQuery: selected.uniqueQuery } : {}), objectName: updated.objectName, recordId: updated.recordId, accountKey: turn.accountKey, turnKey: turn.key })
    this.creationReferences.set(claim.token, references)
    if (!turn.workContinuation) await (await this.employeeBusinessActions()).bind(turn.accountKey, claim.sessionPath!, {
      record: { objectName: updated.objectName, recordId: updated.recordId, label: updated.name }, source: { kind: 'record' },
    }, selected.fromEmployeeOperation === true)
    return {
      status: 'read', record_key: recordKey, name: updated.name, object: updated.objectLabel,
      ...(updated.code ? { code: updated.code } : {}), ...(updated.status ? { business_status: updated.status } : {}),
      ...(updated.owner ? { owner: updated.owner } : {}), ...(updated.recordVersion ? { record_version: updated.recordVersion } : {}),
      snapshot: read.snapshot, complete: read.snapshot.completeness === 'complete',
    }
  }
  private async evidence(claim: CapabilityClaim, turn: EmployeeTurn) {
    const transcript = await this.options.sessions[claim.harness!].read(claim.sessionPath!)
    const messages = transcript.map((message, eventSeq) => ({ message, eventSeq, text: messageText(message) }))
    const authorization = [...messages].reverse().find((entry) => entry.message.role === 'user')
    if (turn.pendingSessionPrompts) {
      const userMessages = messages.filter((entry) => entry.message.role === 'user').map((entry) => entry.text)
      if (userMessages.length !== turn.pendingSessionPrompts.length
        || userMessages.some((prompt, index) => prompt !== turn.pendingSessionPrompts![index])) {
        throw new Error('无法核对新 Pi 会话中的员工消息顺序，请重新打开会话')
      }
    }
    if (await this.options.service.accountKey() !== turn.accountKey || this.turns.get(claim.token) !== turn || this.claimForToken(claim.token) !== claim) throw new Error('员工轮次或账号已变化，旧交接不能继续')
    if (turn.workContinuation && (this.workContinuations.get(claim.token) !== turn.workContinuation || this.workLineages.get(claim.token) !== turn.workContinuation)) {
      throw new Error('团队工作上下文已失效，请重新打开工作消息')
    }
    if (!authorization || authorization.text !== turn.prompt || turn.baseline.has(authorization.message.id) || (turn.messageId && turn.messageId !== authorization.message.id)) throw new Error('当前员工输入尚未进入原会话，或员工要求已经变化')
    turn.messageId = authorization.message.id
    await this.rememberBusinessInput(claim, turn, transcript)
    return messages.filter((entry) => entry.eventSeq <= authorization.eventSeq && entry.text).slice(-50).map(({ message, eventSeq, text }) => ({ messageId: message.id, eventSeq, sha256: digest(text) }))
  }
  private assertRecoveryIntentScope(intent: FrozenHandoffIntent, claim: CapabilityClaim, turn: EmployeeTurn): void {
    if (intent.accountKey !== turn.accountKey || intent.sessionKey !== digest(claim.sessionPath!).slice(0, 24)) {
      throw new Error('该交接不属于当前员工与会话')
    }
    if (intent.reusedMaterials?.length) {
      const continuation = turn.workContinuation?.context
      const parent = intent.continuation
      if (!continuation || !parent || parent.workbenchSessionID !== continuation.source.workbenchSessionID
        || parent.inputRevisionID !== continuation.source.inputRevisionID || parent.runID !== continuation.source.runID
        || parent.teamID !== continuation.input.teamID || intent.choice.teamId !== parent.teamID
        || !isReusableReadOnlyContinuation(continuation)) {
        throw new Error('复用材料恢复请求与当前只读工作不匹配')
      }
      for (const reused of intent.reusedMaterials) {
        const matches = continuation.input.materials.filter((material) => material.id === reused.id
          && material.materialId === reused.materialId && material.name === reused.name
          && material.mediaType === reused.mediaType && material.bytes === reused.bytes
          && material.sha256 === reused.sha256 && material.sourceKind === reused.sourceKind
          && material.requestId === reused.requestId && material.content === reused.content
          && JSON.stringify(material.extraction ?? null) === JSON.stringify(reused.extraction ?? null))
        if (matches.length !== 1) throw new Error('复用材料恢复请求的文件版本或来源已变化')
      }
    }
  }
  private async assertFrozenSourceMessages(intent: FrozenHandoffIntent, claim: CapabilityClaim): Promise<void> {
    const sourceMessages = intent.sourceMessages
    if (!Array.isArray(sourceMessages) || sourceMessages.length === 0) {
      throw new Error('原员工消息不在冻结记录中，旧交接不能恢复')
    }
    const employeeSource = sourceMessages.find((message) => message.messageId === intent.employeeMessageId)
    if (!employeeSource) throw new Error('原员工消息不在冻结记录中，旧交接不能恢复')
    const transcript = await this.options.sessions[claim.harness!].read(claim.sessionPath!)
    const currentById = new Map(transcript.map((message, eventSeq) => [message.id, { message, eventSeq }]))
    for (const source of sourceMessages) {
      const current = currentById.get(source.messageId)
      if (!current || current.eventSeq !== source.eventSeq || digest(messageText(current.message)) !== source.sha256) {
        throw new Error(source.messageId === intent.employeeMessageId
          ? '原员工消息已修改或不存在，旧冻结交接不能恢复'
          : '冻结交接依据的原会话内容已变化，旧交接不能恢复')
      }
      if (source.messageId === intent.employeeMessageId && current.message.role !== 'user') {
        throw new Error('原员工消息已修改或不存在，旧冻结交接不能恢复')
      }
    }
  }
  private async assertWorkContinuationCurrent(claim: CapabilityClaim, turn: EmployeeTurn, requireReusableMaterials = false): Promise<void> {
    const bound = turn.workContinuation
    if (!bound) return
    if (this.workContinuations.get(claim.token) !== bound || this.workLineages.get(claim.token) !== bound
      || bound.sessionPath !== claim.sessionPath || await this.options.service.accountKey() !== bound.accountKey) {
      throw new Error('员工账号或当前工作轮次已变化，请重新打开工作消息')
    }
    const current = await this.options.service.getWorkContinuationContext({
      workReference: bound.context.source.inputRevisionID,
      runReference: bound.context.source.runID,
      sessionReference: bound.context.source.workbenchSessionID,
    })
    if (workContinuationFingerprint(current) !== bound.fingerprint) throw new Error('原工作输入、材料版本或团队结果已变化，请刷新工作消息')
    bound.context.run.status = current.run.status
    bound.context.run.authorization = current.run.authorization ? structuredClone(current.run.authorization) : undefined
    assertContinuationSubmissionAuthorization(bound.context)
    if (requireReusableMaterials && !isReusableReadOnlyContinuation(bound.context)) {
      throw new Error('当前团队运行状态或平台动作回执不允许复用原材料，请刷新工作消息')
    }
  }
  private async listClientSessions(claim: CapabilityClaim) {
    if (!this.options.service.listOwnClientSessions) throw new Error('当前版本不能查看客户端会话')
    const sessions = await this.options.service.listOwnClientSessions()
    const listed = new Map(sessions.map((session, index) => [String(index + 1), session]))
    this.clientSessions.set(claim.token, listed)
    return {
      sessions: [...listed].map(([ref, session]) => ({ session_ref: ref, client: session.client, signed_in_at: session.createdAt,
        ...(session.lastUsedAt ? { last_used_at: session.lastUsedAt } : {}), expires_at: session.expiresAt })),
      message: sessions.length ? '这些是用本人账号登录 Weave 的外部客户端。收回一个时用它的 session_ref。' : '本人账号目前没有登录中的外部客户端。',
    }
  }

  private async revokeClientSession(claim: CapabilityClaim, params: Record<string, unknown>, accountKey: string) {
    const ref = typeof params.session_ref === 'string' ? params.session_ref.trim() : ''
    const session = this.clientSessions.get(claim.token)?.get(ref)
    if (!session) throw new Error('请先列出本人的客户端会话，再按列表里的 session_ref 收回')
    if (!this.options.confirmOperation || !this.options.service.revokeOwnClientSession) throw new Error('当前窗口不能确认收回，未办理')
    // The person answers at the window; the model can neither see nor answer this.
    const confirmed = await this.options.confirmOperation({
      title: '收回客户端会话', subject: `${session.client}（${session.createdAt} 登录）`,
      message: '收回后这个客户端立即不能再用这次登录访问 Weave，需要重新登录。',
    })
    if (!confirmed) return { status: 'declined', message: '使用者没有同意收回，会话保持不变。不要重试，除非使用者再次明确要求。' }
    if (this.claimForToken(claim.token) !== claim || await this.options.service.accountKey() !== accountKey) throw new Error('账号或会话已变化，未收回')
    await this.options.service.revokeOwnClientSession(session.id)
    this.clientSessions.get(claim.token)?.delete(ref)
    return { status: 'done', message: `已收回 ${session.client} 的这次登录。` }
  }

  private async search(claim: CapabilityClaim, params: Record<string, unknown>, turn: EmployeeTurn) {
    const summary = requireString(params.work_summary, 'work_summary', { min: 1, max: 4_000, trim: true })
    const teams = searchTeams(await this.options.service.getTeamCatalog(), summary)
    await this.evidence(claim, turn)
    const discovered = new Map(teams.map((team) => [digest(`team:${team.id}`).slice(0, 24), team]))
    this.teams.set(claim.token, discovered)
    return { teams: [...discovered].map(([key, team]) => ({ team_key: key, name: team.name, summary: team.objective })), matching: '名称与目标文本相关性筛选；请结合完整对话判断是否适合' }
  }
  private async describe(claim: CapabilityClaim, params: Record<string, unknown>, turn: EmployeeTurn) {
    const key = requireString(params.team_key, 'team_key', { min: 1, max: 128, trim: true })
    const team = this.teams.get(claim.token)?.get(key)
    if (!team) throw new Error('请先查找适合当前工作的企业团队')
    if (turn.workContinuation && team.id !== turn.workContinuation.context.input.teamID) {
      throw new Error('原工作续办必须使用原团队；请从工作消息刷新后重新选择')
    }
    const choices = await this.options.service.getTeamChoices(team)
    await this.evidence(claim, turn)
    if (!choices.length) throw new Error('该团队当前没有可承接工作的已发布流程')
    const handoffs = this.handoffs.get(claim.token) ?? new Map<string, EnterpriseWorkChoice>()
    for (const choice of choices) handoffs.set(handoffKey(choice), choice)
    this.handoffs.set(claim.token, handoffs)
    const scopeByHandoff = this.businessActions.get(claim.token) ?? new Map<string, Map<string, EnterpriseBusinessCapability>>()
    const capabilities = await Promise.all(choices.map(async (choice) => {
      const available = await this.options.service.getBusinessCapabilities(choice.businessCapabilityIds)
      const actionMap = new Map(available.map((action) => [digest(`action:${handoffKey(choice)}:${action.id}`).slice(0, 24), action]))
      scopeByHandoff.set(handoffKey(choice), actionMap)
      return {
        handoff_key: handoffKey(choice), name: choice.workflowName, description: choice.workflowDescription,
        business_actions: available.map((action) => ({ action_key: digest(`action:${handoffKey(choice)}:${action.id}`).slice(0, 24), name: action.name, description: action.description })),
      }
    }))
    await this.evidence(claim, turn)
    this.businessActions.set(claim.token, scopeByHandoff)
    return { team: { name: team.name, summary: team.objective }, capabilities }
  }
  private async submit(claim: CapabilityClaim, params: Record<string, unknown>, turn: EmployeeTurn): Promise<unknown> {
    if (turn.openingWorkContinuation) throw new Error('打开工作消息只授权查看已有结果；请等待员工在新消息中明确提出后续工作')
    await this.assertWorkContinuationCurrent(claim, turn)
    const key = requireString(params.handoff_key, 'handoff_key', { min: 1, max: 128, trim: true })
    const goal = requireString(params.goal, 'goal', { min: 1, max: 20_000, trim: true })
    if (!Array.isArray(params.business_actions) || params.business_actions.length > 32 || params.business_actions.some((value) => typeof value !== 'string')) throw new Error('本次业务动作范围无效')
    const actionKeys = params.business_actions as string[]
    if (new Set(actionKeys).size !== actionKeys.length) throw new Error('本次业务动作不能重复')
    if (turn.workContinuation?.context.run.status === 'failed' && !turn.workContinuation.context.run.finalResult && actionKeys.length > 0) {
      throw new Error('原失败运行没有团队交付结果，只能按新授权重新进行只读检查；不能沿用旧运行直接执行业务动作')
    }
    const selections = params.materials === undefined ? [] : materialSelection(params.materials, undefined, true)
    const choice = this.handoffs.get(claim.token)?.get(key)
    if (!choice) throw new Error('请先查看团队的承接能力，并使用本轮返回的交接项')
    const workContinuation = turn.workContinuation
    if (workContinuation && choice.teamId !== workContinuation.context.input.teamID) throw new Error('原工作只能提交给原团队，请刷新当前工作消息')
    const actionMap = this.businessActions.get(claim.token)?.get(key)
    if (!actionMap) throw new Error('请先查看团队当前可用的业务动作')
    const authorizedBusinessCapabilityIds = actionKeys.map((actionKey) => {
      const action = actionMap.get(actionKey)
      if (!action) throw new Error('业务动作不属于本轮查看的团队能力')
      return action.id
    }).sort()
    if (Array.isArray(params.reuse_material_names) && params.reuse_material_names.length > 0) {
      await this.assertWorkContinuationCurrent(claim, turn, true)
    }
    const reusedMaterials = reuseMaterialsFromContinuation(workContinuation, params.reuse_material_names, turn.accountKey)
    assertHandoffMaterialCount(selections.length, reusedMaterials.length)
    const businessRecordKey = typeof params.business_record_key === 'string' ? params.business_record_key.trim() : ''
    const selectedBusinessContext = businessRecordKey ? this.businessRecords.get(claim.token)?.get(businessRecordKey) : undefined
    if (businessRecordKey && !selectedBusinessContext) throw new Error('业务记录选择已失效，请按当前工作重新查找')
    if (selectedBusinessContext && (selectedBusinessContext.turnKey !== turn.key || selectedBusinessContext.accountKey !== turn.accountKey)) {
      throw new Error('业务记录选择不属于当前员工轮次，请重新查找')
    }
    const boundRecord = workContinuation?.context.input.businessRecord
    if (boundRecord && selectedBusinessContext && (selectedBusinessContext.objectName !== boundRecord.objectName || selectedBusinessContext.recordId !== boundRecord.recordID)) {
      throw new Error('原工作绑定的业务记录不能替换')
    }
    let businessContext = selectedBusinessContext ? {
      objectName: selectedBusinessContext.objectName, recordId: selectedBusinessContext.recordId,
      name: selectedBusinessContext.name, ...(selectedBusinessContext.code ? { code: selectedBusinessContext.code } : {}),
      ...(selectedBusinessContext.recordVersion ? { recordVersion: selectedBusinessContext.recordVersion } : {}),
    } : boundRecord ? {
      objectName: boundRecord.objectName, recordId: boundRecord.recordID, name: '原工作业务记录',
    } : undefined
    let businessSnapshot = selectedBusinessContext?.snapshot
    const authorizedMaterialKeys = new Set(turn.authorizedMaterials.map((item) => `${item.path}\u0000${item.sha256}`))
    if (selections.some((item) => !authorizedMaterialKeys.has(`${item.path}\u0000${item.sha256}`))) {
      throw new Error('只能交接本轮消息中实际附加的材料；如需复用旧文件，请先在本轮重新附加并核对版本')
    }
    if (selections.length === 0 && reusedMaterials.length === 0 && !businessContext) throw new Error('没有本次授权的文件、已授权复用的原材料或已读取的业务记录，无法交接')
    for (const actionKey of actionKeys) {
      const action = actionMap.get(actionKey)!
      if (action.requiresRecord !== false && (!businessContext || businessContext.objectName !== action.resourceType)) throw new Error('请先按当前工作查找并绑定该动作所需的业务记录')
    }
    if (businessContext && !businessSnapshot) {
      const read = await this.options.service.readBusinessRecord(businessContext.objectName, businessContext.recordId)
      await this.evidence(claim, turn)
      if (read.candidate.objectName !== businessContext.objectName || read.candidate.recordId !== businessContext.recordId) {
        throw new Error('Forge 当前记录与员工选择不一致，桌面已停止交接')
      }
      businessContext = {
        objectName: read.candidate.objectName, recordId: read.candidate.recordId,
        name: read.candidate.name,
        ...(read.candidate.code ? { code: read.candidate.code } : {}),
        ...(read.candidate.recordVersion ? { recordVersion: read.candidate.recordVersion } : {}),
      }
      businessSnapshot = read.snapshot
      if (businessRecordKey) {
        this.businessRecords.get(claim.token)?.set(businessRecordKey, { ...selectedBusinessContext!, ...read.candidate, snapshot: read.snapshot })
      }
    }
    const sourceMessages = await this.evidence(claim, turn)
    await this.assertWorkContinuationCurrent(claim, turn, reusedMaterials.length > 0)
    const employeeMessageId = turn.messageId
    if (!employeeMessageId) throw new Error('无法确认当前员工授权消息')
    const sessionKey = digest(claim.sessionPath!).slice(0, 24)
    const idempotencySeed = `${sessionKey}:${turn.messageId}:${key}`
    const identity = `${turn.accountKey}:${idempotencySeed}`
    const fingerprint = digest(JSON.stringify({
      goal, selections: selections.map((selection) => ({
        ...selection,
        ...(/\.(?:pdf|docx)$/i.test(selection.path) ? { sourceKind: 'owner' as const } : {}),
      })),
      key, authorizedBusinessCapabilityIds, businessContext, businessSnapshot: businessSnapshot ?? null,
      continuation: workContinuation?.context.source,
      reusedMaterials: reusedMaterials.map(({ id, materialId, sourceKind, requestId, name, mediaType, bytes, sha256 }) => ({ id, materialId, sourceKind, requestId, name, mediaType, bytes, sha256 })),
    }))
    const intent = await this.store.freeze<FrozenHandoffIntent>(identity, fingerprint, async () => {
      const current = await this.options.service.getTeamChoices({ id: choice.teamId, name: choice.teamName })
      if (!current.some((item) => handoffKey(item) === key)) throw new Error('承接流程版本已经变化，请重新查找')
      const materials = await freezeMaterials(claim.cwd, selections)
      if (materials.some((material) => reusedMaterials.some((reused) => reused.materialId === material.materialId))) {
        throw new Error('本轮附件与复用的原材料是同一文件版本，请只选择一种来源')
      }
      const task = executionText(goal, materials, businessSnapshot, reusedMaterials)
      await this.evidence(claim, turn)
      await this.assertWorkContinuationCurrent(claim, turn, reusedMaterials.length > 0)
      return {
        task, materials, reusedMaterials, authorizedBusinessCapabilityIds, sourceMessages, employeeMessageId, choice,
        accountKey: turn.accountKey, idempotencySeed, sessionKey,
        ...(businessContext ? { businessContext } : {}),
        ...(businessSnapshot ? { businessSnapshot } : {}),
        ...(workContinuation ? { continuation: {
          workbenchSessionID: workContinuation.context.source.workbenchSessionID,
          inputRevisionID: workContinuation.context.source.inputRevisionID,
          runID: workContinuation.context.source.runID,
          teamID: workContinuation.context.input.teamID,
        } } : {}),
      }
    })
    return this.prepareDelivery(claim, turn, intent, digest(identity))
  }
  private async renewAuthorization(claim: CapabilityClaim, params: Record<string, unknown>, turn: EmployeeTurn): Promise<unknown> {
    rejectUnknownKeys(params, ['turn_key', 'employee_request'], 'work authorization renewal')
    if (params.employee_request !== turn.employeePrompt) throw new Error('续授权必须使用本轮员工明确要求，不能代入旧消息')
    const key = `renew:${claim.token}:${turn.key}`
    const pending = this.inFlight.get(key)
    if (pending) return pending
    const bound = turn.workContinuation
    const operation = (async () => {
      const { renewFromEmployeeTurn } = await import('./authorization-renewal-bridge')
      return renewFromEmployeeTurn(params, {
        opening: Boolean(turn.openingWorkContinuation), prompt: turn.employeePrompt, accountKey: turn.accountKey, context: bound?.context,
        store: this.store, renew: this.options.service.renewWorkAuthorization?.bind(this.options.service),
        assertCurrent: async () => { await this.evidence(claim, turn); if (bound && this.workContinuations.get(claim.token) !== bound) throw new Error('工作上下文已失效，请重新打开原工作消息'); return turn.messageId },
      })
    })()
    this.inFlight.set(key, operation)
    try { return await operation } finally { this.inFlight.delete(key) }
  }
  private async submitReturnedRevision(claim: CapabilityClaim, params: Record<string, unknown>, turn: EmployeeTurn): Promise<unknown> {
    rejectUnknownKeys(params, ['turn_key', 'employee_request', 'body', 'primary_material', 'materials'], 'revision')
    const approvalContext = this.approvalContexts.get(claim.token)
    if (approvalContext?.purpose !== 'revision'
      || approvalContext.sessionPath !== claim.sessionPath || approvalContext.accountKey !== turn.accountKey) {
      throw new Error('请从“我的工作”重新打开本人退回的审批事项')
    }
    const bound = approvalContext as BoundReturnedApproval
    const employeeRequest = requireString(params.employee_request, 'employee_request', { min: 1, max: 20_000, trim: false })
    if (employeeRequest !== turn.employeePrompt) throw new Error('员工本轮要求已变化，旧修订意图不能继续')
    if (turn.openingReturnedApproval) throw new Error('打开退回事项只授权查看与整理材料；请等待员工在后续消息明确要求递交修订材料')
    const hasBody = params.body !== undefined, hasPrimaryMaterial = params.primary_material !== undefined
    if (hasBody === hasPrimaryMaterial) throw new Error('请在文本修订正文与本轮指定的原件主件之间选择一种')
    const body = hasBody ? requireString(params.body, 'body', { min: 1, max: 2 * 1024 * 1024, trim: false }) : undefined
    if (body !== undefined && (!body.trim() || body.includes('\0'))) throw new Error('修订正文为空或无法安全保存')
    const bodyBytes = body === undefined ? undefined : Buffer.from(body, 'utf8')
    if (bodyBytes && bodyBytes.length > 2 * 1024 * 1024) throw new Error('修订正文超出固定材料大小限制')
    if (!Array.isArray(params.materials) || params.materials.length > REVISION_MATERIAL_LIMITS.maxFiles) {
      throw new Error('修订材料清单无效，请按当前要求重新整理')
    }
    const selections = params.materials.length ? materialSelection(params.materials, REVISION_MATERIAL_LIMITS) : []
    const primarySelection = hasPrimaryMaterial ? materialSelection([params.primary_material], REVISION_MATERIAL_LIMITS)[0] : undefined
    if (primarySelection && selections.some((selection) => selection.path === primarySelection.path)) throw new Error('修订主件不能同时作为附件')
    const selected = primarySelection ? [primarySelection, ...selections] : selections
    const capturedMaterials = turn.capturedEmployeeInput ? new Map(turn.authorizedMaterials.map((material) => [material.path, material])) : undefined
    if (capturedMaterials && selected.some((material) => capturedMaterials.get(material.path)?.sha256 !== material.sha256)) {
      throw new Error('只能递交本轮由员工实际选定且版本已核对的修订主件和附件')
    }
    const sourceMessages = await this.evidence(claim, turn)
    const employeeMessageId = turn.messageId
    if (!employeeMessageId) throw new Error('无法核对当前员工轮次，请重新发送本轮要求')
    const sessionKey = digest(claim.sessionPath).slice(0, 24)
    const employeeRequestSha256 = digest(Buffer.from(employeeRequest, 'utf8'))
    const employeeRoundId = digest(JSON.stringify([bound.accountKey, sessionKey, employeeMessageId, employeeRequestSha256]))
    const bodySha256 = bodyBytes ? digest(bodyBytes) : undefined
    const identity = `${bound.accountKey}:returned-revision:${bound.context.requestId}:${bound.context.returnVersion}:${employeeRoundId}`
    const fingerprint = digest(JSON.stringify({
      context: bound.fingerprint, employeeRoundId, bodySha256,
      ...(primarySelection ? { primaryMaterial: primarySelection } : {}),
      materials: selections.map((selection) => ({ path: selection.path, sha256: selection.sha256 })),
    }))
    if (!this.options.storage?.directory) throw new Error('本地交接存储目录未配置，无法固定修订材料包')
    let intent: FrozenRevisionIntent
    try {
      intent = await this.store.freeze<FrozenRevisionIntent>(identity, fingerprint, async () => {
        const latest = await this.options.service.getApprovalContext(bound.context.requestId)
        assertReturnedApproval(latest, bound.context.requestId)
        if (returnedApprovalFingerprint(latest) !== bound.fingerprint) {
          throw new Error('退回意见、业务对象或原材料版本已变化，请刷新待办后重新处理')
        }
        const frozen = await freezeMaterials(claim.cwd, selected, { ...REVISION_MATERIAL_LIMITS, maxFiles: 11 })
        if (capturedMaterials && frozen.some((material, index) => {
          const captured = capturedMaterials.get(selected[index]!.path)!
          return material.bytes !== captured.bytes || material.mediaType !== captured.mimeType
        })) throw new Error('修订材料字节长度或文件类型与本轮员工选件不一致，未上传材料')
        const primaryMaterial = primarySelection ? frozen[0] : undefined
        const attachments = primaryMaterial ? frozen.slice(1) : frozen
        if (primaryMaterial && primaryMaterial.mediaType !== 'application/pdf'
          && primaryMaterial.mediaType !== 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
          throw new Error('修订主件原件必须是本轮指定的 PDF 或 DOCX 文件')
        }
        if ((bodyBytes?.length ?? 0) + frozen.reduce((total, file) => total + file.bytes, 0) > 8 * 1024 * 1024) {
          throw new Error('修订正文和附件总量超出 Forge 固定材料限制')
        }
        await this.evidence(claim, turn)
        if (turn.messageId !== employeeMessageId || await this.options.service.accountKey() !== bound.accountKey) {
          throw new Error('员工账号或轮次已变化，旧修订意图不能继续')
        }
        const sourceFiles = latest.files.map((file): FrozenRevisionSourceFile => {
          const bytes = Buffer.from(file.content, 'utf8')
          if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw new Error('原始审批材料与冻结版本不一致，请暂停处理')
          return { fileId: file.fileId, name: file.name, mediaType: file.mediaType, bytes: bytes.length, sha256: file.sha256, bytesBase64: bytes.toString('base64') }
        })
        for (const file of latest.originalFiles ?? []) {
          const bytes = validateFrozenApprovalOriginalMaterial(file)
          sourceFiles.push({
            sourceKind: file.sourceKind, requestId: file.requestId, fileId: file.fileId,
            name: file.name, mediaType: file.mediaType, bytes: file.bytes, sha256: file.sha256,
            bytesBase64: bytes.toString('base64'),
          })
        }
        if (sourceFiles.reduce((total, file) => total + file.bytes, 0) > 8 * 1024 * 1024) throw new Error('原始审批材料超出本地固定包大小限制')
        return {
          version: 1, accountKey: bound.accountKey, sessionKey, employeeRoundId, employeeMessageId,
          employeeRequest, employeeRequestSha256, sourceMessages, requestId: latest.requestId,
          returnVersion: latest.returnVersion, sourceMaterialVersion: latest.sourceMaterialVersion,
          idempotencyKey: submissionUUID(employeeRoundId),
          businessObject: structuredClone(latest.businessObject), returnReason: latest.returnReason,
          sourceFiles,
          ...(body !== undefined && bodyBytes && bodySha256 ? { body: { name: '修订正文.md', content: body, bytes: bodyBytes.length, sha256: bodySha256, bytesBase64: bodyBytes.toString('base64') } } : {}),
          ...(primaryMaterial ? { primaryMaterial: revisionFile(primaryMaterial) } : {}),
          materials: attachments.map(revisionFile),
        }
      })
    } catch (error) {
      if (error instanceof Error && error.message.includes('本轮交接内容已冻结')) {
        throw new Error('本轮修订材料已固定；正文或文件改变后请从当前退回事项重新开始')
      }
      throw error
    }
    const prior = this.revisionInFlight.get(identity)
    if (prior) return prior
    const operation = this.deliverReturnedRevision(claim, turn, bound, intent, fingerprint)
    this.revisionInFlight.set(identity, operation)
    try { return await operation } finally { this.revisionInFlight.delete(identity) }
  }
  private async deliverReturnedRevision(
    claim: CapabilityClaim,
    turn: EmployeeTurn,
    bound: BoundReturnedApproval,
    intent: FrozenRevisionIntent,
    intentFingerprint: string,
  ): Promise<unknown> {
    const progressKey = `returned-revision:${intent.accountKey}:${intent.sessionKey}:${intent.requestId}:${intent.returnVersion}:${intent.employeeRoundId}:progress`
    const progressFingerprint = digest(JSON.stringify({
      intentFingerprint, idempotencyKey: intent.idempotencyKey, requestId: intent.requestId,
      returnVersion: intent.returnVersion, sourceMaterialVersion: intent.sourceMaterialVersion,
    }))
    const primary = intent.primaryMaterial ?? intent.body
    if (!primary) throw new Error('固定修订材料缺少正文主件')
    const publicFiles = [{ name: primary.name }, ...intent.materials.map(({ name }) => ({ name }))]
    const assertCurrent = async () => {
      await this.evidence(claim, turn)
      if (await this.options.service.accountKey() !== intent.accountKey
        || this.approvalContexts.get(claim.token) !== bound
        || this.claimForToken(claim.token) === undefined) throw new Error('员工账号或轮次已变化，旧修订意图不能继续')
    }
    const assertApprovalCurrent = async () => {
      await assertCurrent()
      const latest = await this.options.service.getApprovalContext(intent.requestId)
      assertReturnedApproval(latest, intent.requestId)
      if (returnedApprovalFingerprint(latest) !== bound.fingerprint) throw new Error('退回意见、业务对象或原材料版本已变化，请刷新待办后重新处理')
      await assertCurrent()
    }
    const resolveReceipt = async (prior?: ReturnedRevisionProgress): Promise<unknown> => {
      let result: { status: number; body: unknown }
      try {
        result = await this.options.service.getApprovalRevisionReceipt(intent.requestId, intent.idempotencyKey, assertCurrent)
      } catch {
        if (prior?.receipt) return revisionReceiptResult(prior.receipt, publicFiles, false)
        if (prior?.phase === 'upload_started') return {
          status: 'upload_unknown', submitted: false, receiptConfirmed: false, materials: publicFiles,
          message: '修订材料包已固定，但文件上传结果无法确认。审批递交未确认，桌面没有重传；请核对 Forge 后重新打开事项。',
        }
        return {
          status: 'resume_unknown', submitted: false, receiptConfirmed: false, materials: publicFiles,
          message: '修订递交请求可能已发送，但回执暂时无法读取。桌面没有重提；请在 Forge 核对。',
        }
      }
      if (result.status === 404) {
        if (prior?.receipt) return revisionReceiptResult(prior.receipt, publicFiles, false)
        if (prior?.phase === 'upload_started') return {
          status: 'upload_unknown', submitted: false, receiptConfirmed: false, materials: publicFiles,
          message: '修订材料包已固定，但 Forge 没有可核对的修订回执。审批递交未确认，桌面没有重传；请核对 Forge 后重新打开事项。',
        }
        return {
          status: 'resume_unknown', submitted: false, receiptConfirmed: false, materials: publicFiles,
          message: 'Forge 没有返回修订回执。原请求可能已处理，桌面没有重提；请在 Forge 核对。',
        }
      }
      const receipt = result.status >= 200 && result.status < 300 ? revisionReceipt(result.body, intent.requestId) : undefined
      if (!receipt) {
        if (prior?.receipt) return revisionReceiptResult(prior.receipt, publicFiles, false)
        if (prior?.phase === 'upload_started') return {
          status: 'upload_unknown', submitted: false, receiptConfirmed: false, materials: publicFiles,
          message: '修订材料包已固定，但 Forge 上传/修订结果没有可核对的回执。桌面没有重传；请核对 Forge 后重新打开事项。',
        }
        return {
          status: 'resume_unknown', submitted: false, receiptConfirmed: false, materials: publicFiles,
          message: 'Forge 修订回执无效或暂不可用。桌面没有重提；请在 Forge 核对。',
        }
      }
      const progress: ReturnedRevisionProgress = {
        version: 1, phase: 'receipt', idempotencyKey: intent.idempotencyKey,
        ...(prior?.primary ? { primary: prior.primary } : {}), ...(prior?.attachments ? { attachments: prior.attachments } : {}), receipt,
      }
      await this.store.checkpoint(progressKey, progressFingerprint, progress)
      return revisionReceiptResult(receipt, publicFiles)
    }

    const saved = await this.store.inspect<ReturnedRevisionProgress>(progressKey)
    if (saved && saved.fingerprint !== progressFingerprint) throw new Error('本轮修订材料已固定；员工账号、事项或材料变化后不能继续旧请求')
    let progress = saved?.value
    if (progress && (progress.idempotencyKey !== intent.idempotencyKey || progress.version !== 1)) {
      throw new Error('修订请求恢复记录无效，请在 Forge 核对后重新打开事项')
    }
    if (progress?.phase === 'rejected') return {
      status: progress.rejectionState ?? 'rejected', submitted: false, receiptConfirmed: false, materials: publicFiles,
      message: progress.message ?? '修订材料已固定，但 Forge 拒绝了本次请求；审批未确认递交。请刷新待办。',
    }
    if (progress?.phase === 'request_started' || progress?.phase === 'receipt') return resolveReceipt(progress)
    if (progress?.phase === 'upload_started') {
      const receiptResult = await resolveReceipt(progress)
      const receiptState = receiptResult && typeof receiptResult === 'object' && !Array.isArray(receiptResult)
        ? (receiptResult as Record<string, unknown>).status : undefined
      const receiptConfirmed = receiptResult && typeof receiptResult === 'object' && !Array.isArray(receiptResult)
        ? (receiptResult as Record<string, unknown>).receiptConfirmed === true : false
      // With per-file receipts and no revision receipt in Forge, nothing was
      // submitted: the upload resumes where it stopped. An upload started before
      // such receipts were kept cannot tell which files Forge has, so it stops.
      const resumable = progress.fileReceipts === true && receiptState === 'upload_unknown' && !receiptConfirmed
      if (!resumable) {
        if (receiptState !== 'resume_unknown' || receiptConfirmed) return receiptResult
        return {
          status: 'upload_unknown', submitted: false, receiptConfirmed: false, materials: publicFiles,
          message: '修订材料包已固定，但上传结果无法确认。审批递交未发送或未确认；为避免重复文件，桌面没有重传。请核对 Forge 后重新打开事项。',
        }
      }
    }

    let references: { primary: ReturnedRevisionFileReference; attachments: ReturnedRevisionFileReference[] }
    if (progress?.phase === 'uploaded' && progress.primary && Array.isArray(progress.attachments)) {
      references = { primary: progress.primary, attachments: progress.attachments }
      const expected = [primary, ...intent.materials]
      const actual = [references.primary, ...references.attachments]
      if (actual.length !== expected.length || actual.some((file, index) => file.name !== expected[index]!.name || file.sha256 !== expected[index]!.sha256 || !file.fileId
        || ('mediaType' in expected[index]! && expected[index]!.mediaType !== undefined
          && (file.mediaType !== expected[index]!.mediaType || file.bytes !== expected[index]!.bytes)))) {
        throw new Error('上传回执与原固定材料包不一致；桌面不会重新上传')
      }
    } else if (!progress || progress.phase === 'upload_started') {
      await assertApprovalCurrent()
      // Each file keeps its own receipt, so an upload that was cut off resumes
      // where it stopped instead of uploading files Forge already has.
      progress ??= await this.store.checkpoint(progressKey, progressFingerprint, {
        version: 1, phase: 'upload_started', idempotencyKey: intent.idempotencyKey, fileReceipts: true,
      })
      try {
        const bodyBytes = intent.body ? Buffer.from(intent.body.bytesBase64, 'base64') : undefined
        if (intent.body && (!bodyBytes || bodyBytes.toString('base64') !== intent.body.bytesBase64
          || bodyBytes.length !== intent.body.bytes || digest(bodyBytes) !== intent.body.sha256)) {
          throw new Error('本地固定修订正文无法通过字节摘要校验，请勿重新读取文件')
        }
        const uploadMaterials = [
          intent.primaryMaterial ? restoreRevisionMaterial(intent.primaryMaterial) : makeFrozenTextMaterial(intent.body!.name, bodyBytes!),
          ...intent.materials.map(restoreRevisionMaterial),
        ]
        const uploaded = uploadMaterials.length ? await this.options.service.stageWorkMaterials(uploadMaterials, assertCurrent, storedUploadProgress(this.store, progressKey)) : []
        if (uploaded.length !== uploadMaterials.length || uploaded.some((file, index) => file.type !== 'forge-file'
          || file.name !== uploadMaterials[index]!.name || file.bytes !== uploadMaterials[index]!.bytes || file.sha256 !== uploadMaterials[index]!.sha256 || !file.id)) {
          throw new Error('Forge 上传回执与固定材料包不一致')
        }
        const revisionReference = (file: EnterpriseWorkResource): ReturnedRevisionFileReference => ({
          fileId: file.id, name: file.name, sha256: file.sha256,
          ...(file.mediaType === 'application/pdf' || file.mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            ? { mediaType: file.mediaType, bytes: file.bytes } : {}),
        })
        references = { primary: revisionReference(uploaded[0]!), attachments: uploaded.slice(1).map(revisionReference) }
        progress = await this.store.checkpoint(progressKey, progressFingerprint, {
          version: 1, phase: 'uploaded', idempotencyKey: intent.idempotencyKey,
          primary: references.primary, attachments: references.attachments,
        })
      } catch (error) {
        if (error instanceof Error && /登录已失效|请先登录|账号已切换|员工轮次或账号已变化/.test(error.message)) throw error
        return {
          status: 'upload_unknown', submitted: false, receiptConfirmed: false, materials: publicFiles,
          message: '修订材料包已固定，但 Forge 文件上传未能取得完整回执。审批未递交；桌面不会盲目重传，以免产生重复文件。请重新打开事项后再由员工发起新一轮。',
        }
      }
    } else {
      throw new Error('修订材料上传状态不完整；桌面只查询原回执，不会重传')
    }

    await assertApprovalCurrent()
    progress = await this.store.checkpoint(progressKey, progressFingerprint, {
      version: 1, phase: 'request_started', idempotencyKey: intent.idempotencyKey,
      primary: references.primary, attachments: references.attachments,
    })
    const request: ApprovalRevisionSubmission = {
      returnVersion: intent.returnVersion, sourceMaterialVersion: intent.sourceMaterialVersion,
      idempotencyKey: intent.idempotencyKey, primary: references.primary, attachments: references.attachments,
    }
    let response: { status: number; body: unknown }
    try {
      response = await this.options.service.submitApprovalRevision(intent.requestId, request, assertCurrent)
    } catch (error) {
      if (error instanceof Error && /登录已失效|请先登录|账号已切换|员工轮次或账号已变化/.test(error.message)) {
        throw error
      }
      return resolveReceipt(progress)
    }
    if (response.status === 404) {
      const rejected: ReturnedRevisionProgress = {
        ...progress, phase: 'rejected', rejectionState: 'unavailable',
        message: '当前 Forge 服务没有退回材料修订接口（404）。修订材料已固定，但审批未递交。',
      }
      await this.store.checkpoint(progressKey, progressFingerprint, rejected)
      return { status: 'unavailable', submitted: false, receiptConfirmed: false, materials: publicFiles, message: rejected.message }
    }
    if (response.status === 409 || response.status === 400 || response.status === 413 || response.status === 422) {
      const rejected: ReturnedRevisionProgress = {
        ...progress, phase: 'rejected', rejectionState: 'rejected',
        message: response.status === 409
          ? 'Forge 检测到审批或材料版本冲突，拒绝了本次递交。请刷新待办。'
          : response.status === 413 ? 'Forge 拒绝了超出大小限制的修订材料。审批未递交。'
            : response.status === 422 ? 'Forge 无法核验修订材料及摘要，审批未递交。请刷新材料。'
              : 'Forge 拒绝了修订材料请求，审批未递交。',
      }
      await this.store.checkpoint(progressKey, progressFingerprint, rejected)
      return { status: 'rejected', submitted: false, receiptConfirmed: false, materials: publicFiles, message: rejected.message }
    }
    const receipt = response.status >= 200 && response.status < 300 ? revisionReceipt(response.body, intent.requestId) : undefined
    if (receipt) {
      const confirmed: ReturnedRevisionProgress = { ...progress, phase: 'receipt', receipt }
      try { await this.store.checkpoint(progressKey, progressFingerprint, confirmed) }
      catch { /* request_started remains durable; the next attempt only reads the Forge receipt */ }
      return revisionReceiptResult(receipt, publicFiles)
    }
    return resolveReceipt(progress)
  }
  private async prepareDelivery(claim: CapabilityClaim, turn: EmployeeTurn, intent: FrozenHandoffIntent, recoveryKey: string): Promise<unknown> {
    try {
      const materials = normalizeFrozenMaterials(intent.materials)
      const reusedMaterials = intent.reusedMaterials ?? []
      assertHandoffMaterialCount(materials.length, reusedMaterials.length)
      const reusedResources: EnterpriseWorkResource[] = reusedMaterials.map(({ id, materialId, sourceKind, requestId, name, mediaType, bytes, sha256 }) => ({
        type: 'forge-file', id, materialId, name, mediaType, bytes, sha256,
        ...(sourceKind ? { sourceKind } : {}), ...(requestId ? { requestId } : {}),
      }))
      if (new Set(reusedResources.map(({ id }) => id)).size !== reusedResources.length
        || new Set(reusedResources.map(({ materialId }) => materialId)).size !== reusedResources.length
        || materials.some((material) => reusedResources.some((resource) => resource.materialId === material.materialId))) {
        throw new Error('复用材料清单包含重复或冲突的固定引用')
      }
      const resourcesFingerprint = digest(JSON.stringify({
        parent: intent.continuation ?? null,
        reusedResources: reusedResources.map(({ id, materialId, sourceKind, requestId, name, mediaType, bytes, sha256 }) => ({ id, materialId, sourceKind, requestId, name, mediaType, bytes, sha256 })),
        newMaterials: materials.map(({ name, bytes, sha256, sourceKind, materialId }) => ({ name, bytes, sha256, sourceKind, materialId })),
      }))
      const resourcesKey = `${intent.accountKey}:${intent.idempotencySeed}:resources`
      const frozen = await this.store.freeze<FrozenHandoff>(resourcesKey, resourcesFingerprint, async () => {
        const stagedResources = materials.length
          ? await this.options.service.stageWorkMaterials(materials, async () => {
              await this.evidence(claim, turn)
              await this.assertWorkContinuationCurrent(claim, turn, reusedMaterials.length > 0)
            }, storedUploadProgress(this.store, resourcesKey))
          : []
        await this.evidence(claim, turn)
        return { ...intent, materials, reusedMaterials, resources: [...reusedResources, ...stagedResources] }
      })
      if (frozen.resources.length !== reusedResources.length + materials.length || frozen.resources.some((resource, index) => {
        if (index < reusedResources.length) {
          const expected = reusedResources[index]!
          return resource.type !== 'forge-file' || resource.id !== expected.id || resource.materialId !== expected.materialId
            || resource.name !== expected.name || resource.mediaType !== expected.mediaType || resource.bytes !== expected.bytes
            || resource.sha256 !== expected.sha256 || resource.sourceKind !== expected.sourceKind || resource.requestId !== expected.requestId
        }
        const material = materials[index - reusedResources.length]!
        return resource.type !== 'forge-file' || !resource.id || resource.name !== material.name
          || resource.bytes !== material.bytes || resource.sha256 !== material.sha256
          || (resource.mediaType !== undefined && resource.mediaType !== material.mediaType)
          || resource.sourceKind !== material.sourceKind
          || resource.requestId !== undefined
          || (resource.materialId !== undefined && resource.materialId !== material.materialId)
      })) throw new Error('Forge 文件引用与本地固定材料清单不一致')
      const resources = frozen.resources.map((resource, index) => index < reusedResources.length
        ? resource
        : { ...resource, materialId: materials[index - reusedResources.length]!.materialId, mediaType: materials[index - reusedResources.length]!.mediaType })
      return this.deliver(claim, turn, { ...frozen, materials, reusedMaterials, resources }, recoveryKey)
    } catch (error) {
      if (error instanceof WorkRegistrationRejectedError) return { status: 'rejected', submitted: false, message: error.message }
      return {
        status: 'unknown', recovery_key: recoveryKey,
        message: error instanceof Error ? error.message : '材料交付结果待核对',
        next_step: '已保留本次固定材料。员工仍要求交接时使用恢复工具继续，不得重读或换成另一版材料。',
      }
    }
  }
  private async deliver(claim: CapabilityClaim, turn: EmployeeTurn, frozen: FrozenHandoff, recoveryKey: string): Promise<unknown> {
    await this.evidence(claim, turn)
    await this.assertWorkContinuationCurrent(claim, turn, (frozen.reusedMaterials?.length ?? 0) > 0)
    const restartAfterFailedRun = frozen.continuation && turn.workContinuation?.context.run.status === 'failed'
      && frozen.authorizedBusinessCapabilityIds.length === 0
    const pending = this.inFlight.get(recoveryKey)
    if (pending) return pending
    const operation = this.options.service.submitWork(frozen.choice, frozen.task, {
      idempotencySeed: frozen.idempotencySeed, sessionKey: frozen.sessionKey, sourceMessages: frozen.sourceMessages, accountKey: frozen.accountKey,
      resources: frozen.resources,
      fixDelegationIntent: async (inputRevisionID, scope) => {
        await this.assertWorkContinuationCurrent(claim, turn, (frozen.reusedMaterials?.length ?? 0) > 0)
        const fingerprint = digest(JSON.stringify(scope))
        const intent = await this.store.freeze(`${frozen.accountKey}:${frozen.idempotencySeed}:task-authorization`, fingerprint, async () => ({ inputRevisionID, requestID: randomUUID() }))
        await this.evidence(claim, turn)
        return intent
      },
      businessContext: frozen.businessContext,
      continuation: frozen.continuation ? { ...frozen.continuation, ...(restartAfterFailedRun ? { restartAfterFailedRun: true } : {}) } : undefined,
      authorizedBusinessCapabilityIds: frozen.authorizedBusinessCapabilityIds,
      assertCurrent: async () => {
        await this.evidence(claim, turn)
        if (turn.workContinuation && (this.workContinuations.get(claim.token) !== turn.workContinuation || this.workLineages.get(claim.token) !== turn.workContinuation)) {
          throw new Error('团队工作上下文已失效，请重新打开工作消息')
        }
      },
    }).then(async (receipt) => {
      let continuationLinked: boolean | undefined
      if (frozen.continuation && this.workLineages.get(claim.token) === turn.workContinuation) {
        continuationLinked = false
        if (receipt.inputRevisionId && claim.sessionPath) {
          try {
            const nextContext = await this.options.service.getWorkContinuationContext({
              workReference: receipt.inputRevisionId,
              runReference: receipt.runId,
              sessionReference: frozen.continuation.workbenchSessionID,
            })
            if (nextContext.source.inputRevisionID === receipt.inputRevisionId
              && nextContext.source.runID === receipt.runId
              && nextContext.source.workbenchSessionID === frozen.continuation.workbenchSessionID
              && nextContext.input.teamID === frozen.continuation.teamID
              && this.claimForToken(claim.token) === claim
              && await this.options.service.accountKey() === turn.accountKey) {
              const nextLineage: BoundWorkContinuation = {
                kind: 'weave', accountKey: turn.accountKey, context: nextContext,
                fingerprint: workContinuationFingerprint(nextContext), createdAt: Date.now(), sessionPath: claim.sessionPath,
              }
              this.workLineages.set(claim.token, nextLineage)
              continuationLinked = true
            }
          } catch {
            /* The durable run is accepted; keep the UI on the same session, then open its new notification to refresh lineage. */
          }
        }
      }
      // The scope line is written by the Host from the frozen request, not by
      // the model, so the employee sees exactly what the team may do (C30).
      const actionLabels = new Map([...(this.businessActions.get(claim.token)?.get(handoffKey(frozen.choice))?.values() ?? [])].map((action) => [action.id, action.name]))
      const materialCount = (frozen.reusedMaterials?.length ?? 0) + frozen.materials.length
      const allowedScope = (frozen.authorizedBusinessCapabilityIds.length
        ? `本次允许团队执行：${frozen.authorizedBusinessCapabilityIds.map((id) => actionLabels.get(id) ?? '已选业务动作').join('、')}`
        : '本次只交给团队查看和分析，不允许业务写入')
        + (frozen.businessContext ? `；业务记录：${frozen.businessContext.name}` : '') + (materialCount ? `；${materialCount} 份材料` : '')
      return {
        status: 'accepted', team: frozen.choice.teamName, workflow: frozen.choice.workflowName,
        allowed_scope: allowedScope,
        scope_display: taskScopeDisplay(frozen, receipt.runId, actionLabels),
        repeated: receipt.repeated, recovery_key: recoveryKey,
        ...(continuationLinked === false ? { next_step: '团队已在原工作下接单。后续继续时请从新工作消息打开，以核对最新版本。' } : {}),
        materials: [
          ...(frozen.reusedMaterials ?? []).map(({ name }) => ({ name })),
          ...frozen.materials.map(({ name }) => ({ name })),
        ],
        receipt,
      }
    }).catch((error: unknown) => error instanceof WorkRegistrationRejectedError ? {
      status: 'rejected', submitted: false, receiptConfirmed: false, message: error.message,
      next_step: 'Weave 已明确拒绝本次登记，未创建团队运行。请刷新原工作并按当前员工要求重新提交。',
    } : {
      status: 'unknown', recovery_key: recoveryKey,
      message: error instanceof Error ? error.message : '接单结果待核对',
      next_step: '保留原包。员工仍要求交接时使用恢复工具核对同一请求，不得重新提交另一份工作。',
    })
    this.inFlight.set(recoveryKey, operation)
    try { return await operation } finally { this.inFlight.delete(recoveryKey) }
  }
}
