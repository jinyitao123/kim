import type { FrozenAuthorizationRenewal, RenewalObserver, AuthorizationRenewalResult } from './enterprise/task-renewal'
import { materialUploadKey, type MaterialUploadProgress } from './enterprise/upload-progress'
import type { ForgeTaskScope } from './enterprise/task-handoff'
import type { FixedWorkSource } from './enterprise/task-handoff'
import { teamWorkspaceRequest } from './enterprise/team-workspace'
import type { TeamWorkspaceCommand } from '../../src/types/team-workspace'
import type { EnterpriseApprovalContext, EnterpriseApprovalContextView, EnterpriseBusinessCapability, EnterpriseBusinessCapabilityBinding, EnterpriseBusinessCapabilityCatalog, EnterpriseClientSession, EnterpriseCreateTeamInput, EnterpriseCreateTeamMemberInput, EnterpriseCreateTeamResult, EnterpriseCreateWorkflowInput, EnterpriseCreateWorkflowResult, EnterpriseDevelopmentOverview, EnterpriseEnvironmentStatus, EnterpriseHumanTask, EnterprisePermission, EnterpriseSession, EnterpriseTeamMember, EnterpriseTeamMemberAgentConfiguration, EnterpriseTeamMemberConfigDraft, EnterpriseTeamMemberMutationResult, EnterpriseTeamMemberRelationshipConfiguration, EnterpriseTeamObservation, EnterpriseUpdateTeamInput, EnterpriseUpdateWorkflowDraftInput, EnterpriseUpdateWorkflowDraftResult, EnterpriseWorkflowGraphDefinition, EnterpriseWorkflowObservation, EnterpriseWorkflowValidation, EnterpriseWorkChoice, EnterpriseWorkOverview, EnterpriseWorkReceipt, EnterpriseWorkResource, WorkspaceMaterialMimeType } from '../../src/types/api'
import { extractOriginalMaterialText, freezeApprovalOriginalMaterial, normalizeFrozenMaterial, validateFrozenMaterial, MAX_WORKSPACE_EXTRACTION_BYTES, MAX_WORKSPACE_MATERIAL_BYTES, type FrozenApprovalOriginalMaterial, type FrozenMaterial, type MaterialExtraction } from './enterprise/materials'
import { createHash, randomUUID } from 'node:crypto'
import { teamCatalog, teamChoices, type TeamSummary } from './enterprise/team-catalog'
import type { ForgeBusinessReader, BusinessObjectDirectory, BusinessRecordRead, BusinessRecordSearchPage } from './enterprise/business-records'
import { ForgeBusinessReadError } from './enterprise/business-read-error'
import { EmployeeWorkCanceller } from './enterprise/task-cancellation'
import type { EmployeeBusinessRequest, EmployeeBusinessSelection, EmployeeBusinessTarget } from '../../src/types/employee-business'
import type { ApprovalUiAttempt } from './enterprise/approval-ui-actions'
import { approvalUiChoices } from './enterprise/approval-context-binding'
import { deviceSignIn, type PendingDeviceSignIn } from './enterprise/device-sign-in'
import type { SessionTokenStore } from './enterprise/session-token-store'
import type { InitializationAction, NativeInitializationActionArguments } from '../../src/types/enterprise-initialization'

const DEFAULT_FORGE_URL = 'http://127.0.0.1:3000'
const DEFAULT_WEAVE_URL = 'http://127.0.0.1:8080'
const REQUEST_TIMEOUT_MS = 8_000

interface EnterpriseServiceOptions {
  fetch?: typeof fetch
  environment?: NodeJS.ProcessEnv
  /** Opens the sign-in confirmation page in the employee's browser. */
  openExternal?(url: string): Promise<void>
  /** Keeps the native session token across restarts; absent, the session lasts until the app quits. */
  tokenStore?: SessionTokenStore
  /** Waits between polls of a pending sign-in; replaced in tests. */
  signInDelay?(milliseconds: number, signal: AbortSignal): Promise<void>
}

/** The saved or just-issued Forge session no longer signs anyone in. */
class NativeSessionEnded extends Error {}

type EnterpriseAuthProvider = 'forge' | 'weave'
interface EnterpriseAuthSnapshot { generation: number; provider: EnterpriseAuthProvider; token: string }
export interface ApprovalRevisionFileReference { fileId: string; name: string; sha256: string; mediaType?: WorkspaceMaterialMimeType; bytes?: number }
export interface ApprovalRevisionSubmission {
  returnVersion: string
  sourceMaterialVersion: string
  idempotencyKey: string
  primary: ApprovalRevisionFileReference
  attachments: ApprovalRevisionFileReference[]
}
export interface ForgeHttpResult { status: number; body: unknown }
export interface NativeMcpActionAttempt {
  status: 'returned' | 'rejected' | 'unknown'
  result?: unknown
  code?: string
  message?: string
}
export interface NativeMcpActionArguments {
  actionName: string
  objectName: string
  recordId: string
  params: Record<string, string>
}
export class WorkRegistrationRejectedError extends Error {}
class WeaveHttpError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message) }
}
export interface EnterpriseWeaveWorkNotificationSource {
  version: '1'
  notificationID: string
  kind: 'result' | 'failure' | 'revision_required' | 'cancelled' | 'human_review'
  source: { system: 'weave'; workReference: string; runReference: string; sessionReference: string; interactionReference?: string }
}
export interface EnterpriseBusinessWorkNotificationSource {
  version: '1'
  notificationID: string
  kind: 'business'
  source: { system: 'forge'; objectName: string; recordId: string }
  materialStatus: 'available' | 'none' | 'unavailable'
  originalFiles: Array<{
    sourceKind: 'owner' | 'approval'
    requestId?: string
    fileId: string
    name: string
    mediaType: 'application/pdf' | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    bytes: number
    sha256: string
  }>
}
export type EnterpriseWorkNotificationSource = EnterpriseWeaveWorkNotificationSource | EnterpriseBusinessWorkNotificationSource
export interface EnterpriseBusinessNotificationContext {
  kind: 'business'
  notificationID: string
  source: EnterpriseBusinessWorkNotificationSource['source']
  materialStatus: EnterpriseBusinessWorkNotificationSource['materialStatus']
  materialReferences: EnterpriseBusinessWorkNotificationSource['originalFiles']
  record: BusinessRecordRead
  currentReadAt: string
  materials: Array<EnterpriseBusinessWorkNotificationSource['originalFiles'][number] & { extraction: MaterialExtraction }>
}
export interface EnterpriseWorkContinuationContext {
  version: '1'
  source: { inputRevisionID: string; runID: string; workbenchSessionID: string; inputStatus?: 'current' | 'superseded' | 'closed'; supersededByInputRevisionID?: string }
  input: {
    registrationID?: string
    authorizedBusinessCapabilityIDs?: string[]
    task: string
    taskSHA256: string
    teamID: string
    workflowID: string
    workflowVersion: number
    materials: Array<{
      id: string
      name: string
      bytes: number
      sha256: string
      materialId?: string
      mediaType?: WorkspaceMaterialMimeType | 'text/plain; charset=utf-8'
      sourceKind?: 'owner' | 'approval'
      requestId?: string
      content?: string
      extraction?: MaterialExtraction
    }>
    sourceMessages: Array<{ messageID: string; eventSeq: number; sha256: string }>
    businessRecord?: { objectName: string; recordID: string; recordVersion?: string }
    parent?: { rootInputRevisionID: string; parentInputRevisionID?: string; parentRunID?: string }
  }
  run: {
    authorization?: { status: 'active' | 'renewal_required' | 'not_applicable'; reason?: string; grantID?: string; generation?: number; expiresAt?: string; scope?: ForgeTaskScope; canRenew: boolean; retryNodeID?: string }
    status: 'queued' | 'running' | 'parked' | 'cancel_requested' | 'succeeded' | 'failed' | 'cancelled' | 'abandoned'
    businessResult?: 'completed' | 'needs_input' | 'action_failed' | 'action_unknown'
    finalResult?: {
      id: string; title: string; contentType: string; content: string; sha256: string
      disposition?: 'complete' | 'needs_input'; summary?: string; missingItems?: string[]
    }
    actionOutcomes?: Array<{ nodeID: string; callID: string; actionName: string; objectName: string; recordID?: string; status: 'succeeded' | 'failed' | 'unknown'; summary: string }>
  }
}

function environmentUrl(value: string | undefined, fallback: string, label: string): URL {
  const configured = value?.trim() || fallback
  const url = new URL(configured)
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) throw new Error(`${label} environment URL must be an HTTP or HTTPS origin without credentials`)
  url.pathname = '/'
  url.search = ''
  url.hash = ''
  return url
}

function versionFromHealth(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const source = value as Record<string, unknown>
  if (typeof source.version === 'string' && source.version.length <= 80) return source.version
  return versionFromHealth(source.data)
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function enterprisePermissions(value: unknown): EnterprisePermission[] | undefined {
  if (!Array.isArray(value)) return undefined
  const permissions = value.filter((item): item is EnterprisePermission => item === 'teams:use' || item === 'teams:develop' || item === 'teams:admin')
  return permissions.includes('teams:use') ? Array.from(new Set(permissions)) : undefined
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}


export function approvalContextView(context: EnterpriseApprovalContext): EnterpriseApprovalContextView {
  return {
    ...approvalUiChoices(context),
    title: context.title,
    step: context.step,
    ...(context.returnReason !== undefined ? { returnReason: context.returnReason } : {}),
    fields: context.fields.map((field) => ({ ...field })),
    ...(context.quotationLines ? { quotationLines: { ...context.quotationLines, rows: context.quotationLines.rows.map((row) => ({ ...row })) } } : {}),
    files: context.files.map(({ name, content, verified }) => ({ name, content, verified })),
    ...(context.originalFiles ? { originalFiles: context.originalFiles.map(({ name, mediaType, bytes, extraction }) => ({
      name, mediaType, bytes, verified: true,
      extraction: {
        status: extraction.status, content: extraction.content,
        coverage: { ...extraction.coverage }, limitations: [...extraction.limitations],
      },
    })) } : {}),
  }
}

async function responseErrorCode(response: Response): Promise<string | undefined> {
  try {
    const envelope = record(await response.json())
    const error = record(envelope?.error)
    const code = textValue(error?.code)
    return code && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : undefined
  } catch {
    return undefined
  }
}

async function readExactResponseBytes(response: Response, expectedBytes: number): Promise<Buffer> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Forge 原件响应内容为空')
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > expectedBytes) {
        await reader.cancel()
        throw new Error('Forge 原件超过冻结长度，已停止读取')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  if (totalBytes !== expectedBytes) throw new Error('Forge 原件长度与冻结版本不一致')
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), totalBytes)
}

function forgeMcpReadError(message: string): ForgeBusinessReadError {
  if (/403|forbidden|permission|not authorized|access denied|unknown tool|not registered|data:read|无权|权限|未授权|拒绝/i.test(message)) {
    return new ForgeBusinessReadError('forbidden', '当前账号没有读取该业务数据的权限')
  }
  if (/not found|does not exist|no such (?:object|record)|不存在|未找到/i.test(message)) {
    return new ForgeBusinessReadError('not_found', '当前员工无法读取所选业务记录')
  }
  return new ForgeBusinessReadError('failed', 'Forge 原生读取工具执行失败，请刷新后重试')
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

const BUSINESS_CAPABILITY_SCALAR_TYPES = new Set(['string', 'text', 'textarea', 'email', 'url', 'date', 'datetime', 'number', 'integer', 'currency', 'boolean', 'file', 'select', 'enum', 'picklist'])
const BUSINESS_ACTION_METADATA_MAX_BYTES = 4 * 1024 * 1024

interface BusinessActionObjectMetadata {
  name: string
  actions: unknown[]
  fields: Record<string, unknown>
}

interface ResolvedBusinessActionParameter {
  name: string
  type: string
  multiple: boolean
  enum: string[]
  usesObjectOverride: boolean
}

function businessCapabilityUnavailableReason(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) return '业务参数结构暂不支持，当前不能绑定/执行'
  for (const raw of value) {
    const parameter = record(raw)
    if (!parameter || !(textValue(parameter.name) ?? textValue(parameter.field))) return '业务参数结构暂不支持，当前不能绑定/执行'
    const type = (textValue(parameter.type) ?? 'string').toLowerCase()
    if (type === 'array') {
      return record(parameter.items)
        ? '数组条目结构当前不能绑定/执行'
        : '数组缺少条目结构，当前不能绑定/执行'
    }
    if (!BUSINESS_CAPABILITY_SCALAR_TYPES.has(type)) return '业务参数结构暂不支持，当前不能绑定/执行'
  }
  return undefined
}

function businessCapabilityParams(value: unknown): NonNullable<EnterpriseBusinessCapability['params']> {
  return Array.isArray(value) ? value.flatMap((item) => {
    const param = record(item), name = textValue(param?.name) ?? textValue(param?.field)
    if (!name) return []
    const rawType = (textValue(param?.type) ?? 'string').toLowerCase()
    const type: NonNullable<EnterpriseBusinessCapability['params']>[number]['type'] = rawType === 'file' ? 'file'
      : rawType === 'boolean' ? 'boolean'
        : rawType === 'array' ? 'array'
          : ['number', 'integer', 'currency'].includes(rawType) ? 'number'
            : BUSINESS_CAPABILITY_SCALAR_TYPES.has(rawType) ? 'string' : 'unsupported'
    const options = Array.isArray(param?.enum) ? param.enum : Array.isArray(param?.options) ? param.options : []
    const values = options.flatMap((option) => typeof option === 'string' ? [option] : textValue(record(option)?.value) ? [textValue(record(option)?.value)!] : [])
    return [{ name, label: textValue(param?.label) ?? textValue(param?.title), type, multiple: param?.multiple === true, required: param?.required === true, description: textValue(param?.description) ?? '', ...(values.length ? { enum: values } : {}) }]
  }) : []
}

function businessActionObjectMetadata(value: unknown, expectedName: string): BusinessActionObjectMetadata {
  const envelope = record(value), item = record(envelope?.item)
  if (envelope?.type !== 'object' || envelope.name !== expectedName || item?.name !== expectedName || !Array.isArray(item.actions)) {
    throw new Error(`Forge 对象 ${expectedName} 的原生动作声明无效`)
  }
  const fields = record(item.fields) ?? {}
  return { name: expectedName, actions: item.actions, fields }
}

function objectStackBusinessActionType(type: string): string {
  switch (type) {
    case 'number': case 'currency': case 'percent': case 'rating': case 'slider': case 'autonumber': return 'number'
    case 'boolean': case 'toggle': return 'boolean'
    case 'multiselect': case 'checkboxes': case 'tags': return 'array'
    default: return 'string'
  }
}

function businessActionEnumValues(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((option) => typeof option === 'string' ? [option] : textValue(record(option)?.value) ? [textValue(record(option)?.value)!] : [])
}

function resolveBusinessActionParameters(
  summaryAction: Record<string, unknown>,
  declaration: Record<string, unknown>,
  objectName: string,
  objectMetadataByName: Map<string, BusinessActionObjectMetadata>,
): NonNullable<EnterpriseBusinessCapability['params']> {
  const summaryParams = summaryAction.params === undefined || summaryAction.params === null ? [] : summaryAction.params
  const declaredParams = declaration.params === undefined || declaration.params === null ? [] : declaration.params
  if (!Array.isArray(summaryParams) || !Array.isArray(declaredParams)) throw new Error('Forge 业务动作参数声明不是列表')

  const resolved = new Map<string, ResolvedBusinessActionParameter>()
  for (const raw of declaredParams) {
    const parameter = record(raw)
    if (!parameter) throw new Error('Forge 原生参数声明无效')
    const fieldName = textValue(parameter.field)
    const name = textValue(parameter.name) ?? fieldName
    if (!name) continue
    if (resolved.has(name)) throw new Error(`Forge 原生参数 ${name} 重复`)
    if (parameter.required !== undefined && parameter.required !== null && typeof parameter.required !== 'boolean'
      || parameter.multiple !== undefined && parameter.multiple !== null && typeof parameter.multiple !== 'boolean') {
      throw new Error(`Forge 原生参数 ${name} 的 required 或 multiple 无效`)
    }

    let field: Record<string, unknown> | undefined
    let usesObjectOverride = false
    if (fieldName) {
      const overrideName = textValue(parameter.objectOverride)
      let fieldObject = objectMetadataByName.get(objectName)
      if (overrideName) {
        fieldObject = objectMetadataByName.get(overrideName)
        if (!fieldObject || fieldObject.name !== overrideName) throw new Error(`Forge 参数 ${name} 引用的对象字段不可读取`)
        usesObjectOverride = true
      }
      field = record(fieldObject?.fields[fieldName])
      if (!field) throw new Error(`Forge 参数 ${name} 引用的字段不可读取`)
    }
    const type = textValue(parameter.type)?.trim() || textValue(field?.type)?.trim()
    if (!type) throw new Error(`Forge 原生参数 ${name} 没有可确认的类型`)
    const fieldMultiple = typeof field?.multiple === 'boolean' ? field.multiple : false
    const multiple = typeof parameter.multiple === 'boolean' ? parameter.multiple : fieldMultiple
    const parameterOptions = parameter.options
    const options = parameterOptions === undefined || parameterOptions === null ? field?.options : parameterOptions
    resolved.set(name, { name, type, multiple, enum: businessActionEnumValues(options), usesObjectOverride })
  }
  if (resolved.size !== summaryParams.length) throw new Error('Forge 原生参数声明与员工可调用动作不一致')

  const seenSummary = new Set<string>()
  const normalizedSummary = businessCapabilityParams(summaryParams)
  if (normalizedSummary.length !== summaryParams.length) throw new Error('Forge 员工可调用动作参数摘要无效')
  return summaryParams.flatMap((raw, index) => {
    const summary = record(raw), name = textValue(summary?.name) ?? textValue(summary?.field)
    const summaryType = textValue(summary?.type)
    if (!summary || !name || !summaryType || typeof summary.required !== 'boolean' || seenSummary.has(name)) {
      throw new Error('Forge 员工可调用动作参数摘要缺少唯一名称、类型或必填状态')
    }
    seenSummary.add(name)
    const parameter = resolved.get(name)
    if (!parameter) throw new Error(`Forge 原生声明缺少员工可调用参数 ${name}`)
    const expectedSummaryType = objectStackBusinessActionType(parameter.type)
    if (summaryType !== expectedSummaryType && !parameter.usesObjectOverride) {
      throw new Error(`Forge 员工参数 ${name} 与原生声明类型不一致`)
    }
    const normalizedType: NonNullable<EnterpriseBusinessCapability['params']>[number]['type'] = parameter.type === 'file'
      ? 'file'
      : objectStackBusinessActionType(parameter.type) as 'string' | 'number' | 'boolean' | 'array'
    const normalized = normalizedSummary[index]!
    return [{
      ...normalized,
      type: normalizedType,
      multiple: parameter.multiple,
      ...(parameter.enum.length ? { enum: parameter.enum } : {}),
    }]
  })
}

const materialBindingSources = ['materials.single.id', 'materials.single.name', 'materials.single.sha256', 'materials.manifest_json', 'materials.ids'] as const

function businessCapabilityBindings(value: unknown): EnterpriseBusinessCapabilityBinding[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const binding = record(item), capabilityId = textValue(binding?.capability_id) ?? textValue(binding?.capabilityId)
    if (!capabilityId || !Array.isArray(binding?.parameters)) throw new Error('Weave 返回的业务字段映射无效')
    const parameters = binding.parameters.flatMap((parameter) => {
      const source = record(parameter), name = textValue(source?.name), resource = textValue(source?.source)
      if (!name || !resource || !materialBindingSources.includes(resource as typeof materialBindingSources[number])) throw new Error('Weave 返回了无法识别的业务字段来源')
      return [{ name, source: resource as EnterpriseBusinessCapabilityBinding['parameters'][number]['source'] }]
    })
    if (!parameters.length) throw new Error('Weave 返回了没有参数的业务字段映射')
    return [{ capabilityId, parameters }]
  })
}

function parseMcpResponse(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed) throw new Error('Forge 没有返回业务能力')
  if (trimmed.startsWith('{')) return JSON.parse(trimmed)
  const data = trimmed.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).find((line) => line && line !== '[DONE]')
  if (!data) throw new Error('Forge 返回了无法识别的业务能力')
  return JSON.parse(data)
}

function memberAgentConfiguration(value: Record<string, unknown>, agentName: string): EnterpriseTeamMemberAgentConfiguration {
  const outputSchema = value.output_schema === undefined || value.output_schema === null ? '' : JSON.stringify(value.output_schema, null, 2)
  const skills = Array.isArray(value.skills) ? value.skills.flatMap((item) => {
    const skill = record(item), name = textValue(skill?.name), body = textValue(skill?.body)
    return name && body ? [{ name, description: textValue(skill?.description) ?? '', body, alwaysActive: skill?.always_active === true }] : []
  }) : []
  return {
    toolLoopControl: record(value.tool_loop_control) ? { sliceRounds: Number(record(value.tool_loop_control)?.slice_rounds), initialTotalRounds: Number(record(value.tool_loop_control)?.initial_total_rounds) } : null, maxToolRepeats: Number(value.max_tool_repeats ?? 0),
    displayName: textValue(value.display_name) ?? agentName, role: textValue(value.role) ?? 'worker',
    engine: textValue(value.engine) ?? 'loom', runtimeId: textValue(value.runtime_id) ?? '', model: textValue(value.model) ?? '',
    systemPrompt: typeof value.system_prompt === 'string' ? value.system_prompt : '', skillNames: stringList(value.skill_names), skills,
    mcpServerIds: stringList(value.mcp_server_ids), businessCapabilityIds: stringList(value.business_capability_ids), businessCapabilityBindings: businessCapabilityBindings(value.business_capability_bindings), permissionAllow: stringList(value.permission_allow),
    permissionAsk: stringList(value.permission_ask), permissionDeny: stringList(value.permission_deny),
    memoryEnabled: value.memory_enabled === true, memoryScope: textValue(value.memory_scope) ?? 'tenant',
    maxTokens: numberValue(value.max_tokens) ?? 0, maxOutputTokens: numberValue(value.max_output_tokens) ?? 0,
    stepBudget: numberValue(value.step_budget) ?? 0, maxCostUsd: numberValue(value.max_cost_usd) ?? 0, outputSchema,
  }
}

function memberRelationshipConfiguration(value: Record<string, unknown>): EnterpriseTeamMemberRelationshipConfiguration {
  return {
    duty: typeof value.duty === 'string' ? value.duty : '', whenToUse: typeof value.when_to_use === 'string' ? value.when_to_use : '',
    contextInstruction: typeof value.context_instruction === 'string' ? value.context_instruction : '', allowedKinds: stringList(value.allowed_kinds),
    defaultKind: typeof value.default_kind === 'string' ? value.default_kind : '', resultRequirement: typeof value.result_requirement === 'string' ? value.result_requirement : '',
    enabled: value.enabled !== false,
  }
}

function teamMemberConfigDraft(value: unknown): EnterpriseTeamMemberConfigDraft {
  const source = record(value), configuration = record(source?.configuration), relationship = record(source?.relationship)
  const publishedConfiguration = record(source?.published_configuration), publishedRelationship = record(source?.published_relationship)
  const teamId = textValue(source?.team_id), agentId = textValue(source?.agent_id), agentName = textValue(source?.agent_name)
  const baseAgentVersion = numberValue(source?.base_agent_version), revision = numberValue(source?.revision), updatedAt = textValue(source?.updated_at)
  if (!source || !configuration || !relationship || !teamId || !agentId || !agentName || !baseAgentVersion || revision === undefined || !updatedAt) throw new Error('Weave 返回了无法识别的团队成员配置')
  return {
    version: '1', teamId, agentId, agentName, baseAgentVersion, revision, updatedAt,
    ...(textValue(source.updated_by) ? { updatedBy: textValue(source.updated_by) } : {}),
    ...(publishedConfiguration ? { publishedConfiguration: memberAgentConfiguration(publishedConfiguration, agentName) } : {}),
    ...(publishedRelationship ? { publishedRelationship: memberRelationshipConfiguration(publishedRelationship) } : {}),
    configuration: memberAgentConfiguration(configuration, agentName),
    relationship: memberRelationshipConfiguration(relationship),
  }
}

function member(value: unknown): EnterpriseTeamMember | undefined {
  const source = record(value)
  const id = textValue(source?.id)
  const name = textValue(source?.display_name) ?? textValue(source?.name)
  if (!source || !id || !name) return undefined
  return {
    id, name, role: textValue(source.role) ?? 'worker', enabled: source.enabled !== false,
    ...(textValue(source.configured_duty) ?? textValue(source.duty) ? { duty: textValue(source.configured_duty) ?? textValue(source.duty) } : {}),
  }
}

function workflowGraph(value: unknown): Pick<EnterpriseWorkflowObservation, 'nodes' | 'edges'> {
  const graph = record(value)
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes.flatMap((item) => {
    const source = record(item)
    const config = record(source?.config)
    const id = textValue(source?.id)
    const type = textValue(source?.type)
    if (!id || !type) return []
    return [{ id, type, ...(textValue(source?.label) ? { label: textValue(source?.label) } : {}), ...(textValue(config?.agent_id) ? { workerId: textValue(config?.agent_id) } : {}) }]
  }) : []
  const edges = Array.isArray(graph?.edges) ? graph.edges.flatMap((item) => {
    const source = record(item)
    const from = textValue(source?.from) ?? textValue(source?.source) ?? textValue(source?.from_node_id)
    const to = textValue(source?.to) ?? textValue(source?.target) ?? textValue(source?.to_node_id)
    if (!from || !to) return []
    return [{ from, to, ...(textValue(source?.label) ? { label: textValue(source?.label) } : {}), ...(textValue(source?.route) ? { route: textValue(source?.route) } : {}) }]
  }) : []
  return { nodes, edges }
}


function workflowDefinition(value: unknown): EnterpriseWorkflowGraphDefinition | undefined {
  const graph = record(value)
  if (!graph || numberValue(graph.schema_version) !== 1 || !textValue(graph.entry_node_id) || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return undefined
  const nodes = graph.nodes.flatMap((item) => {
    const node = record(item), id = textValue(node?.id), type = textValue(node?.type)
    return node && id && type ? [{ ...node, id, type }] : []
  })
  const edges = graph.edges.flatMap((item) => {
    const edge = record(item), from = textValue(edge?.from_node_id), to = textValue(edge?.to_node_id)
    return edge && from && to ? [{ ...edge, from_node_id: from, to_node_id: to }] : []
  })
  if (nodes.length !== graph.nodes.length || edges.length !== graph.edges.length) return undefined
  return { ...graph, schema_version: 1, entry_node_id: textValue(graph.entry_node_id)!, nodes, edges }
}


const CONTINUATION_TOTAL_BYTES = 8 * 1024 * 1024
const CONTINUATION_TEXT_TYPES = new Set([
  'text/plain', 'text/plain; charset=utf-8',
  'text/markdown', 'text/markdown; charset=utf-8',
  'text/csv', 'text/csv; charset=utf-8',
  'application/json', 'application/json; charset=utf-8',
])
function continuationTextType(value: string): WorkspaceMaterialMimeType {
  return value.replace(/; charset=utf-8$/i, '').toLowerCase() as WorkspaceMaterialMimeType
}
function isContinuationOriginalType(value: WorkspaceMaterialMimeType | 'text/plain; charset=utf-8'): value is 'application/pdf' | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' {
  return value === 'application/pdf' || value === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
}

function boundedIdentity(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && value.trim() === value && !value.includes('\0') ? value : undefined
}


/** Read-only environment visibility. Account binding is reintroduced through the MVP1 contract. */
export class EnterpriseService {
  private readonly approvalUiAttempts = new Map<string, ApprovalUiAttempt>()
  private readonly environment: NodeJS.ProcessEnv
  private readonly fetch: typeof fetch
  private readonly forgeUrl: URL
  private readonly weaveUrl: URL
  private readonly businessReader: () => Promise<ForgeBusinessReader>
  private authGeneration = 0
  private loginAttempt = 0
  private session?: EnterpriseSession
  private weaveToken?: string
  private forgeToken?: string
  private nativeForgeIdentity?: { id: string; organizationID?: string }
  private readonly openExternal?: (url: string) => Promise<void>
  private readonly tokenStore?: SessionTokenStore
  private readonly signInDelay?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  private pendingSignIn?: PendingDeviceSignIn
  private signInAbort?: AbortController
  private restoring?: Promise<unknown>
  private readonly workCanceller = new EmployeeWorkCanceller()
  private expiresAt = 0
  private sessionScopeChangeHandler?: (session: EnterpriseSession, generation: number, phase: 'sign-in-start' | 'signed-in' | 'signed-out') => Promise<void>

  constructor(options: EnterpriseServiceOptions = {}) {
    this.environment = options.environment ?? process.env
    this.fetch = options.fetch ?? fetch
    this.openExternal = options.openExternal
    this.tokenStore = options.tokenStore
    this.signInDelay = options.signInDelay
    this.forgeUrl = environmentUrl(this.environment.WORKBENCH_FORGE_URL, DEFAULT_FORGE_URL, 'Forge')
    this.weaveUrl = environmentUrl(this.environment.WORKBENCH_WEAVE_URL, DEFAULT_WEAVE_URL, 'Weave')
    let businessReader: Promise<ForgeBusinessReader> | undefined
    this.businessReader = () => businessReader ??= import('./enterprise/business-records').then(({ ForgeBusinessReader }) => new ForgeBusinessReader(
      (name, args, generation) => this.forgeMcpTool(name, args, generation),
      (objectName, generation) => this.forgeObjectMetadata(objectName, generation),
    ))
  }

  setSessionScopeChangeHandler(handler: (session: EnterpriseSession, generation: number, phase: 'sign-in-start' | 'signed-in' | 'signed-out') => Promise<void>): void {
    this.sessionScopeChangeHandler = handler
  }

  private async notifySessionScopeChanged(session: EnterpriseSession, phase: 'sign-in-start' | 'signed-in' | 'signed-out'): Promise<void> {
    await this.sessionScopeChangeHandler?.(structuredClone(session), this.authGeneration, phase)
  }

  isSessionGenerationCurrent(generation: number): boolean { return generation === this.authGeneration }

  accountKeyForSession(session: EnterpriseSession): string {
    if (session.status !== 'signed-in' || !session.user?.id || !session.user.weaveUserId || !session.organization?.id) throw new Error('请先登录')
    return createHash('sha256').update(JSON.stringify([this.forgeUrl.origin, this.weaveUrl.origin, session.organization.id, session.user.id, session.user.weaveUserId])).digest('hex')
  }

  connectionOrigins(): { forgeOrigin: string; weaveOrigin: string } {
    return { forgeOrigin: this.forgeUrl.origin, weaveOrigin: this.weaveUrl.origin }
  }

  private signedOut(message?: string): EnterpriseSession {
    return {
      version: '1', status: 'signed-out',
      environment: { origin: this.forgeUrl.origin, secure: this.forgeUrl.protocol === 'https:' },
      storage: 'session-only', ...(message ? { message } : {}),
      ...(this.pendingSignIn ? { signIn: structuredClone(this.pendingSignIn) } : {}),
    }
  }

  private clearSessionState(): void {
    this.workCanceller.clear()
    this.weaveToken = undefined
    this.forgeToken = undefined
    this.nativeForgeIdentity = undefined
    this.pendingSignIn = undefined
    this.session = undefined
    this.expiresAt = 0
  }

  private currentToken(provider: EnterpriseAuthProvider): string | undefined {
    return provider === 'weave' ? this.weaveToken : this.forgeToken
  }

  private assertCurrentAuth(snapshot: EnterpriseAuthSnapshot): void {
    if (snapshot.generation !== this.authGeneration || this.currentToken(snapshot.provider) !== snapshot.token) {
      throw new Error('账号已切换，旧请求结果已丢弃')
    }
  }

  private assertAuthGeneration(generation: number): void {
    if (generation !== this.authGeneration) throw new Error('账号已切换，旧请求结果已丢弃')
  }

  private async authenticatedFetch(input: URL | RequestInfo, provider: EnterpriseAuthProvider, init: RequestInit = {}, expectedGeneration = this.authGeneration): Promise<{ response: Response; snapshot: EnterpriseAuthSnapshot }> {
    this.assertAuthGeneration(expectedGeneration)
    if ((this.weaveToken || this.forgeToken) && this.expiresAt <= Date.now()) await this.clearLocalSession()
    const token = this.currentToken(provider)
    if (!token) throw new Error('请先登录')
    const snapshot = { generation: this.authGeneration, provider, token }
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${token}`)
    const response = await this.fetch(input, { ...init, headers })
    try { this.assertCurrentAuth(snapshot) }
    catch (error) { await response.body?.cancel(); throw error }
    return { response, snapshot }
  }

  private async signOutIfCurrent(snapshot: EnterpriseAuthSnapshot): Promise<void> {
    try { this.assertCurrentAuth(snapshot) } catch { return }
    await this.clearLocalSession()
  }

  private async assertResponseAuthorized(response: Response, snapshot: EnterpriseAuthSnapshot, forbiddenMessage: string): Promise<void> {
    if (response.status !== 401 && response.status !== 403) return
    if (!response.bodyUsed) await response.body?.cancel()
    this.assertCurrentAuth(snapshot)
    if (response.status === 401) {
      await this.signOutIfCurrent(snapshot)
      throw new Error('登录已失效，请重新登录')
    }
    throw new Error(forbiddenMessage)
  }

  private assertLoginCurrent(generation: number, attempt: number): void {
    if (generation !== this.authGeneration || attempt !== this.loginAttempt) throw new Error('账号已切换，旧登录请求已取消')
  }

  async getSession(): Promise<EnterpriseSession> {
    // A saved sign-in is being picked up; answer once it is known who is signed in.
    await this.restoring?.catch(() => undefined)
    if (this.session?.status === 'signed-in' && this.expiresAt <= Date.now()) await this.clearLocalSession()
    return structuredClone(this.session ?? this.signedOut())
  }

  private async sessionSnapshot(): Promise<{ session: EnterpriseSession; generation: number }> {
    const generation = this.authGeneration
    const session = await this.getSession()
    if (generation !== this.authGeneration && session.status === 'signed-out' && !this.weaveToken && !this.forgeToken) {
      return { session, generation: this.authGeneration }
    }
    this.assertAuthGeneration(generation)
    return { session, generation }
  }

  async authorizationHeaders(): Promise<Headers> {
    if ((this.weaveToken || this.forgeToken) && this.expiresAt <= Date.now()) await this.clearLocalSession()
    if (!this.weaveToken) throw new Error('请先登录')
    return new Headers({ Authorization: `Bearer ${this.weaveToken}` })
  }

  /** Signs in through the browser: Forge asks the employee to approve this desktop, no password passes through it. */
  async signIn(): Promise<EnterpriseSession> {
    await this.restoring?.catch(() => undefined)
    const attempt = ++this.loginAttempt
    const generation = ++this.authGeneration
    this.signInAbort?.abort()
    const abort = new AbortController()
    this.signInAbort = abort
    this.clearSessionState()
    await this.notifySessionScopeChanged(this.signedOut(), 'sign-in-start')
    try {
      // A new sign-in replaces whatever an earlier one saved.
      await this.tokenStore?.clear().catch(() => undefined)
      const forgeToken = await deviceSignIn({
        fetch: this.fetch, forgeUrl: this.forgeUrl, signal: abort.signal, openExternal: this.openExternal, delay: this.signInDelay,
        assertCurrent: () => this.assertLoginCurrent(generation, attempt),
        onPending: async (pending) => { this.pendingSignIn = pending; await this.notifySessionScopeChanged(this.signedOut(), 'signed-out') },
      })
      this.assertLoginCurrent(generation, attempt)
      this.pendingSignIn = undefined
      return await this.establish(forgeToken, generation, attempt, true)
    } catch (error) {
      if (generation !== this.authGeneration || attempt !== this.loginAttempt) throw new Error('账号已切换，旧登录请求已取消')
      this.clearSessionState()
      await this.notifySessionScopeChanged(this.signedOut(), 'signed-out').catch(() => undefined)
      if (error instanceof Error && !['fetch failed', 'The operation was aborted due to timeout'].includes(error.message)) throw error
      throw new Error('企业服务暂时无法连接')
    } finally {
      if (this.signInAbort === abort) this.signInAbort = undefined
    }
  }

  /** Stops waiting for the browser. A code approved afterwards signs nobody in here. */
  async cancelSignIn(): Promise<EnterpriseSession> {
    this.signInAbort?.abort()
    return structuredClone(this.session ?? { ...this.signedOut(), signIn: undefined })
  }

  /** Opens the confirmation page again while a sign-in is waiting for it. */
  async reopenSignIn(): Promise<void> {
    if (!this.pendingSignIn || !this.openExternal) throw new Error('当前没有等待确认的登录')
    await this.openExternal(this.pendingSignIn.verificationUri)
  }

  /** Picks up the sign-in saved by an earlier run, so a restart needs no approval in the browser. */
  restoreSession(): Promise<EnterpriseSession> {
    const restore = async (): Promise<EnterpriseSession> => {
      if (this.session?.status === 'signed-in' || this.signInAbort || !this.tokenStore) return structuredClone(this.session ?? this.signedOut())
      const token = await this.tokenStore.read().catch(() => undefined)
      if (!token) return this.signedOut()
      const attempt = ++this.loginAttempt
      const generation = ++this.authGeneration
      try {
        return await this.establish(token, generation, attempt, false)
      } catch (error) {
        if (generation !== this.authGeneration || attempt !== this.loginAttempt) return structuredClone(this.session ?? this.signedOut())
        this.clearSessionState()
        // Only a session Forge no longer honours is forgotten; trouble reaching it keeps the saved one for the next start.
        const ended = error instanceof NativeSessionEnded
        if (ended) await this.tokenStore.clear().catch(() => undefined)
        const unreachable = error instanceof Error && ['fetch failed', 'The operation was aborted due to timeout', 'Forge 登录服务暂时不可用', 'Weave 账号绑定服务暂时不可用'].includes(error.message)
        const signedOut = this.signedOut(ended ? undefined : unreachable || !(error instanceof Error) ? '暂时连不上企业服务；恢复后重新打开，或重新登录' : error.message)
        await this.notifySessionScopeChanged(signedOut, 'signed-out').catch(() => undefined)
        return signedOut
      }
    }
    const running = restore().finally(() => { if (this.restoring === running) this.restoring = undefined })
    this.restoring = running
    return running
  }

  // Turns a native Forge session into the desktop's signed-in state: who it
  // belongs to is read from Forge, and what they may do from Weave's exchange.
  private async establish(forgeToken: string, generation: number, attempt: number, justApproved: boolean): Promise<EnterpriseSession> {
    const current = await this.fetch(new URL('/api/v1/auth/get-session', this.forgeUrl), {
      headers: { Accept: 'application/json', Authorization: `Bearer ${forgeToken}` }, redirect: 'error', signal: AbortSignal.timeout(15_000),
    })
    this.assertLoginCurrent(generation, attempt)
    if (!current.ok) {
      await current.body?.cancel()
      if (current.status === 401 || current.status === 403) throw new NativeSessionEnded('登录已失效，请重新登录')
      throw new Error('Forge 登录服务暂时不可用')
    }
    const native = record(await current.json().catch(() => undefined))
    this.assertLoginCurrent(generation, attempt)
    const forgeUser = record(native?.user)
    const nativeSession = record(native?.session)
    if (typeof forgeUser?.id !== 'string' || !forgeUser.id) throw new NativeSessionEnded('登录已失效，请重新登录')
    const organizationID = textValue(nativeSession?.activeOrganizationId)
    // The desktop does not pick an organization on the employee's behalf.
    if (!organizationID) throw new Error('这个账号还没有可用的组织，无法登录；请联系管理员')
    const exchanged = await this.fetch(new URL('/v1/auth/external/exchange', this.weaveUrl), {
      method: 'POST', headers: { Accept: 'application/json', Authorization: `Bearer ${forgeToken}` },
      redirect: 'error', signal: AbortSignal.timeout(15_000),
    })
    this.assertLoginCurrent(generation, attempt)
    if (!exchanged.ok) {
      await exchanged.body?.cancel()
      if (exchanged.status === 401 || exchanged.status === 403) throw new Error('当前账号无法进入 Weave')
      throw new Error('Weave 账号绑定服务暂时不可用')
    }
    const weave = record(await exchanged.json())
    this.assertLoginCurrent(generation, attempt)
    const subject = record(weave?.subject)
    const organization = record(weave?.organization)
    const permissions = enterprisePermissions(weave?.permissions)
    const identityIssuer = textValue(weave?.issuer)
    if (typeof weave?.token !== 'string' || typeof subject?.id !== 'string' || typeof organization?.id !== 'string' || !permissions
      || !identityIssuer || !/^[A-Za-z][A-Za-z0-9+.-]*:\S{1,240}$/.test(identityIssuer)) {
      throw new Error('Weave 返回了无法识别的账号绑定结果')
    }
    // A sign-in that could not be saved still works until the app quits.
    const saved = justApproved ? await this.tokenStore?.write(forgeToken).then(() => true, () => false) ?? false : true
    this.assertLoginCurrent(generation, attempt)
    this.weaveToken = weave.token
    this.forgeToken = forgeToken
    this.nativeForgeIdentity = { id: forgeUser.id, organizationID }
    const fortnight = 14 * 24 * 60 * 60
    const nativeExpiry = Date.parse(textValue(nativeSession?.expiresAt) ?? '')
    const weaveExpiry = Date.now() + (typeof weave.expiresIn === 'number' && weave.expiresIn > 0 ? Math.min(weave.expiresIn, fortnight) : fortnight) * 1000
    this.expiresAt = Number.isFinite(nativeExpiry) ? Math.min(nativeExpiry, weaveExpiry) : weaveExpiry
    const email = textValue(subject.email) ?? textValue(forgeUser.email) ?? ''
    this.session = {
      version: '1', status: 'signed-in',
      environment: { origin: this.forgeUrl.origin, secure: this.forgeUrl.protocol === 'https:' }, storage: saved ? 'private-file' : 'session-only',
      identitySource: { kind: 'forge-account', issuer: identityIssuer },
      user: {
        id: typeof subject.externalId === 'string' ? subject.externalId : forgeUser.id,
        weaveUserId: subject.id,
        name: textValue(subject.name) ?? textValue(forgeUser.name) ?? email,
        email,
      },
      organization: { id: organization.id, name: typeof organization.name === 'string' && organization.name.trim() ? organization.name : organization.id },
      permissions,
    }
    await this.notifySessionScopeChanged(this.session, 'signed-in')
    this.assertLoginCurrent(generation, attempt)
    return structuredClone(this.session)
  }

  private async clearLocalSession(): Promise<EnterpriseSession> {
    this.loginAttempt++
    this.authGeneration++
    this.signInAbort?.abort()
    this.clearSessionState()
    // Whatever ended this session, a restart must not bring it back.
    await this.tokenStore?.clear().catch(() => undefined)
    await this.notifySessionScopeChanged(this.signedOut(), 'signed-out')
    return this.signedOut()
  }

  async signOut(): Promise<EnterpriseSession> {
    const token = this.forgeToken
    const generation = this.authGeneration + 1
    await this.clearLocalSession()
    if (!token) return this.signedOut()
    let confirmed = false
    try {
      const response = await this.fetch(new URL('/api/v1/auth/sign-out', this.forgeUrl), {
        method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: '{}', redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      confirmed = response.status === 200 || response.status === 401
      await response.body?.cancel()
    } catch { /* Local sign-out is complete; a failed request cannot confirm remote revocation. */ }
    if (generation !== this.authGeneration) return this.getSession()
    this.session = this.signedOut(confirmed ? undefined : '已退出此设备，但远端会话吊销尚未确认；请在 Forge 核对账号会话。')
    return structuredClone(this.session)
  }

  private async weaveJSON(path: string, expectedGeneration = this.authGeneration): Promise<unknown> {
    const { response, snapshot } = await this.authenticatedFetch(new URL(path, this.weaveUrl), 'weave', { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }, expectedGeneration)
    await this.assertResponseAuthorized(response, snapshot, '当前账号没有读取该团队信息的权限')
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`团队信息读取失败（${response.status}）`)
    }
    const result = await response.json()
    this.assertCurrentAuth(snapshot)
    return result
  }

  private async forgeJSON(path: string, expectedGeneration = this.authGeneration, resourceLabel = '工作事项'): Promise<unknown> {
    const { response, snapshot } = await this.authenticatedFetch(new URL(path, this.forgeUrl), 'forge', { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }, expectedGeneration)
    await this.assertResponseAuthorized(response, snapshot, `当前账号没有读取${resourceLabel}的权限`)
    if (!response.ok) {
      if (response.status === 409 && resourceLabel === '本人业务动作' && path.startsWith('/api/v1/workbench/business-actions/context?')
        && new URLSearchParams(path.split('?')[1]).get('sourceKind') === 'creation') {
        const body = await response.json().catch(() => undefined) as { error?: { code?: unknown } } | undefined
        this.assertCurrentAuth(snapshot)
        if (body?.error?.code === 'EMPLOYEE_ACTION_REFERENCE_SELECTION_REQUIRED') throw new Error('可选记录较多或名称不唯一，请先查找并读取准确的业务引用，再重新读取创建目录；不要猜测记录标识')
      }
      await response.body?.cancel()
      throw new Error(`${resourceLabel}读取失败（${response.status}）`)
    }
    const result = await response.json()
    this.assertCurrentAuth(snapshot)
    return result
  }

  private async employeeBusinessReadAPI() {
    const { EmployeeBusinessReadAPI } = await import('./enterprise/employee-business-read-api')
    const { session, generation } = await this.sessionSnapshot()
    if (session.status !== 'signed-in') throw new Error('请先登录')
    return new EmployeeBusinessReadAPI((path, label) => this.forgeJSON(path, generation, label))
  }

  async getEmployeeBusinessContext(selection: EmployeeBusinessTarget) {
    return (await this.employeeBusinessReadAPI()).context(selection)
  }

  async executeEmployeeBusinessAction(request: EmployeeBusinessRequest) {
    const { parseEmployeeBusinessOperation } = await import('./enterprise/employee-business-contract')
    const { session, generation } = await this.sessionSnapshot()
    if (session.status !== 'signed-in') throw new Error('请先登录')
    const { response, snapshot } = await this.authenticatedFetch(new URL('/api/v1/workbench/business-actions/execute', this.forgeUrl), 'forge', {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(request),
      redirect: 'error', signal: AbortSignal.timeout(30_000),
    }, generation)
    await this.assertResponseAuthorized(response, snapshot, '当前账号不能办理该业务动作')
    const body = await response.json()
    this.assertCurrentAuth(snapshot)
    return parseEmployeeBusinessOperation(body)
  }

  async getEmployeeBusinessOperation(opKey: string) {
    return (await this.employeeBusinessReadAPI()).operation(opKey)
  }

  async listInitializationActions(): Promise<InitializationAction[]> {
    const { session, generation } = await this.sessionSnapshot()
    if (session.status !== 'signed-in') throw new Error('请先登录')
    const { parseInitializationCatalog } = await import('./enterprise/initialization-catalog')
    const actions = parseInitializationCatalog(await this.forgeMcpTool('list_actions', {}, generation))
    this.assertAuthGeneration(generation)
    return actions
  }

  async runNativeInitializationAction(
    args: NativeInitializationActionArguments, assertCurrent: () => Promise<void>, requiresConfirmation: boolean,
    assertBeforeDispatch: () => Promise<void>,
  ): Promise<NativeMcpActionAttempt> {
    const { session, generation } = await this.sessionSnapshot()
    if (session.status !== 'signed-in' || !this.forgeToken) throw new Error('请先登录以办理企业初始化')
    const { callNativeMcpInitializationAction } = await import('./enterprise/approval-actions')
    return callNativeMcpInitializationAction(args, assertCurrent, {
      fetch: (init) => this.authenticatedFetch(new URL('/api/v1/mcp', this.forgeUrl), 'forge', init, generation),
      assertCurrentAuth: (snapshot) => this.assertCurrentAuth(snapshot as EnterpriseAuthSnapshot),
      signOutIfCurrent: (snapshot) => this.signOutIfCurrent(snapshot as EnterpriseAuthSnapshot),
      assertAuthGeneration: () => this.assertAuthGeneration(generation),
    }, requiresConfirmation, assertBeforeDispatch)
  }

  async getEmployeeBusinessMaterial(selection: EmployeeBusinessSelection, assertCurrent: () => Promise<void>) {
    const { readEmployeeBusinessMaterial } = await import('./enterprise/employee-business-materials')
    const { session, generation } = await this.sessionSnapshot()
    if (session.status !== 'signed-in') throw new Error('请先登录')
    return readEmployeeBusinessMaterial(selection, {
      origin: this.forgeUrl.origin, assertCurrent,
      context: async () => { const context = await this.getEmployeeBusinessContext(selection); if (!('record' in context)) throw new Error('原件读取须绑定真实业务记录'); return context },
      record: () => this.forgeMcpTool('get_record', { objectName: selection.record.objectName, recordId: selection.record.recordId }, generation),
      url: (id) => this.forgeJSON(`/api/v1/storage/files/${encodeURIComponent(id)}/url`, generation, '业务原件'),
      fetch: async (url) => {
        const { response, snapshot } = await this.authenticatedFetch(url, 'forge', { redirect: 'error', headers: { 'Accept-Encoding': 'identity' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }, generation)
        this.assertCurrentAuth(snapshot); return response
      },
    })
  }

  private async forgeMcpTool(
    name: 'list_objects' | 'describe_object' | 'query_records' | 'get_record' | 'list_actions',
    args: Record<string, unknown>,
    expectedGeneration: number,
  ): Promise<unknown> {
    if (!this.forgeToken) throw new Error('请重新登录以读取 Forge 业务记录')
    const id = `business-read-${randomUUID()}`
    const { response, snapshot } = await this.authenticatedFetch(new URL('/api/v1/mcp', this.forgeUrl), 'forge', {
      method: 'POST', headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
      redirect: 'error', signal: AbortSignal.timeout(15_000),
    }, expectedGeneration)
    const raw = await response.text()
    this.assertCurrentAuth(snapshot)
    if (response.status === 401) {
      await this.signOutIfCurrent(snapshot)
      throw new Error('登录已失效，请重新登录')
    }
    if (response.status === 403) throw new ForgeBusinessReadError('forbidden', '当前账号没有读取该业务数据的权限')
    if (!response.ok) throw new ForgeBusinessReadError('failed', `Forge 业务读取失败（${response.status}）`)
    if (name === 'list_actions' && raw.length > 2_000_000) throw new Error('Forge 初始化动作目录超出读取范围')
    const envelope = record(parseMcpResponse(raw))
    if (!envelope) throw new ForgeBusinessReadError('failed', 'Forge 原生读取工具返回格式无法识别')
    if (name === 'list_actions' && (envelope.jsonrpc !== '2.0' || envelope.id !== id)) throw new Error('Forge 初始化动作目录响应不匹配')
    const rpcError = record(envelope.error)
    if (rpcError) throw forgeMcpReadError(textValue(rpcError.message) ?? '')
    const result = record(envelope.result)
    if (!result) throw new ForgeBusinessReadError('failed', 'Forge 原生读取工具没有返回结果')
    const content = Array.isArray(result.content) ? result.content : []
    const text = content.map((item) => textValue(record(item)?.text)).find(Boolean)
    if (result.isError === true) throw forgeMcpReadError(text ?? '')
    if (result.structuredContent !== undefined) return result.structuredContent
    if (!text) throw new ForgeBusinessReadError('failed', 'Forge 原生读取工具没有返回数据')
    try { return JSON.parse(text) as unknown }
    catch { return text }
  }

  async runNativeMcpAction(
    args: NativeMcpActionArguments, assertCurrent: () => Promise<void>,
    requiresConfirmation?: boolean, assertBeforeDispatch?: () => Promise<void>,
  ): Promise<NativeMcpActionAttempt> {
    const { session, generation } = await this.sessionSnapshot()
    if (session.status !== 'signed-in' || !this.forgeToken) throw new Error('请先登录以办理当前 Forge 事项')
    const { callNativeMcpRunAction } = await import('./enterprise/approval-actions')
    const endpoint = new URL('/api/v1/mcp', this.forgeUrl)
    return callNativeMcpRunAction(args, assertCurrent, {
      fetch: (init) => this.authenticatedFetch(endpoint, 'forge', init, generation),
      assertCurrentAuth: (snapshot) => this.assertCurrentAuth(snapshot as EnterpriseAuthSnapshot),
      signOutIfCurrent: (snapshot) => this.signOutIfCurrent(snapshot as EnterpriseAuthSnapshot),
      assertAuthGeneration: () => this.assertAuthGeneration(generation),
    }, requiresConfirmation, assertBeforeDispatch)
  }

  async getApprovalActionHistory(requestIdValue: string): Promise<unknown[]> {
    const { session, generation } = await this.sessionSnapshot()
    if (session.status !== 'signed-in') throw new Error('请先登录以核对 Forge 审批动作历史')
    const requestId = boundedIdentity(requestIdValue, 128)
    if (!requestId) throw new Error('Forge 审批事项引用无效')
    const raw = await this.forgeJSON(`/api/v1/approvals/requests/${encodeURIComponent(requestId)}/actions`, generation, '审批动作历史')
    const envelope = record(raw), actions = Array.isArray(raw) ? raw : Array.isArray(envelope?.data) ? envelope.data : undefined
    if (!actions) throw new Error('Forge 审批动作历史格式无效')
    this.assertAuthGeneration(generation)
    return actions
  }

  private async forgeObjectMetadata(objectName: string, expectedGeneration: number): Promise<unknown> {
    if (!this.forgeToken) throw new Error('请重新登录以读取 Forge 业务元数据')
    const { response, snapshot } = await this.authenticatedFetch(
      new URL(`/api/v1/meta/object/${encodeURIComponent(objectName)}`, this.forgeUrl), 'forge',
      { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15_000) }, expectedGeneration,
    )
    if (response.status === 401) {
      await response.body?.cancel()
      await this.signOutIfCurrent(snapshot)
      throw new Error('登录已失效，请重新登录')
    }
    if (response.status === 403) { await response.body?.cancel(); throw new ForgeBusinessReadError('forbidden', '当前账号没有读取该对象元数据的权限') }
    if (response.status === 404) { await response.body?.cancel(); throw new ForgeBusinessReadError('not_found', '所选业务对象当前不可见') }
    if (!response.ok) { await response.body?.cancel(); throw new ForgeBusinessReadError('failed', `Forge 对象元数据读取失败（${response.status}）`) }
    const result = await response.json()
    this.assertCurrentAuth(snapshot)
    return result
  }

  private async forgeRequest(path: string, body: unknown, expectedGeneration = this.authGeneration): Promise<{ status: number; body: unknown }> {
    const { response, snapshot } = await this.authenticatedFetch(new URL(path, this.forgeUrl), 'forge', {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15_000),
    }, expectedGeneration)
    const result = await response.json().catch(() => undefined)
    this.assertCurrentAuth(snapshot)
    await this.assertResponseAuthorized(response, snapshot, '当前账号没有办理该工作事项的权限')
    if (!response.ok) throw new Error(textValue(record(result)?.message) ?? textValue(record(result)?.error) ?? `Forge 工作事项处理失败（${response.status}）`)
    return { status: response.status, body: result }
  }

  private async readOriginalMaterialBytes(
    path: string,
    mediaType: 'application/pdf' | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    bytes: number,
    sha256: string,
    generation: number,
    sourceLabel: '审批' | '原工作' | '业务结果',
  ): Promise<Buffer> {
    const { response, snapshot } = await this.authenticatedFetch(new URL(path, this.forgeUrl), 'forge', {
      headers: { Accept: mediaType, 'Accept-Encoding': 'identity', 'If-Match': `"${sha256}"` },
      redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, generation)
    if (response.status === 401) {
      await response.body?.cancel()
      await this.signOutIfCurrent(snapshot)
      throw new Error('登录已失效，请重新登录')
    }
    if (response.status === 403) {
      await response.body?.cancel()
      this.assertCurrentAuth(snapshot)
      throw new Error(`当前账号没有读取该${sourceLabel}原件的权限`)
    }
    if (response.status === 404) {
      await response.body?.cancel()
      throw new Error(`${sourceLabel}原件不属于当前员工或冻结材料，已停止读取`)
    }
    if (response.status === 409) {
      await response.body?.cancel()
      throw new Error(`${sourceLabel}原件版本已变化，请刷新后再处理`)
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`${sourceLabel}原件暂时无法安全读取，请刷新后再处理`)
    }
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    const contentLength = response.headers.get('content-length')
    const responseDigest = response.headers.get('x-content-sha256')
    const responseEtag = response.headers.get('etag')?.replace(/^"|"$/g, '')
    const hasResponseDigest = responseDigest !== null || responseEtag !== undefined
    if (contentType !== mediaType || contentLength !== String(bytes) || !hasResponseDigest
      || responseDigest !== null && responseDigest !== sha256
      || responseEtag !== undefined && responseEtag !== sha256) {
      await response.body?.cancel()
      this.assertCurrentAuth(snapshot)
      throw new Error(`${sourceLabel}原件响应与冻结材料元数据不一致`)
    }
    const sourceBytes = await readExactResponseBytes(response, bytes)
    this.assertCurrentAuth(snapshot)
    if (createHash('sha256').update(sourceBytes).digest('hex') !== sha256) {
      throw new Error(`${sourceLabel}原件字节摘要与冻结版本不一致`)
    }
    return sourceBytes
  }

  async submitApprovalRevision(requestId: string, body: ApprovalRevisionSubmission, assertCurrent: () => Promise<void>): Promise<ForgeHttpResult> {
    const { session, generation } = await this.sessionSnapshot()
    if (session.status !== 'signed-in') throw new Error('请先登录')
    await assertCurrent()
    const { response, snapshot } = await this.authenticatedFetch(
      new URL(`/api/v1/approvals/requests/${encodeURIComponent(requestId)}/workbench-revision`, this.forgeUrl), 'forge', {
        method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15_000),
      }, generation,
    )
    const result = await response.json().catch(() => undefined)
    this.assertCurrentAuth(snapshot)
    await this.assertResponseAuthorized(response, snapshot, '当前账号没有递交该审批修订的权限')
    return { status: response.status, body: result }
  }

  async getApprovalRevisionReceipt(requestId: string, idempotencyKey: string, assertCurrent: () => Promise<void>): Promise<ForgeHttpResult> {
    const { session, generation } = await this.sessionSnapshot()
    if (session.status !== 'signed-in') throw new Error('请先登录')
    await assertCurrent()
    const { response, snapshot } = await this.authenticatedFetch(
      new URL(`/api/v1/approvals/requests/${encodeURIComponent(requestId)}/workbench-revision/${encodeURIComponent(idempotencyKey)}`, this.forgeUrl), 'forge', {
        headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }, generation,
    )
    const result = await response.json().catch(() => undefined)
    this.assertCurrentAuth(snapshot)
    await this.assertResponseAuthorized(response, snapshot, '当前账号没有读取该审批修订回执的权限')
    return { status: response.status, body: result }
  }

  /**
   * Uploads frozen materials to Forge one by one. With progress, each file's
   * receipt is kept as it moves on, so a repeat after an interruption reuses a
   * committed file, commits one whose bytes were sent, and uploads again only a
   * file whose bytes may not have arrived. Forge drops a file left uncommitted.
   */
  async stageWorkMaterials(materials: FrozenMaterial[], assertCurrent: () => Promise<void>, progress?: MaterialUploadProgress): Promise<EnterpriseWorkResource[]> {
    if (!materials.length) return []
    const generation = this.authGeneration
    this.assertAuthGeneration(generation)
    if ((this.weaveToken || this.forgeToken) && this.expiresAt <= Date.now()) await this.clearLocalSession()
    if (!this.forgeToken) throw new Error('请重新登录以上传工作材料')
    const resources: EnterpriseWorkResource[] = []
    const complete = async (fileId: string) => {
      await assertCurrent()
      this.assertAuthGeneration(generation)
      const completed = await this.forgeRequest('/api/v1/storage/upload/complete', { fileId }, generation)
      const completedEnvelope = record(completed.body), completedData = record(completedEnvelope?.data) ?? completedEnvelope
      if ((textValue(completedData?.fileId) ?? fileId) !== fileId) throw new Error('Forge 返回的材料版本与本次上传不一致')
    }
    for (const rawMaterial of materials) {
      const material = normalizeFrozenMaterial(rawMaterial)
      const sourceBytes = validateFrozenMaterial(material)
      const key = materialUploadKey(material)
      let receipt = await progress?.read(key)
      if (receipt?.phase === 'uploaded') {
        // The bytes arrived but the commit's answer was lost; committing again is safe.
        await complete(receipt.fileId)
        receipt = { fileId: receipt.fileId, phase: 'completed' }
        await progress?.write(key, receipt)
      }
      if (receipt?.phase !== 'completed') {
        await assertCurrent()
        this.assertAuthGeneration(generation)
        const prepared = await this.forgeRequest('/api/v1/storage/upload/presigned', {
          filename: material.name, mimeType: material.mediaType, size: material.bytes, scope: 'attachments',
        }, generation)
        const envelope = record(prepared.body), descriptor = record(envelope?.data) ?? envelope
        const fileId = textValue(descriptor?.fileId), uploadUrl = textValue(descriptor?.uploadUrl), method = textValue(descriptor?.method) ?? 'PUT'
        if (!fileId || !uploadUrl) throw new Error('Forge 没有返回材料上传地址')
        await progress?.write(key, { fileId, phase: 'presigned' })
        const uploaded = await this.fetch(new URL(uploadUrl, this.forgeUrl), {
          method, headers: record(descriptor?.headers) as Record<string, string> | undefined,
          body: Uint8Array.from(sourceBytes), redirect: 'error', signal: AbortSignal.timeout(30_000),
        })
        if (!uploaded.ok) { await uploaded.body?.cancel(); throw new Error(`材料“${material.name}”上传失败（${uploaded.status}）`) }
        await uploaded.body?.cancel()
        await progress?.write(key, { fileId, phase: 'uploaded' })
        await complete(fileId)
        receipt = { fileId, phase: 'completed' }
        await progress?.write(key, receipt)
      }
      resources.push({
        type: 'forge-file', ...(material.sourceKind ? { sourceKind: material.sourceKind } : {}),
        materialId: material.materialId, id: receipt.fileId, name: material.name,
        mediaType: material.mediaType, bytes: material.bytes, sha256: material.sha256,
      })
    }
    await assertCurrent()
    this.assertAuthGeneration(generation)
    return resources
  }

  async teamWorkspace(command: TeamWorkspaceCommand): Promise<unknown> {
    const { session, generation } = await this.sessionSnapshot()
    if (session.status !== 'signed-in' || !session.permissions?.includes('teams:develop')) throw new Error('当前账号没有团队开发权限')
    if (!command.accountId || command.accountId !== session.user?.id) throw new Error('编辑账号已变化，请重新打开团队')
    const account = await this.accountKey()
    const assertCurrent = async () => { this.assertAuthGeneration(generation); if (await this.accountKey() !== account) throw new Error('账号已切换，请重新打开团队') }
    const result = await teamWorkspaceRequest(command, (path) => this.weaveJSON(path, generation), (path, method, body) => this.weaveRequest(path, method, body, assertCurrent, undefined, generation), () => this.forgeToken)
    await assertCurrent()
    return result
  }

  /** The signed-in person's own external client sign-ins to Weave (MCP clients), newest first. */
  async listOwnClientSessions(): Promise<EnterpriseClientSession[]> {
    const { session, generation } = await this.sessionSnapshot()
    if (session.status !== 'signed-in') throw new Error('请先登录')
    const listed = record(await this.weaveJSON('/v1/mcp/sessions', generation))
    if (!Array.isArray(listed?.sessions)) throw new Error('Weave 返回了无法识别的客户端会话')
    // Weave also lists the whole organization to an administrator; this is
    // the person's own list, so only their sessions are kept.
    return listed.sessions.flatMap((value) => {
      const item = record(value)
      const id = textValue(item?.id), client = textValue(item?.client_name), createdAt = textValue(item?.created_at), expiresAt = textValue(item?.expires_at)
      if (item?.own !== true || !id || !client || !createdAt || !expiresAt) return []
      return [{ id, client, createdAt, expiresAt, ...(textValue(item?.last_used_at) ? { lastUsedAt: textValue(item?.last_used_at) } : {}) }]
    })
  }

  async revokeOwnClientSession(id: string): Promise<void> {
    const { session, generation } = await this.sessionSnapshot()
    if (session.status !== 'signed-in') throw new Error('请先登录')
    if (!(await this.listOwnClientSessions()).some((item) => item.id === id)) throw new Error('这个客户端会话已不存在或不是本人的')
    const account = await this.accountKey()
    await this.weaveRequest(`/v1/mcp/sessions/${encodeURIComponent(id)}`, 'DELETE', undefined, async () => {
      if (await this.accountKey() !== account) throw new Error('账号已切换，未收回会话')
    }, undefined, generation)
  }

  async getDevelopmentOverview(): Promise<EnterpriseDevelopmentOverview> {
    const { session, generation } = await this.sessionSnapshot()
    if (session.status !== 'signed-in') throw new Error('请先登录')
    if (!session.permissions?.includes('teams:develop')) throw new Error('当前账号没有开发中心权限')
    const [rawTeams, rawRuntimes, rawModels] = await Promise.all([
      this.weaveJSON('/v1/teams?include=roster,summary&status=all&purpose=development', generation),
      this.weaveJSON('/v1/runtimes', generation),
      this.weaveJSON('/v1/development/model-catalog', generation),
    ])
    if (!Array.isArray(rawTeams)) throw new Error('Weave 返回了无法识别的团队列表')
    const teams = await Promise.all(rawTeams.map(async (item): Promise<EnterpriseTeamObservation> => {
      const source = record(item)
      const team = record(source?.team)
      const id = textValue(team?.id)
      const name = textValue(team?.display_name) ?? textValue(team?.name)
      const status = textValue(team?.status)
      const updatedAt = textValue(team?.updated_at)
      if (!id || !name || !status || !updatedAt) throw new Error('Weave 返回了无法识别的团队')
      const summary = record(source?.summary)
      const health = record(summary?.health)
      return {
        id, name, status, updatedAt, workflows: [],
        workers: (Array.isArray(source?.workers) ? source.workers : []).flatMap((value) => member(value) ?? []),
        runs: [],
        ...(textValue(team?.objective) ? { objective: textValue(team?.objective) } : {}), ...(textValue(team?.evaluation) ? { evaluation: textValue(team?.evaluation) } : {}),
        ...(member(source?.lead) ? { lead: member(source?.lead) } : {}),
        ...(summary ? { summary: {
          workerCount: numberValue(summary.worker_count) ?? 0, activeWorkflowCount: numberValue(summary.active_workflow_count) ?? 0,
          publishedWorkflowCount: numberValue(summary.published_workflow_count) ?? 0, ...(textValue(health?.conclusion) ? { health: textValue(health?.conclusion) } : {}),
          reasons: Array.isArray(health?.reason_codes) ? health.reason_codes.filter((value): value is string => typeof value === 'string') : [],
        } } : {}),
      }
    }))
    const runtimeSource = record(rawRuntimes)
    const runtimes = (Array.isArray(runtimeSource?.runtimes) ? runtimeSource.runtimes : []).flatMap((value) => {
      const item = record(value), id = textValue(item?.id), name = textValue(item?.name)
      if (!id || !name) return []
      return [{ id, name, engines: stringList(item?.engines), status: textValue(item?.health_status) ?? 'unknown', online: item?.online === true }]
    })
    const modelSource = record(rawModels)
    const models = stringList(modelSource?.models)
    this.assertAuthGeneration(generation)
    return { version: '1', loadedAt: new Date().toISOString(), teams, runtimes, models }
  }

  private async readBusinessCapabilityPolicy(generation = this.authGeneration): Promise<EnterpriseBusinessCapabilityCatalog> {
    const { parseCapabilityPolicy } = await import('./enterprise/capability-policy')
    const { response, snapshot } = await this.authenticatedFetch(new URL('/api/v1/workbench/business-actions/catalog', this.forgeUrl), 'forge', {
      headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, generation)
    if (response.status === 403) {
      const denied = record(await response.json().catch(() => undefined))
      this.assertCurrentAuth(snapshot)
      if (record(denied?.error)?.code === 'PASSWORD_EXPIRED') throw new Error('Forge 账号密码已过期，请更新密码后重新登录')
      throw new Error('当前账号没有读取 Forge 业务能力的权限')
    }
    await this.assertResponseAuthorized(response, snapshot, '当前账号没有读取 Forge 业务能力的权限')
    if (!response.ok) { await response.body?.cancel(); throw new Error('业务能力目录暂时无法读取') }
    const raw = await response.json(); this.assertCurrentAuth(snapshot)
    return parseCapabilityPolicy(raw)
  }

  async getBusinessCapabilityCatalog(): Promise<EnterpriseBusinessCapabilityCatalog> {
    const { session, generation } = await this.sessionSnapshot()
    if (session.status !== 'signed-in') throw new Error('请先登录')
    if (!session.permissions?.includes('teams:develop')) throw new Error('当前账号没有开发中心权限')
    const catalog = await this.readBusinessCapabilityPolicy(generation)
    return { ...catalog, capabilities: catalog.capabilities.filter((item) => item.executionMode !== 'employee_only').map((item) => {
      const reason = businessCapabilityUnavailableReason(item.params)
      return reason ? { ...item, status: 'unavailable' as const, unavailableReason: reason } : item
    }) }
  }

  private async readBusinessActionObjectMetadata(objectName: string, generation: number): Promise<BusinessActionObjectMetadata> {
    if (!objectName || objectName !== objectName.trim()) throw new Error('Forge 对象名无效，无法读取原生动作声明')
    const { response, snapshot } = await this.authenticatedFetch(
      new URL(`/api/v1/meta/objects/${encodeURIComponent(objectName)}`, this.forgeUrl), 'forge',
      { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }, generation,
    )
    if (response.status === 401) {
      await response.body?.cancel()
      await this.signOutIfCurrent(snapshot)
      throw new Error('登录已失效，请重新登录')
    }
    if (response.status === 403) {
      await response.body?.cancel()
      throw new Error(`当前账号没有读取 Forge 对象 ${objectName} 原生动作声明的权限`)
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Forge 对象 ${objectName} 原生动作声明读取失败（${response.status}）`)
    }
    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > BUSINESS_ACTION_METADATA_MAX_BYTES) {
      await response.body?.cancel()
      throw new Error(`Forge 对象 ${objectName} 原生动作声明超过读取限制`)
    }
    const body = await response.text()
    this.assertCurrentAuth(snapshot)
    if (Buffer.byteLength(body, 'utf8') > BUSINESS_ACTION_METADATA_MAX_BYTES) throw new Error(`Forge 对象 ${objectName} 原生动作声明超过读取限制`)
    let value: unknown
    try { value = JSON.parse(body) }
    catch { throw new Error(`Forge 对象 ${objectName} 原生动作声明格式无效`) }
    this.assertCurrentAuth(snapshot)
    return businessActionObjectMetadata(value, objectName)
  }


  async getBusinessCapabilities(allowedIds?: string[]): Promise<EnterpriseBusinessCapability[]> {
    const { session, generation } = await this.sessionSnapshot()
    if (session.status !== 'signed-in') throw new Error('请先登录')
    if (!this.forgeToken) throw new Error('请重新登录以读取 Forge 业务能力')
    const { response, snapshot } = await this.authenticatedFetch(new URL('/api/v1/mcp', this.forgeUrl), 'forge', {
      method: 'POST',
      headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'business-capability-catalog', method: 'tools/call', params: { name: 'list_actions', arguments: {} } }),
      redirect: 'error', signal: AbortSignal.timeout(15_000),
    }, generation)
    const policy = await this.readBusinessCapabilityPolicy(generation)
    const raw = await response.text()
    this.assertCurrentAuth(snapshot)
    if (response.status === 401) {
      await this.signOutIfCurrent(snapshot)
      throw new Error('登录已失效，请重新登录')
    }
    if (response.status === 403) throw new Error('当前账号没有读取 Forge 业务能力的权限')
    if (!response.ok) throw new Error(`Forge 业务能力读取失败（${response.status}）`)
    const envelope = record(parseMcpResponse(raw))
    const result = record(envelope?.result)
    const content = Array.isArray(result?.content) ? result.content : []
    const text = content.map((item) => textValue(record(item)?.text)).find(Boolean)
    const payload = text ? record(JSON.parse(text)) : undefined
    const actions = Array.isArray(payload?.actions) ? payload.actions : []
    if (!Array.isArray(payload?.actions)) throw new Error('Forge 员工业务动作目录格式无效')
    const visible = new Map<string, { id: string; key: string; objectName: string; actionName: string; action: Record<string, unknown> }>()
    for (const value of actions) {
      const action = record(value), actionName = textValue(action?.name), objectName = textValue(action?.objectName)
      if (!action || !actionName || actionName !== actionName.trim() || !objectName || objectName !== objectName.trim()) {
        throw new Error('Forge 员工业务动作目录包含无效对象或动作')
      }
      const key = `${objectName}.${actionName}`
      if (visible.has(key)) throw new Error(`Forge 员工业务动作目录重复包含 ${key}`)
      visible.set(key, { id: `forge:action:${key}`, key, objectName, actionName, action })
    }
    const visibleById = new Map([...visible.values()].map((action) => [action.id, action]))
    const requestedIds = allowedIds ?? [...visibleById.keys()]
    if (new Set(requestedIds).size !== requestedIds.length) throw new Error('团队配置的 Forge 业务动作不能重复')
    const selected = requestedIds.map((id) => {
      const match = visibleById.get(id)
      const eligibility = policy.capabilities.find((item) => item.id === id)
      if (!eligibility || eligibility.executionMode === 'employee_only' || eligibility.status !== 'available') throw new Error('该业务动作仅限员工本人办理或当前不可委托团队')
      if (!match) throw new Error(`当前员工没有调用 Forge 业务动作 ${id} 的权限`)
      return { ...match }
    })
    const objectMetadataByName = new Map<string, BusinessActionObjectMetadata>()
    const objectNames = [...new Set(selected.map((item) => item.objectName))].sort()
    for (const objectName of objectNames) {
      objectMetadataByName.set(objectName, await this.readBusinessActionObjectMetadata(objectName, generation))
    }
    const selectedDeclarations = new Map<string, Record<string, unknown>>()
    const overrideNames = new Set<string>()
    for (const item of selected) {
      const object = objectMetadataByName.get(item.objectName)!
      let declaration: Record<string, unknown> | undefined
      for (const rawDeclaration of object.actions) {
        const candidate = record(rawDeclaration)
        if (candidate?.name !== item.actionName) continue
        if (declaration) throw new Error(`Forge 对象 ${item.objectName} 中动作 ${item.actionName} 的原生声明重复`)
        declaration = candidate
      }
      if (!declaration) throw new Error(`Forge 对象 ${item.objectName} 中缺少动作 ${item.actionName} 的原生声明`)
      const params = declaration.params === undefined || declaration.params === null ? [] : declaration.params
      if (!Array.isArray(params)) throw new Error(`Forge 动作 ${item.actionName} 的原生参数声明无效`)
      for (const rawParam of params) {
        const parameter = record(rawParam)
        const field = textValue(parameter?.field)
        const override = textValue(parameter?.objectOverride)
        if (parameter?.objectOverride !== undefined && parameter.objectOverride !== null && (!override || override !== override.trim())) {
          throw new Error(`Forge 动作 ${item.actionName} 的对象字段引用无效`)
        }
        if (field && override) overrideNames.add(override)
      }
      selectedDeclarations.set(item.key, declaration)
    }
    for (const objectName of [...overrideNames].filter((name) => !objectMetadataByName.has(name)).sort()) {
      objectMetadataByName.set(objectName, await this.readBusinessActionObjectMetadata(objectName, generation))
    }
    const capabilities = selected.map(({ id, key, objectName, actionName, action }) => {
      const eligibility = policy.capabilities.find((item) => item.id === id)!
      const params = resolveBusinessActionParameters(action, selectedDeclarations.get(key)!, objectName, objectMetadataByName)
      const unavailableReason = businessCapabilityUnavailableReason(params)
      if (unavailableReason) throw new Error(`Forge 业务动作 ${id} 的参数暂不可安全绑定：${unavailableReason}`)
      return {
        id,
        name: textValue(action.label) ?? textValue(action.description) ?? actionName,
        description: textValue(action.description) ?? textValue(action.label) ?? actionName,
        effect: eligibility.effect, executionMode: eligibility.executionMode ?? 'team_delegable', resourceType: objectName, requiresEmployeeIntent: eligibility.requiresEmployeeIntent ?? eligibility.effect === 'write', status: 'available' as const,
        requiresRecord: action.requiresRecord !== false,
        actionName, objectName, requiresConfirmation: action.requiresConfirmation === true, params,
      }
    })
    this.assertCurrentAuth(snapshot)
    return capabilities
  }

  async getBusinessObjectDirectory(): Promise<BusinessObjectDirectory> {
    const { session, generation } = await this.sessionSnapshot()
    if (session.status !== 'signed-in') throw new Error('请先登录')
    if (!this.forgeToken) throw new Error('请重新登录以读取 Forge 业务记录')
    const directory = await (await this.businessReader()).listObjects(generation)
    this.assertAuthGeneration(generation)
    return directory
  }

  async findBusinessRecords(objectName: string, workSummary: string, offset: number, limit: number): Promise<BusinessRecordSearchPage> {
    const { session, generation } = await this.sessionSnapshot()
    if (session.status !== 'signed-in') throw new Error('请先登录')
    if (!this.forgeToken) throw new Error('请重新登录以读取 Forge 业务记录')
    const result = await (await this.businessReader()).findRecords(objectName, workSummary, offset, limit, generation)
    this.assertAuthGeneration(generation)
    return result
  }

  async readBusinessRecord(objectName: string, recordId: string): Promise<BusinessRecordRead> {
    const { session, generation } = await this.sessionSnapshot()
    if (session.status !== 'signed-in') throw new Error('请先登录')
    if (!this.forgeToken) throw new Error('请重新登录以读取 Forge 业务记录')
    const result = await (await this.businessReader()).readRecord(objectName, recordId, generation)
    this.assertAuthGeneration(generation)
    return result
  }

  async createDevelopmentTeam(input: EnterpriseCreateTeamInput): Promise<EnterpriseCreateTeamResult> {
    const name = input?.name?.trim()
    const objective = input?.objective?.trim()
    if (input?.version !== '1' || !name || name.length > 80 || !objective || objective.length > 2_000) throw new Error('请填写团队名称和目标')
    const { session, generation } = await this.sessionSnapshot()
    if (session.status !== 'signed-in') throw new Error('请先登录')
    if (!session.permissions?.includes('teams:develop')) throw new Error('当前账号没有新建团队权限')

    const suffix = randomUUID()
    const leadName = `team-${suffix}-lead`
    const workerName = `team-${suffix}-worker`
    const createdAgents: string[] = []
    try {
      const lead = record((await this.weaveRequest('/v1/agents', 'POST', {
        name: leadName, display_name: '团队负责人', role: 'avatar', engine: 'loom', graph_type: 'standard',
        spec: { system_prompt: `负责理解“${name}”的目标，组织协作并汇总可核验结果。` },
      }, undefined, undefined, generation)).body)
      const leadID = textValue(lead?.id)
      if (!leadID) throw new Error('Weave 没有返回团队负责人')
      createdAgents.push(leadName)

      const worker = record((await this.weaveRequest('/v1/agents', 'POST', {
        name: workerName, display_name: '执行成员', role: 'worker', engine: 'loom', graph_type: 'standard',
        spec: { system_prompt: `围绕“${objective}”完成分配的工作，并返回可核验结果。` },
      }, undefined, undefined, generation)).body)
      const workerID = textValue(worker?.id)
      if (!workerID) throw new Error('Weave 没有返回执行成员')
      createdAgents.push(workerName)

      const result = record((await this.weaveRequest('/v1/teams', 'POST', {
        name: `team-${suffix}`, display_name: name, objective, primary_scenario: objective,
        success_criteria: '完成团队目标并提供可核验结果', lead_avatar_id: leadID,
        workers: [{
          worker_agent_id: workerID, duty: '完成负责人分配的工作', when_to_use: '负责人需要执行具体任务时',
          context_instruction: '保留任务上下文与来源，清楚说明完成内容和未完成项。',
          allowed_kinds: ['consult', 'dispatch', 'handoff'], default_kind: 'dispatch', result_requirement: '返回可核验结果',
        }],
      }, undefined, undefined, generation)).body)
      const id = textValue(result?.id)
      if (!id) throw new Error('Weave 没有返回新团队')
      return { id, name: textValue(result?.display_name) ?? name, objective: textValue(result?.objective) ?? objective }
    } catch (error) {
      await Promise.allSettled(createdAgents.map((agentName) => this.deleteWeaveResource(`/v1/agents/${encodeURIComponent(agentName)}`, generation)))
      throw error
    }
  }

  async updateDevelopmentTeam(input: EnterpriseUpdateTeamInput): Promise<void> {
    const name = input?.name?.trim(), objective = input?.objective?.trim()
    if (input?.version !== '1' || !input.teamId || !name || name.length > 80 || !objective || objective.length > 2_000 || !input.expectedUpdatedAt) throw new Error('团队资料不完整')
    const { session, generation } = await this.sessionSnapshot()
    if (session.status !== 'signed-in') throw new Error('请先登录')
    if (!session.permissions?.includes('teams:develop')) throw new Error('当前账号没有团队配置权限')
    await this.weaveRequest(`/v1/teams/${encodeURIComponent(input.teamId)}/profile`, 'PUT', { display_name: name, objective, expected_updated_at: input.expectedUpdatedAt }, undefined, undefined, generation)
  }

  async createDevelopmentTeamMember(input: EnterpriseCreateTeamMemberInput): Promise<EnterpriseTeamMemberMutationResult> {
    const name = input?.name?.trim(), duty = input?.duty?.trim()
    if (input?.version !== '1' || !input.teamId || !name || name.length > 80 || !duty || duty.length > 2_000) throw new Error('请填写成员名称和职责')
    const { session, generation } = await this.sessionSnapshot()
    if (session.status !== 'signed-in') throw new Error('请先登录')
    if (!session.permissions?.includes('teams:develop')) throw new Error('当前账号没有团队配置权限')
    const agentName = `team-member-${randomUUID()}`
    const created = record((await this.weaveRequest('/v1/agents', 'POST', {
      name: agentName, display_name: name, role: 'worker', engine: 'loom', graph_type: 'standard',
      spec: { system_prompt: duty },
    }, undefined, undefined, generation)).body)
    const agentID = textValue(created?.id)
    if (!agentID) throw new Error('Weave 没有返回新成员')
    try {
      await this.weaveRequest(`/v1/teams/${encodeURIComponent(input.teamId)}/workers`, 'POST', {
        worker_agent_id: agentID, duty, when_to_use: '负责人分配相关工作时', context_instruction: '保留任务上下文和材料来源。',
        allowed_kinds: ['consult', 'dispatch', 'handoff'], default_kind: 'dispatch', result_requirement: '返回可核验结果',
      }, undefined, undefined, generation)
    } catch (error) {
      await this.deleteWeaveResource(`/v1/agents/${encodeURIComponent(agentName)}`, generation)
      throw error
    }
    return { id: agentID, name }
  }

  async removeDevelopmentTeamMember(teamId: string, memberId: string): Promise<void> {
    if (!teamId || !memberId) throw new Error('请选择要移出的成员')
    const { session, generation } = await this.sessionSnapshot()
    if (session.status !== 'signed-in') throw new Error('请先登录')
    if (!session.permissions?.includes('teams:develop')) throw new Error('当前账号没有团队配置权限')
    await this.weaveRequest(`/v1/teams/${encodeURIComponent(teamId)}/workers/${encodeURIComponent(memberId)}`, 'DELETE', undefined, undefined, undefined, generation)
  }

  async createDevelopmentWorkflow(input: EnterpriseCreateWorkflowInput): Promise<EnterpriseCreateWorkflowResult> {
    const name = input?.name?.trim()
    const description = input?.description?.trim()
    if (input?.version !== '1' || !input.teamId || !input.leadId || !input.workerId || !name || name.length > 80 || !description || description.length > 2_000) throw new Error('请填写流程名称和用途')
    const { session, generation } = await this.sessionSnapshot()
    if (session.status !== 'signed-in') throw new Error('请先登录')
    if (!session.permissions?.includes('teams:develop')) throw new Error('当前账号没有流程配置权限')
    const [lead, worker] = await Promise.all([
      this.getTeamMemberConfigDraft(input.teamId, input.leadId, generation),
      this.getTeamMemberConfigDraft(input.teamId, input.workerId, generation),
    ])
    const result = record((await this.weaveRequest(`/v1/teams/${encodeURIComponent(input.teamId)}/workflows`, 'POST', {
      name,
      description,
      trigger_config: { schema_version: 1, type: 'conversation_explicit', config: {} },
      graph_definition: {
        schema_version: 1,
        entry_node_id: 'understand',
        input_contract: { type: 'text' },
        output_contract: { type: 'text' },
        nodes: [
          { id: 'understand', type: 'lead', label: '理解任务', config: { instruction: lead.configuration.systemPrompt || `理解任务目标并明确“${description}”的交付要求。` }, inputs: { task: { value: { source: 'run_input', path: '' }, expected_type: 'text' } }, output: { type: 'text' } },
          { id: 'execute', type: 'worker', label: worker.configuration.displayName, config: { kind: 'consult', agent_id: input.workerId, agent_version: worker.baseAgentVersion, result_requirement: worker.relationship.resultRequirement || '完成分配的工作并返回可核验结果' }, inputs: { task: { value: { source: 'node_output', node_id: 'understand', path: '' }, expected_type: 'text' } }, output: { type: 'text' } },
          { id: 'deliver', type: 'deliver', label: '交付结果', config: { result: { source: 'node_output', node_id: 'execute', path: '' } } },
        ],
        edges: [
          { id: 'understand-execute', from_node_id: 'understand', to_node_id: 'execute', route: 'success' },
          { id: 'execute-deliver', from_node_id: 'execute', to_node_id: 'deliver', route: 'success' },
        ],
      },
    }, undefined, undefined, generation)).body)
    const workflow = record(result?.workflow), draft = record(result?.draft)
    const id = textValue(workflow?.id), workflowName = textValue(workflow?.name), draftVersion = numberValue(draft?.version)
    if (!id || !workflowName || !draftVersion) throw new Error('Weave 没有返回新流程')
    return { id, name: workflowName, draftVersion }
  }

  async updateDevelopmentWorkflowDraft(input: EnterpriseUpdateWorkflowDraftInput): Promise<EnterpriseUpdateWorkflowDraftResult> {
    if (input?.version !== '1' || !input.workflowId || !Number.isInteger(input.draftVersion) || input.draftVersion < 1 || !input.expectedUpdatedAt || !record(input.triggerConfig) || !workflowDefinition(input.graphDefinition)) throw new Error('流程草稿无效')
    const { session, generation } = await this.sessionSnapshot()
    if (session.status !== 'signed-in') throw new Error('请先登录')
    if (!session.permissions?.includes('teams:develop')) throw new Error('当前账号没有流程配置权限')
    const result = record((await this.weaveRequest(`/v1/workflows/${encodeURIComponent(input.workflowId)}/versions/${input.draftVersion}`, 'PUT', {
      expected_updated_at: input.expectedUpdatedAt,
      trigger_config: input.triggerConfig,
      graph_definition: input.graphDefinition,
    }, undefined, undefined, generation)).body)
    const updatedAt = textValue(result?.updated_at), draftVersion = numberValue(result?.version)
    if (!updatedAt || !draftVersion) throw new Error('Weave 没有返回流程草稿')
    return { draftVersion, updatedAt }
  }

  async createDevelopmentWorkflowDraft(workflowId: string): Promise<EnterpriseUpdateWorkflowDraftResult> {
    if (!workflowId) throw new Error('流程无效')
    const { session, generation } = await this.sessionSnapshot()
    if (session.status !== 'signed-in') throw new Error('请先登录')
    if (!session.permissions?.includes('teams:develop')) throw new Error('当前账号没有流程配置权限')
    const result = record((await this.weaveRequest(`/v1/workflows/${encodeURIComponent(workflowId)}/drafts`, 'POST', {}, undefined, undefined, generation)).body)
    const updatedAt = textValue(result?.updated_at), draftVersion = numberValue(result?.version)
    if (!updatedAt || !draftVersion) throw new Error('Weave 没有返回新版本草稿')
    return { draftVersion, updatedAt }
  }

  async validateDevelopmentWorkflow(workflowId: string, version: number): Promise<EnterpriseWorkflowValidation> {
    if (!workflowId || !Number.isInteger(version) || version < 1) throw new Error('流程版本无效')
    const { session, generation } = await this.sessionSnapshot()
    if (session.status !== 'signed-in') throw new Error('请先登录')
    if (!session.permissions?.includes('teams:develop')) throw new Error('当前账号没有流程配置权限')
    const result = record((await this.weaveRequest(`/v1/workflows/${encodeURIComponent(workflowId)}/versions/${version}/validate`, 'POST', {}, undefined, undefined, generation)).body)
    if (typeof result?.valid !== 'boolean' || !Array.isArray(result.issues)) throw new Error('Weave 返回了无法识别的检查结果')
    return { valid: result.valid, issues: result.issues.flatMap((value) => {
      const issue = record(value), code = textValue(issue?.code), message = textValue(issue?.message)
      if (!code || !message) return []
      return [{ code, message, ...(textValue(issue?.node_id) ? { nodeId: textValue(issue?.node_id) } : {}) }]
    }) }
  }

  async publishDevelopmentWorkflow(workflowId: string, version: number): Promise<void> {
    if (!workflowId || !Number.isInteger(version) || version < 1) throw new Error('流程版本无效')
    const { session, generation } = await this.sessionSnapshot()
    if (session.status !== 'signed-in') throw new Error('请先登录')
    if (!session.permissions?.includes('teams:develop')) throw new Error('当前账号没有流程发布权限')
    await this.weaveRequest(`/v1/workflows/${encodeURIComponent(workflowId)}/versions/${version}/publish`, 'POST', {}, undefined, undefined, generation)
  }

  async archiveDevelopmentWorkflow(workflowId: string): Promise<void> {
    if (!workflowId) throw new Error('流程无效')
    const { session, generation } = await this.sessionSnapshot()
    if (session.status !== 'signed-in') throw new Error('请先登录')
    if (!session.permissions?.includes('teams:develop')) throw new Error('当前账号没有流程归档权限')
    await this.weaveRequest(`/v1/workflows/${encodeURIComponent(workflowId)}`, 'DELETE', undefined, undefined, undefined, generation)
  }

  async getTeamMemberConfigDraft(teamId: string, agentId: string, expectedGeneration = this.authGeneration): Promise<EnterpriseTeamMemberConfigDraft> {
    this.assertAuthGeneration(expectedGeneration)
    const session = await this.getSession()
    this.assertAuthGeneration(expectedGeneration)
    if (session.status !== 'signed-in') throw new Error('请先登录')
    if (!session.permissions?.includes('teams:develop')) throw new Error('当前账号没有团队配置权限')
    return teamMemberConfigDraft(await this.weaveJSON(`/v1/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(agentId)}/config-draft`, expectedGeneration))
  }

  async saveTeamMemberConfigDraft(draft: EnterpriseTeamMemberConfigDraft): Promise<EnterpriseTeamMemberConfigDraft> {
    if (!draft?.teamId || !draft.agentId || !Number.isInteger(draft.revision) || !draft.configuration?.displayName?.trim()) throw new Error('团队成员配置不完整')
    const { session, generation } = await this.sessionSnapshot()
    if (session.status !== 'signed-in' || !session.permissions?.includes('teams:develop')) throw new Error('当前账号没有团队配置权限')
    let outputSchema: unknown
    if (draft.configuration.outputSchema.trim()) {
      try { outputSchema = JSON.parse(draft.configuration.outputSchema) }
      catch { throw new Error('输出格式需要填写有效的 JSON') }
    }
    const result = await this.weaveRequest(`/v1/teams/${encodeURIComponent(draft.teamId)}/members/${encodeURIComponent(draft.agentId)}/config-draft`, 'PUT', {
      revision: draft.revision,
      configuration: {
        tool_loop_control: draft.configuration.toolLoopControl ? { slice_rounds: draft.configuration.toolLoopControl.sliceRounds, initial_total_rounds: draft.configuration.toolLoopControl.initialTotalRounds } : null,
        max_tool_repeats: draft.configuration.maxToolRepeats ?? 0,
        display_name: draft.configuration.displayName.trim(), role: draft.configuration.role, engine: draft.configuration.engine,
        runtime_id: draft.configuration.runtimeId.trim(), model: draft.configuration.model.trim(), system_prompt: draft.configuration.systemPrompt,
        skill_names: draft.configuration.skillNames, skills: draft.configuration.skills.map((skill) => ({ name: skill.name, description: skill.description, body: skill.body, always_active: skill.alwaysActive })), mcp_server_ids: draft.configuration.mcpServerIds, business_capability_ids: draft.configuration.businessCapabilityIds,
        business_capability_bindings: draft.configuration.businessCapabilityBindings.map((binding) => ({ capability_id: binding.capabilityId, parameters: binding.parameters })),
        permission_allow: draft.configuration.permissionAllow, permission_ask: draft.configuration.permissionAsk, permission_deny: draft.configuration.permissionDeny,
        memory_enabled: draft.configuration.memoryEnabled, memory_scope: draft.configuration.memoryScope,
        max_tokens: draft.configuration.maxTokens, max_output_tokens: draft.configuration.maxOutputTokens,
        step_budget: draft.configuration.stepBudget, max_cost_usd: draft.configuration.maxCostUsd, ...(outputSchema === undefined ? {} : { output_schema: outputSchema }),
      },
      relationship: {
        duty: draft.relationship.duty, when_to_use: draft.relationship.whenToUse, context_instruction: draft.relationship.contextInstruction,
        allowed_kinds: draft.relationship.allowedKinds, default_kind: draft.relationship.defaultKind,
        result_requirement: draft.relationship.resultRequirement, enabled: draft.relationship.enabled,
      },
    }, undefined, undefined, generation)
    return teamMemberConfigDraft(result.body)
  }

  async applyTeamMemberConfigDraft(teamId: string, agentId: string, revision: number): Promise<EnterpriseTeamMemberConfigDraft> {
    if (!teamId || !agentId || !Number.isInteger(revision) || revision < 1) throw new Error('请选择要应用的成员草稿')
    const { session, generation } = await this.sessionSnapshot()
    if (session.status !== 'signed-in') throw new Error('请先登录')
    if (!session.permissions?.includes('teams:develop')) throw new Error('当前账号没有团队配置权限')
    const result = await this.weaveRequest(`/v1/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(agentId)}/config-draft/apply`, 'POST', { revision }, undefined, undefined, generation)
    return teamMemberConfigDraft(result.body)
  }

  async getFeishuStatus(): Promise<{ available: boolean; bound: boolean; expiresAt?: string }> {
    const result = record(await this.weaveJSON('/v1/integrations/feishu/binding'))
    if (typeof result?.available !== 'boolean' || typeof result?.bound !== 'boolean') throw new Error('飞书连接状态暂不可用')
    return { available: result.available, bound: result.bound, expiresAt: textValue(result.expires_at) }
  }

  async createFeishuLinkCode(): Promise<{ code: string; expiresAt: string }> {
    const result = record((await this.weaveRequest('/v1/integrations/feishu/link-code', 'POST', {})).body)
    const code = textValue(result?.code)
    const seconds = result?.code_expires_in_seconds
    if (!code || !/^[a-f0-9]{48}$/.test(code) || typeof seconds !== 'number' || seconds <= 0 || seconds > 600) throw new Error('飞书绑定码暂不可用')
    return { code, expiresAt: new Date(Date.now() + seconds * 1000).toISOString() }
  }

  async unlinkFeishu(): Promise<void> { await this.weaveRequest('/v1/integrations/feishu/binding', 'DELETE') }

  private async weaveRequest(path: string, method: 'POST' | 'PUT' | 'DELETE', body?: unknown, assertCurrent?: () => Promise<void>, extraHeaders?: HeadersInit, expectedGeneration = this.authGeneration): Promise<{ status: number; body: unknown }> {
    const headers = new Headers({ Accept: 'application/json', 'Content-Type': 'application/json' })
    if (extraHeaders) for (const [name, value] of new Headers(extraHeaders)) headers.set(name, value)
    this.assertAuthGeneration(expectedGeneration)
    await assertCurrent?.()
    const { response, snapshot } = await this.authenticatedFetch(new URL(path, this.weaveUrl), 'weave', {
      method, headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(15_000),
    }, expectedGeneration)
    const result = await response.json().catch(() => undefined)
    this.assertCurrentAuth(snapshot)
    const code = textValue(record(result)?.code) ?? textValue(record(record(result)?.error)?.code)
    if ([401, 403, 409].includes(response.status) && code && ['business_delegation_required', 'business_delegation_invalid', 'business_delegation_expired', 'business_delegation_identity_mismatch', 'business_delegation_scope_mismatch', 'business_delegation_generation_conflict'].includes(code)) {
      throw new WeaveHttpError(code === 'business_delegation_expired' ? '原工作任务授权已过期，请核对原输入并续授权；不要另建工作或重放未知动作' : '原工作任务授权无效、范围不符或已变化，请核对原工作授权；当前员工账号仍保持登录', response.status, code)
    }
    await this.assertResponseAuthorized(response, snapshot, '当前账号没有执行该团队请求的权限')
    if (!response.ok) {
      const error = textValue(record(result)?.error) ?? textValue(record(result)?.message) ?? `Weave 请求失败（${response.status}）`
      const index = record(result)?.index
      throw new WeaveHttpError(typeof index === 'number' ? `第 ${index + 1} 项：${error}` : error, response.status, code)
    }
    return { status: response.status, body: result }
  }

  private async deleteWeaveResource(path: string, expectedGeneration = this.authGeneration): Promise<void> {
    const { response, snapshot } = await this.authenticatedFetch(new URL(path, this.weaveUrl), 'weave', { method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(8_000) }, expectedGeneration)
    await this.assertResponseAuthorized(response, snapshot, '当前账号没有删除该团队配置的权限')
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Weave 删除失败（${response.status}）`) }
    await response.body?.cancel()
    this.assertCurrentAuth(snapshot)
  }

  private async workProjectID(expectedGeneration = this.authGeneration): Promise<string> {
    this.assertAuthGeneration(expectedGeneration)
    const session = await this.getSession()
    this.assertAuthGeneration(expectedGeneration)
    const subject = session.user?.weaveUserId ?? session.user?.id
    if (session.status !== 'signed-in' || !subject) throw new Error('请先登录')
    return `workbench-${subject}`
  }

  async accountKey(expectedGeneration = this.authGeneration): Promise<string> {
    this.assertAuthGeneration(expectedGeneration)
    const session = await this.getSession()
    this.assertAuthGeneration(expectedGeneration)
    return this.accountKeyForSession(session)
  }

  async getTeamCatalog(expectedGeneration = this.authGeneration): Promise<TeamSummary[]> { return teamCatalog(await this.weaveJSON('/v1/teams?status=active', expectedGeneration)) }
  async getTeamChoices(team: TeamSummary, expectedGeneration = this.authGeneration): Promise<EnterpriseWorkChoice[]> {
    return teamChoices(team, await this.weaveJSON(`/v1/teams/${encodeURIComponent(team.id)}/workflows`, expectedGeneration))
  }

  async getWorkOverview(): Promise<EnterpriseWorkOverview> {
    const { session, generation } = await this.sessionSnapshot()
    if (session.status !== 'signed-in') throw new Error('请先登录')
    const projectID = await this.workProjectID(generation)
    const { readEmployeeWorkOverview } = await import('./enterprise/work-overview')
    return readEmployeeWorkOverview(projectID, {
      getTeamCatalog: () => this.getTeamCatalog(generation), getTeamChoices: (team) => this.getTeamChoices(team, generation),
      weaveJSON: (path) => this.weaveJSON(path, generation), forgeJSON: (path, label) => this.forgeJSON(path, generation, label),
      readWorkNotificationSource: (id) => this.readWorkNotificationSource(id, generation),
      lookupWorkbenchRuns: (runIds) => this.lookupWorkbenchRuns(runIds, generation),
      readHumanTask: (references) => this.readWeaveHumanTask(references, generation),
      assertCurrent: () => this.assertAuthGeneration(generation),
    })
  }

  async getWorkRunStates(runIds: string[]): Promise<import('../../src/types/api').EnterpriseWorkRunStates> {
    if (!Array.isArray(runIds) || runIds.length > 1000 || runIds.some((id) => !boundedIdentity(id, 128))) throw new Error('工作查询范围无效')
    const { session, generation } = await this.sessionSnapshot()
    if (session.status !== 'signed-in') throw new Error('请先登录')
    // The server lookup requires workspace + employee ownership of each bound
    // run; generation checks reject responses from a previous desktop account.
    const result = await this.lookupWorkbenchRuns([...new Set(runIds)], generation)
    return { runs: result.runs.map(({ runId, status, isCurrent, businessResult }) => ({ runId, status: status as import('../../src/types/api').EnterpriseWorkRunState['status'], isCurrent, ...(businessResult ? { businessResult } : {}) })), missing: result.missing }
  }

  /** Recent team runs of the signed-in employee, for the background run watcher. */
  async listRecentWorkRunIds(): Promise<string[]> {
    const { session, generation } = await this.sessionSnapshot()
    if (session.status !== 'signed-in') return []
    const projectID = await this.workProjectID(generation)
    const body = await this.weaveJSON(`/v1/runs?project_id=${encodeURIComponent(projectID)}&limit=50`, generation)
    const items = Array.isArray(body) ? body : Array.isArray((body as { runs?: unknown })?.runs) ? (body as { runs: unknown[] }).runs : []
    return items.flatMap((item) => {
      const id = (item as { run_id?: unknown })?.run_id
      return typeof id === 'string' && boundedIdentity(id, 128) ? [id] : []
    })
  }

  async lookupOwnedWorkRuns(runIds: string[]): Promise<import('./enterprise/work-sources').WorkbenchRunLookupResponse> {
    const { session, generation } = await this.sessionSnapshot()
    if (session.status !== 'signed-in') return { runs: [], missing: [] }
    return this.lookupWorkbenchRuns([...new Set(runIds.filter((id) => boundedIdentity(id, 128)))], generation)
  }

  async getWorkRunDetails(runIdValue: string): Promise<import('../../src/types/api').EnterpriseWorkRunDetails> {
    const runId = boundedIdentity(runIdValue, 128)
    if (!runId) throw new Error('工作查询范围无效')
    const { session, generation } = await this.sessionSnapshot()
    if (session.status !== 'signed-in') throw new Error('请先登录')
    const owned = (await this.lookupWorkbenchRuns([runId], generation)).runs.find((run) => run.runId === runId)
    if (!owned) throw new Error('当前账号无法读取这项工作')
    const [activity, context] = await Promise.all([
      this.weaveJSON(`/v1/runs/${encodeURIComponent(runId)}/activity`, generation),
      this.weaveJSON(`/v1/runs/${encodeURIComponent(runId)}/workbench-context`, generation),
    ])
    const { workRunDetails } = await import('./enterprise/work-run-details')
    this.assertAuthGeneration(generation)
    return workRunDetails(owned, activity, context)
  }

  private async lookupWorkbenchRuns(runIds: string[], generation: number): Promise<import('./enterprise/work-sources').WorkbenchRunLookupResponse> {
    const { parseRunLookup } = await import('./enterprise/work-sources')
    const runs: import('./enterprise/work-sources').WorkbenchRunLookup[] = [], missing: string[] = []
    for (let offset = 0; offset < runIds.length; offset += 100) {
      const ids = runIds.slice(offset, offset + 100)
      const page = parseRunLookup((await this.weaveRequest('/v1/workbench/runs/lookup', 'POST', { version: '1', runIds: ids }, undefined, undefined, generation)).body)
      const resolved = new Set([...page.runs.map((run) => run.runId), ...page.missing])
      if (resolved.size !== ids.length || ids.some((id) => !resolved.has(id))) throw new Error('团队运行来源与查询不一致')
      runs.push(...page.runs); missing.push(...page.missing)
    }
    this.assertAuthGeneration(generation)
    return { runs, missing }
  }

  private async readWeaveHumanTask(references: { runId: string; interactionId: string; workReference: string; sessionReference: string }, generation: number): Promise<EnterpriseHumanTask | undefined> {
    const { parseWeaveHumanTask } = await import('./enterprise/work-sources')
    const query = new URLSearchParams({ input_revision_id: references.workReference, workbench_session_id: references.sessionReference, interaction_id: references.interactionId })
    const value = await this.weaveJSON(`/v1/human-tasks/${encodeURIComponent(references.runId)}?${query}`, generation)
    return parseWeaveHumanTask(value, references)
  }

  async cancelWork(runIdValue: string): Promise<import('../../src/types/api').EnterpriseWorkCancellationResult> {
    const runId = boundedIdentity(runIdValue, 128)
    if (!runId) throw new Error('工作信息无效，请刷新工作列表')
    const { session, generation } = await this.sessionSnapshot()
    if (session.status !== 'signed-in') throw new Error('请先登录')
    const accountKey = await this.accountKey(generation)
    const assertCurrent = async () => { this.assertAuthGeneration(generation); if (await this.accountKey(generation) !== accountKey) throw new Error('账号已切换，取消请求已失效') }
    return this.workCanceller.cancel(runId, accountKey, {
      assertCurrent,
      readContext: async () => {
        const { response, snapshot } = await this.authenticatedFetch(new URL(`/v1/runs/${encodeURIComponent(runId)}/workbench-context`, this.weaveUrl), 'weave', {
          headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, generation)
        await this.assertResponseAuthorized(response, snapshot, '当前账号没有取消这项工作的权限')
        if (response.status === 404) {
          await response.body?.cancel()
          const run = record(await this.weaveJSON(`/v1/runs/${encodeURIComponent(runId)}`, generation))
          if (run?.run_id !== runId || run.project_id !== undefined && (typeof run.project_id !== 'string' || run.project_id.startsWith('workbench-'))) throw new Error('无法核对原工作的任务授权，取消尚未确认')
          return undefined
        }
        if (!response.ok) { await response.body?.cancel(); throw new Error('原工作授权读取失败，取消尚未确认') }
        const value = await response.json()
        this.assertCurrentAuth(snapshot)
        const { parseWorkContinuationContext } = await import('./enterprise/work-continuation')
        return parseWorkContinuationContext(value)
      },
      revoke: async (grantID) => {
        const { response, snapshot } = await this.authenticatedFetch(new URL(`/api/v1/apps/forge/task-delegations/${encodeURIComponent(grantID)}`, this.forgeUrl), 'forge', {
          method: 'DELETE', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: 'employee_cancel' }), redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, generation)
        const body = await response.json().catch(() => undefined)
        this.assertCurrentAuth(snapshot)
        await this.assertResponseAuthorized(response, snapshot, '当前账号没有取消原工作授权的权限')
        return { status: response.status, body }
      },
      stop: (idempotencyKey) => this.weaveRequest(`/v1/runs/${encodeURIComponent(runId)}/stop`, 'POST', { reason: 'employee_cancel', idempotency_key: idempotencyKey }, assertCurrent, undefined, generation),
    })
  }

  private async readWorkContinuationMetadata(
    references: { workReference: string; runReference: string; sessionReference: string }, generation: number,
  ): Promise<EnterpriseWorkContinuationContext> {
    const workReference = boundedIdentity(references?.workReference, 512)
    const runReference = boundedIdentity(references?.runReference, 512)
    const sessionReference = boundedIdentity(references?.sessionReference, 512)
    if (!workReference || !runReference || !sessionReference) throw new Error('工作消息缺少原工作引用，请刷新工作消息')
    const { parseWorkContinuationContext } = await import('./enterprise/work-continuation')
    const context = parseWorkContinuationContext(await this.weaveJSON(`/v1/runs/${encodeURIComponent(runReference)}/workbench-context`, generation))
    if (context.source.inputRevisionID !== workReference || context.source.runID !== runReference || context.source.workbenchSessionID !== sessionReference) {
      throw new Error('工作消息与原团队工作不匹配，请刷新工作消息')
    }
    this.assertAuthGeneration(generation)
    return context
  }

  async getRunContinuationReferences(runIDValue: string): Promise<{ workReference: string; runReference: string; sessionReference: string }> {
    const { session, generation } = await this.sessionSnapshot()
    if (session.status !== 'signed-in') throw new Error('请先登录')
    const runID = boundedIdentity(runIDValue, 128)
    if (!runID) throw new Error('原工作无效，请刷新工作列表')
    const { parseWorkContinuationContext } = await import('./enterprise/work-continuation')
    const context = parseWorkContinuationContext(await this.weaveJSON(`/v1/runs/${encodeURIComponent(runID)}/workbench-context`, generation))
    if (context.source.runID !== runID || context.run.status !== 'parked') throw new Error('原运行状态已变化，请刷新工作列表后继续')
    this.assertAuthGeneration(generation)
    return { workReference: context.source.inputRevisionID, runReference: context.source.runID, sessionReference: context.source.workbenchSessionID }
  }

  async getWorkContinuationContext(references: { workReference: string; runReference: string; sessionReference: string }): Promise<EnterpriseWorkContinuationContext> {
    const { session, generation } = await this.sessionSnapshot()
    if (session.status !== 'signed-in') throw new Error('请先登录')
    const context = await this.readWorkContinuationMetadata(references, generation)
    const accountBeforeMaterials = await this.accountKey(generation)
    let totalBytes = 0
    let totalExtractedBytes = 0
    const materials: EnterpriseWorkContinuationContext['input']['materials'] = []
    for (const expected of context.input.materials) {
      if (expected.mediaType && isContinuationOriginalType(expected.mediaType)) {
        const originalPath = expected.sourceKind === 'owner'
          ? `/api/v1/workbench/materials/${encodeURIComponent(expected.id)}/original`
          : `/api/v1/approvals/requests/${encodeURIComponent(expected.requestId!)}/workbench-history/files/${encodeURIComponent(expected.id)}/original`
        const sourceBytes = await this.readOriginalMaterialBytes(
          originalPath, expected.mediaType, expected.bytes, expected.sha256, generation, '原工作',
        )
        const remainingExtractionBytes = MAX_WORKSPACE_EXTRACTION_BYTES - totalExtractedBytes
        if (remainingExtractionBytes < 1) throw new Error('原工作材料提取文本总量超出桌面读取限制')
        const extraction = await extractOriginalMaterialText(expected.mediaType, sourceBytes, expected.sha256, remainingExtractionBytes)
        totalBytes += sourceBytes.length
        totalExtractedBytes += extraction.bytes
        if (totalBytes > CONTINUATION_TOTAL_BYTES) throw new Error('原工作材料总量超出桌面读取限制')
        materials.push({ ...expected, extraction, content: extraction.content })
      } else {
        const raw = record(await this.forgeJSON(`/api/v1/workbench/materials/${encodeURIComponent(expected.id)}`, generation, '原工作材料'))
        const fileId = boundedIdentity(raw?.fileId, 128), name = boundedIdentity(raw?.name, 255)
        const mediaType = boundedIdentity(raw?.mediaType, 160), bytes = numberValue(raw?.bytes)
        const sha256 = typeof raw?.sha256 === 'string' ? raw.sha256 : undefined
        const content = typeof raw?.content === 'string' ? raw.content : undefined
        if (raw?.version !== '1' || fileId !== expected.id || name !== expected.name || !mediaType || !CONTINUATION_TEXT_TYPES.has(mediaType)
          || expected.mediaType !== undefined && continuationTextType(mediaType) !== continuationTextType(expected.mediaType)
          || !Number.isInteger(bytes) || bytes !== expected.bytes || !sha256 || sha256 !== expected.sha256 || !content || content.includes('\0')
          || Buffer.byteLength(content, 'utf8') !== bytes || createHash('sha256').update(content, 'utf8').digest('hex') !== sha256) {
          throw new Error('原工作材料与固定输入不一致，桌面不会继续')
        }
        totalBytes += bytes!
        totalExtractedBytes += bytes!
        if (totalBytes > CONTINUATION_TOTAL_BYTES || totalExtractedBytes > MAX_WORKSPACE_EXTRACTION_BYTES) throw new Error('原工作材料总量超出桌面读取限制')
        materials.push({ ...expected, mediaType: expected.mediaType ?? continuationTextType(mediaType), content })
      }
    }
    if (await this.accountKey(generation) !== accountBeforeMaterials) throw new Error('当前账号已变化，原工作材料不能继续使用')
    context.input.materials = materials
    this.assertAuthGeneration(generation)
    return context
  }

  private async readWorkNotificationSource(notificationID: string, generation: number): Promise<EnterpriseWorkNotificationSource> {
    const raw = record(await this.forgeJSON(`/api/v1/workbench/notifications/${encodeURIComponent(notificationID)}/source`, generation, '工作消息来源'))
    const source = record(raw?.source)
    const responseNotificationID = boundedIdentity(raw?.notificationId, 128)
    const kind = boundedIdentity(raw?.kind, 64)
    if (raw?.version !== '1' || responseNotificationID !== notificationID) throw new Error('工作消息来源与当前消息不匹配，请刷新工作列表')
    if (kind === 'business') {
      const objectName = boundedIdentity(source?.objectName, 128)
      const recordId = boundedIdentity(source?.recordId, 128)
      const materialStatus = raw?.materialStatus
      if (source?.system !== 'forge' || !objectName || !/^[a-z][a-z0-9_]{1,127}$/.test(objectName)
        || !recordId || !['available', 'none', 'unavailable'].includes(String(materialStatus))
        || !Array.isArray(raw.originalFiles)) {
        throw new Error('Forge 业务结果来源格式无效，请刷新工作消息')
      }
      if (Object.keys(raw).some((key) => !['version', 'notificationId', 'kind', 'source', 'materialStatus', 'originalFiles'].includes(key))
        || Object.keys(source).some((key) => !['system', 'objectName', 'recordId'].includes(key))) {
        throw new Error('Forge 业务结果来源包含未识别字段')
      }
      const seenFiles = new Set<string>()
      const originalFiles = raw.originalFiles.map((entry) => {
        const file = record(entry)
        const sourceKind = file?.sourceKind
        const requestId = boundedIdentity(file?.requestId, 128)
        const fileId = boundedIdentity(file?.fileId, 128)
        const name = boundedIdentity(file?.name, 255)
        const mediaType = file?.mediaType
        const bytes = numberValue(file?.bytes)
        const sha256 = typeof file?.sha256 === 'string' ? file.sha256 : undefined
        if (!file || Object.keys(file).some((key) => !['sourceKind', 'requestId', 'fileId', 'name', 'mediaType', 'bytes', 'sha256'].includes(key))
          || sourceKind !== 'owner' && sourceKind !== 'approval'
          || sourceKind === 'approval' && !requestId || sourceKind === 'owner' && file.requestId !== undefined
          || !fileId || seenFiles.has(fileId) || !name
          || mediaType !== 'application/pdf' && mediaType !== 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          || !Number.isInteger(bytes) || bytes! < 1 || bytes! > MAX_WORKSPACE_MATERIAL_BYTES
          || !sha256 || !/^[0-9a-f]{64}$/.test(sha256)) {
          throw new Error('Forge 业务结果材料来源或冻结版本无效')
        }
        seenFiles.add(fileId)
        return {
          sourceKind, ...(requestId ? { requestId } : {}), fileId, name,
          mediaType, bytes: bytes!, sha256,
        }
      })
      if (materialStatus === 'available' && originalFiles.length === 0 || materialStatus === 'none' && originalFiles.length !== 0) {
        throw new Error('Forge 业务结果材料状态与来源清单不一致')
      }
      this.assertAuthGeneration(generation)
      return {
        version: '1', notificationID, kind: 'business',
        source: { system: 'forge', objectName, recordId },
        materialStatus: materialStatus as EnterpriseBusinessWorkNotificationSource['materialStatus'],
        originalFiles: originalFiles as EnterpriseBusinessWorkNotificationSource['originalFiles'],
      }
    }
    const workReference = boundedIdentity(source?.workReference, 512)
    const runReference = boundedIdentity(source?.runReference, 512)
    const sessionReference = boundedIdentity(source?.sessionReference, 512)
    const interactionReference = source?.interactionReference === undefined ? undefined : boundedIdentity(source.interactionReference, 512)
    if (kind !== 'result' && kind !== 'failure' && kind !== 'revision_required' && kind !== 'cancelled' && kind !== 'human_review'
      || source?.system !== 'weave' || !workReference || !runReference || !sessionReference
      || source?.interactionReference !== undefined && !interactionReference
      || (kind === 'human_review') !== Boolean(interactionReference)
      || Object.keys(raw).some((key) => !['version', 'notificationId', 'kind', 'source'].includes(key))
      || Object.keys(source).some((key) => !['system', 'workReference', 'runReference', 'sessionReference', 'interactionReference'].includes(key))) {
      throw new Error('工作消息来源与当前消息不匹配，请刷新工作列表')
    }
    this.assertAuthGeneration(generation)
    return { version: '1', notificationID, kind, source: { system: 'weave', workReference, runReference, sessionReference, ...(interactionReference ? { interactionReference } : {}) } }
  }

  async getWorkNotificationSource(notificationIDValue: string): Promise<EnterpriseWorkNotificationSource> {
    const { session, generation } = await this.sessionSnapshot()
    if (session.status !== 'signed-in') throw new Error('请先登录')
    const notificationID = boundedIdentity(notificationIDValue, 128)
    if (!notificationID) throw new Error('工作消息无效，请刷新工作消息')
    return this.readWorkNotificationSource(notificationID, generation)
  }

  async getBusinessNotificationContext(notificationIDValue: string): Promise<EnterpriseBusinessNotificationContext> {
    const { session, generation } = await this.sessionSnapshot()
    if (session.status !== 'signed-in') throw new Error('请先登录')
    const notificationID = boundedIdentity(notificationIDValue, 128)
    if (!notificationID) throw new Error('业务结果消息无效，请刷新工作列表')
    const initialSource = await this.readWorkNotificationSource(notificationID, generation)
    if (initialSource.kind !== 'business') throw new Error('当前 Forge 消息不是可续接的业务结果')
    const accountBefore = await this.accountKey(generation)
    const recordBefore = await this.readBusinessRecord(initialSource.source.objectName, initialSource.source.recordId)
    if (recordBefore.candidate.objectName !== initialSource.source.objectName || recordBefore.candidate.recordId !== initialSource.source.recordId) {
      throw new Error('Forge 当前业务记录与消息来源不匹配')
    }
    let totalBytes = 0
    let totalExtractedBytes = 0
    const materials: EnterpriseBusinessNotificationContext['materials'] = []
    if (initialSource.materialStatus === 'available') {
      for (const expected of initialSource.originalFiles) {
        const originalPath = expected.sourceKind === 'owner'
          ? `/api/v1/workbench/materials/${encodeURIComponent(expected.fileId)}/original`
          : `/api/v1/approvals/requests/${encodeURIComponent(expected.requestId!)}/workbench-history/files/${encodeURIComponent(expected.fileId)}/original`
        const sourceBytes = await this.readOriginalMaterialBytes(originalPath, expected.mediaType, expected.bytes, expected.sha256, generation, '业务结果')
        totalBytes += sourceBytes.length
        if (totalBytes > CONTINUATION_TOTAL_BYTES) throw new Error('业务结果材料总量超出桌面读取限制')
        const remainingExtractionBytes = MAX_WORKSPACE_EXTRACTION_BYTES - totalExtractedBytes
        if (remainingExtractionBytes < 1) throw new Error('业务结果材料提取文本总量超出桌面读取限制')
        const extraction = await extractOriginalMaterialText(expected.mediaType, sourceBytes, expected.sha256, remainingExtractionBytes)
        totalExtractedBytes += extraction.bytes
        materials.push({ ...expected, extraction })
      }
    }
    const latestSource = await this.readWorkNotificationSource(notificationID, generation)
    if (JSON.stringify(latestSource) !== JSON.stringify(initialSource)) throw new Error('Forge 业务结果来源或材料版本已变化，请刷新工作消息')
    const recordAfter = await this.readBusinessRecord(initialSource.source.objectName, initialSource.source.recordId)
    const { capturedAt: _beforeReadAt, ...recordBeforeSnapshot } = recordBefore.snapshot
    const { capturedAt: _afterReadAt, ...recordAfterSnapshot } = recordAfter.snapshot
    if (JSON.stringify(recordBefore.candidate) !== JSON.stringify(recordAfter.candidate)
      || JSON.stringify(recordBeforeSnapshot) !== JSON.stringify(recordAfterSnapshot)
      || await this.accountKey(generation) !== accountBefore) {
      throw new Error('Forge 当前业务记录或员工账号已变化，请重新打开工作消息')
    }
    this.assertAuthGeneration(generation)
    return {
      kind: 'business', notificationID, source: initialSource.source,
      materialStatus: initialSource.materialStatus, materialReferences: structuredClone(initialSource.originalFiles), record: recordAfter,
      currentReadAt: new Date().toISOString(), materials,
    }
  }

  async getApprovalContext(approvalId: string): Promise<EnterpriseApprovalContext> {
    const { session, generation } = await this.sessionSnapshot()
    if (session.status !== 'signed-in' || !this.forgeToken) throw new Error('请先登录')
    const { response, snapshot } = await this.authenticatedFetch(
      new URL(`/api/v1/approvals/requests/${encodeURIComponent(approvalId)}/workbench-context`, this.forgeUrl),
      'forge', { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }, generation,
    )
    try { this.assertCurrentAuth(snapshot) }
    catch (error) { await response.body?.cancel(); throw error }
    if (response.status === 401) {
      await response.body?.cancel()
      await this.signOutIfCurrent(snapshot)
      throw new Error('登录已失效，请重新登录')
    }
    if (response.status === 403 || response.status === 404) {
      await response.body?.cancel()
      throw new Error('这项审批已无法由当前员工处理，请刷新待办')
    }
    if (response.status === 409) {
      await response.body?.cancel()
      throw new Error('审批状态已变化，请刷新待办')
    }
    if (response.status === 413) {
      await response.body?.cancel()
      throw new Error('审批材料过大，请在 Forge 中查看')
    }
    if (response.status === 415) {
      const code = await responseErrorCode(response)
      this.assertCurrentAuth(snapshot)
      throw new Error(code === 'APPROVAL_MATERIAL_UNSUPPORTED_TYPE'
        ? '此审批材料格式暂不支持桌面预览，请在 Forge 中查看'
        : '审批材料暂时无法读取，请刷新待办')
    }
    if (response.status === 422) {
      const code = await responseErrorCode(response)
      this.assertCurrentAuth(snapshot)
      const message = code === 'APPROVAL_MATERIAL_HASH_MISMATCH'
        ? '审批材料与本次提交版本不一致，请暂停处理并刷新待办'
        : code === 'APPROVAL_MATERIAL_HASH_UNAVAILABLE'
          ? '审批记录没有可核验的材料摘要，请在 Forge 中查看'
          : code === 'APPROVAL_MATERIAL_INVALID'
            ? '审批材料无法安全校验，请在 Forge 中查看'
            : code === 'APPROVAL_MATERIAL_UNAVAILABLE'
              ? '审批材料当前不可用，请在 Forge 中查看'
              : code === 'APPROVAL_CONTEXT_TOO_LARGE'
                ? '审批内容过大，暂不能在桌面中预览，请在 Forge 中查看'
                : '审批材料暂时无法安全读取，请刷新待办'
      throw new Error(message)
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error('Forge 审批上下文暂时无法读取')
    }
    let rawContext: unknown
    try { rawContext = await response.json() }
    catch {
      this.assertCurrentAuth(snapshot)
      throw new Error('Forge 审批上下文格式无效')
    }
    this.assertCurrentAuth(snapshot)
    const approval = record(rawContext)
    const isReviewer = approval?.status === 'pending' && approval.viewer === 'current_approver'
    const title = textValue(approval?.title), step = textValue(approval?.step)
    const businessObject = record(approval?.businessObject)
    const objectName = textValue(businessObject?.objectName), recordId = textValue(businessObject?.recordId)
    const recordName = textValue(businessObject?.recordName)
    const isReturnedSubmitter = approval?.status === 'returned' && approval.viewer === 'original_submitter'
    const isSubmittedOrder = approval?.status === 'pending' && approval.viewer === 'original_submitter' && objectName === 'forge_sales_order'
    const isSubmitter = isReturnedSubmitter || isSubmittedOrder
    const sourceMaterialVersion = textValue(approval?.sourceMaterialVersion)
    const returnVersion = textValue(approval?.returnVersion)
    if (approval?.version !== '1' || approval.requestId !== approvalId || (!isReviewer && !isSubmitter)
      || !title || title.length > 300 || !step || step.length > 160
      || !objectName || objectName.length > 160 || !recordId || recordId.length > 128
      || (recordName !== undefined && recordName.length > 300)
      || !sourceMaterialVersion || !/^[0-9a-f]{64}$/.test(sourceMaterialVersion)
      || (isReturnedSubmitter && (!returnVersion || returnVersion.length > 128))
      || (isSubmittedOrder && returnVersion !== undefined)) {
      throw new Error('这项审批已无法由当前员工处理，请刷新待办')
    }
    if (!Array.isArray(approval.fields) || approval.fields.length > 64 || !Array.isArray(approval.files)) {
      throw new Error('Forge 审批上下文格式无效')
    }
    const fields = approval.fields.flatMap((value) => {
      const field = record(value), label = textValue(field?.label), fieldValue = field?.value
      if (!label || label.length > 160 || typeof fieldValue !== 'string' || fieldValue.length > 4000) {
        throw new Error('Forge 审批上下文格式无效')
      }
      return fieldValue.trim() ? [{ label, value: fieldValue }] : []
    })
    const files = approval.files.map((value) => {
      const file = record(value), fileId = textValue(file?.fileId), name = textValue(file?.name), content = file?.content
      if (!fileId || fileId.length > 128 || !name || name.length > 255 || file?.mediaType !== 'text/plain; charset=utf-8'
        || typeof content !== 'string' || content.length > 2 * 1024 * 1024
        || !Number.isInteger(file.bytes) || (file.bytes as number) < 0 || (file.bytes as number) > 2 * 1024 * 1024
        || typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) {
        throw new Error('审批文件校验信息无效')
      }
      const bytes = Buffer.from(content, 'utf8')
      if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
        throw new Error('审批文件与提交版本不一致，请暂停处理')
      }
      return { fileId, name, mediaType: 'text/plain; charset=utf-8' as const, bytes: bytes.length, sha256: file.sha256, content, verified: true }
    })
    let originalFiles: FrozenApprovalOriginalMaterial[] | undefined
    if (approval.originalFiles !== undefined) {
      if (!Array.isArray(approval.originalFiles)) throw new Error('Forge 审批上下文格式无效')
      const seenIds = new Set<string>()
      let totalOriginalBytes = 0
      let totalExtractedBytes = 0
      originalFiles = []
      for (const value of approval.originalFiles) {
        const file = record(value)
        const sourceKind = file?.sourceKind
        const requestId = textValue(file?.requestId)
        const fileId = textValue(file?.fileId)
        const name = textValue(file?.name)
        const mediaType = file?.mediaType
        const bytes = numberValue(file?.bytes)
        const sha256 = typeof file?.sha256 === 'string' ? file.sha256 : undefined
        if (sourceKind !== 'approval' || requestId !== approvalId || !fileId || fileId.length > 128 || seenIds.has(fileId)
          || !name || name.length > 255
          || mediaType !== 'application/pdf' && mediaType !== 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          || !Number.isInteger(bytes) || bytes! < 1 || bytes! > MAX_WORKSPACE_MATERIAL_BYTES
          || !sha256 || !/^[0-9a-f]{64}$/.test(sha256)) {
          throw new Error('审批原件来源或冻结版本无效，请暂停处理')
        }
        seenIds.add(fileId)
        totalOriginalBytes += bytes!
        if (totalOriginalBytes > 8 * 1024 * 1024) throw new Error('审批原件总量超出桌面读取限制')
        const sourceBytes = await this.readOriginalMaterialBytes(
          `/api/v1/approvals/requests/${encodeURIComponent(approvalId)}/workbench-context/files/${encodeURIComponent(fileId)}/original`,
          mediaType, bytes!, sha256, generation, '审批',
        )
        const remainingExtractionBytes = MAX_WORKSPACE_EXTRACTION_BYTES - totalExtractedBytes
        if (remainingExtractionBytes < 1) throw new Error('审批原件提取文本总量超出桌面读取限制')
        const frozen = await freezeApprovalOriginalMaterial({
          sourceKind: 'approval', requestId: approvalId, fileId, name,
          mediaType, bytes: bytes!, sha256,
        }, sourceBytes, remainingExtractionBytes)
        totalExtractedBytes += frozen.extraction.bytes
        originalFiles.push(frozen)
      }
    }
    const returnReason = approval.returnReason
    if ((isReturnedSubmitter && typeof returnReason !== 'string')
      || (returnReason !== undefined && (typeof returnReason !== 'string' || returnReason.length > 4000))) {
      throw new Error('Forge 审批上下文格式无效')
    }
    const { parseCurrentApprovalActions } = await import('./enterprise/approval-actions')
    const { parseQuotationApprovalLines } = await import('./enterprise/quotation-approval-lines')
    const quotationLines = parseQuotationApprovalLines(approval.quotationLines, objectName)
    const declaredActions = parseCurrentApprovalActions(approval.availableActions, {
      requestId: approvalId, businessObject: { objectName, recordId }, sourceMaterialVersion,
    })
    const availableActions = objectName === 'forge_quotation' && !quotationLines
      ? declaredActions?.filter((action) => action.semantic !== 'approve') : declaredActions
    if (isSubmittedOrder && (availableActions?.length !== 1
      || availableActions[0]?.semantic !== 'recall'
      || availableActions[0]?.execution.actionName !== 'order_approval_mcp_recall')) {
      throw new Error('Forge 发起人审批动作目录无效，请刷新后重试')
    }
    if (isReviewer && availableActions?.some((action) => action.semantic === 'recall')) {
      throw new Error('Forge 当前审批人动作目录无效，请刷新后重试')
    }
    return {
      requestId: approvalId, status: isReturnedSubmitter ? 'returned' : 'pending', viewer: isSubmitter ? 'original_submitter' : 'current_approver',
      title, step, businessObject: { objectName, recordId, ...(recordName ? { recordName } : {}) }, sourceMaterialVersion,
      ...(isReturnedSubmitter ? { returnVersion, returnReason: returnReason as string } : {}),
      fields, ...(quotationLines ? { quotationLines } : {}), ...(availableActions !== undefined ? { availableActions } : {}),
      files, ...(originalFiles ? { originalFiles } : {}),
    }
  }

  private async nativeTaskIdentity(generation: number): Promise<{ id: string; organizationID: string }> {
    const identity = this.nativeForgeIdentity
    if (!identity) throw new Error('原生员工身份不可用，请重新登录')
    if (identity.organizationID) return { id: identity.id, organizationID: identity.organizationID }
    const current = record(await this.forgeJSON('/api/v1/auth/get-session', generation, '账号会话'))
    const user = record(current?.user), session = record(current?.session)
    const organizationID = textValue(session?.activeOrganizationId) ?? textValue(user?.organizationId)
    this.assertAuthGeneration(generation)
    if (user?.id !== identity.id || !organizationID) throw new Error('无法核对当前员工的原生组织，请在 Forge 核对账号会话')
    this.nativeForgeIdentity = { id: identity.id, organizationID }
    return { id: identity.id, organizationID }
  }

  async submitWork(choice: EnterpriseWorkChoice, goal: string, source?: FixedWorkSource): Promise<EnterpriseWorkReceipt> {
    const task = goal.trim()
    if (!task || !choice?.teamId || !choice.workflowId || !Number.isInteger(choice.version) || choice.version < 1) throw new Error('工作内容或团队流程无效')
    if (!source?.fixDelegationIntent) throw new Error('请从当前员工会话交接固定工作材料，直接交接入口不可用')
    const { session, generation } = await this.sessionSnapshot()
    if (session.status !== 'signed-in') throw new Error('请先登录')
    const identityIssuer = session.identitySource?.issuer
    if (!identityIssuer) throw new Error('账号绑定来源不可用，请重新登录')
    if (source.continuation && (!source.continuation.workbenchSessionID || !source.continuation.inputRevisionID || !source.continuation.runID || source.continuation.teamID !== choice.teamId)) throw new Error('原工作续版引用与当前团队不匹配')
    if (source.continuation?.restartAfterFailedRun && source.authorizedBusinessCapabilityIds.length) throw new Error('失败工作有业务动作时，请先核对 Forge 结果再继续')
    const assertCurrent = async () => {
      this.assertAuthGeneration(generation)
      if (await this.accountKey(generation) !== source.accountKey) throw new Error('当前账号已变化，本次交接已失效')
      await source.assertCurrent()
    }
    await assertCurrent()
    const projectID = await this.workProjectID(generation)
    const { fixedWorkHandoff } = await import('./enterprise/task-handoff')
    return fixedWorkHandoff(choice, task, source, {
      projectID, issuer: this.forgeUrl.origin, identityIssuer, assertCurrent,
      nativeIdentity: () => this.nativeTaskIdentity(generation),
      forge: (path, body) => this.forgeRequest(path, body, generation),
      weave: (path, body, taskToken) => this.weaveRequest(path, 'POST', body, assertCurrent, taskToken ? { 'X-Weave-Forge-Authorization': `Bearer ${taskToken}` } : undefined, generation),
    })
  }

  async renewWorkAuthorization(intent: FrozenAuthorizationRenewal, observer: RenewalObserver): Promise<AuthorizationRenewalResult> {
    const { session, generation } = await this.sessionSnapshot()
    if (session.status !== 'signed-in') throw new Error('请先登录')
    const identityIssuer = session.identitySource?.issuer
    if (!identityIssuer) throw new Error('账号绑定来源不可用，请重新登录')
    const assertCurrent = async () => {
      this.assertAuthGeneration(generation)
      if (await this.accountKey(generation) !== intent.accountKey) throw new Error('当前账号已变化，原工作不能续授权')
      await observer.assertCurrent()
    }
    await assertCurrent()
    const { renewFixedAuthorization } = await import('./enterprise/task-renewal')
    return renewFixedAuthorization(intent, {
      projectID: await this.workProjectID(generation), issuer: this.forgeUrl.origin, identityIssuer, assertCurrent,
      nativeIdentity: () => this.nativeTaskIdentity(generation),
      forge: (path, body) => this.forgeRequest(path, body, generation),
      weave: (path, body, token) => this.weaveRequest(path, 'POST', body, assertCurrent, token ? { 'X-Weave-Forge-Authorization': `Bearer ${token}` } : undefined, generation),
    }, () => this.readWorkContinuationMetadata({ workReference: intent.source.inputRevisionID, runReference: intent.source.runID, sessionReference: intent.source.workbenchSessionID }, generation), observer)
  }

  async completeHumanTask(task: Pick<EnterpriseHumanTask, 'runId' | 'interactionId' | 'inputRevisionID' | 'workbenchSessionID'>, payload: Record<string, unknown>): Promise<{ runId: string; repeated: boolean }> {
    if (!textValue(task?.runId) || !textValue(task?.interactionId) || !record(payload)) throw new Error('待办信息无效')
    const { session, generation } = await this.sessionSnapshot()
    if (session.status !== 'signed-in') throw new Error('请先登录')
    const forgeMatch = /^forge:(approval|revision|submitted):(.+)$/.exec(task.runId)
    if (forgeMatch) {
      if (forgeMatch[2] !== task.interactionId) throw new Error('审批事项已变化，请刷新后重试')
      if (forgeMatch[1] === 'revision') throw new Error('Forge 修订材料递交业务动作尚未接通，审批事项未递交')
      const accountKey = await this.accountKey(generation)
      const { completeViewedApproval } = await import('./enterprise/approval-ui-actions')
      return completeViewedApproval(this, task.interactionId, task.runId, accountKey, payload, this.approvalUiAttempts, () => this.assertAuthGeneration(generation))
    }
    const workReference = boundedIdentity(task.inputRevisionID, 128), sessionReference = boundedIdentity(task.workbenchSessionID, 256)
    if (!workReference || !sessionReference) throw new Error('团队人工事项缺少原工作来源，请从工作消息重新打开')
    const result = await this.weaveRequest(`/v1/human-tasks/${encodeURIComponent(task.runId)}/complete`, 'POST', {
      interaction_id: task.interactionId, payload, idempotency_key: `workbench-human-${task.interactionId}`,
      input_revision_id: workReference, workbench_session_id: sessionReference,
    }, undefined, undefined, generation)
    const body = record(result.body)
    const runId = textValue(body?.run_id)
    if (runId !== task.runId) throw new Error('Weave 没有返回原事项的处理结果')
    return { runId, repeated: body?.idempotent === true }
  }

  async getStatus(): Promise<EnterpriseEnvironmentStatus[]> {
    const targets = [
      { id: 'forge-development', name: 'Forge 业务环境', url: environmentUrl(this.environment.WORKBENCH_FORGE_URL, DEFAULT_FORGE_URL, 'Forge'), path: '/api/v1/health' },
      { id: 'weave-development', name: 'Weave 协作服务', url: environmentUrl(this.environment.WORKBENCH_WEAVE_URL, DEFAULT_WEAVE_URL, 'Weave'), path: '/v1/health' },
    ]
    return Promise.all(targets.map(async ({ id, name, url, path }) => {
      const checkedAt = new Date().toISOString()
      try {
        const response = await this.fetch(new URL(path, url), {
          headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        const body = await response.json().catch(() => undefined)
        return {
          id, name, url: url.origin, available: response.ok, secure: url.protocol === 'https:', checkedAt,
          version: versionFromHealth(body), ...(response.ok ? {} : { message: `服务返回 ${response.status}` }),
        }
      } catch {
        return { id, name, url: url.origin, available: false, secure: url.protocol === 'https:', checkedAt, message: '暂时无法连接' }
      }
    }))
  }
}
