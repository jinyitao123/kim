/**
 * Session partition shared by the in-app browser webviews. The renderer's
 * webview attribute must match the main process's will-attach-webview gate
 * exactly, or webview attach is silently blocked.
 */
import type { EmployeeBusinessRecord, EmployeeBusinessWork } from './employee-business'
export const BROWSER_PARTITION = 'prime-work-browser'

export type ThemeMode = 'system' | 'light' | 'dark'
export type WorkspaceView = 'session' | 'activity' | 'projects' | 'scheduled' | 'plugins' | 'settings'
export type InspectorTab = 'summary' | 'changes' | 'browser' | 'files'
export type SessionStatus = 'idle' | 'running' | 'waiting' | 'complete' | 'failed' | 'unknown'

export const HARNESS_IDS = ['prime', 'pi', 'loom'] as const
export type HarnessId = (typeof HARNESS_IDS)[number]

export interface HarnessStatus {
  path: string | null
  version: string | null
  problem?: {
    path: string
    reason: string
  }
}

export interface AppMeta {
  version: string
  platform: NodeJS.Platform
  homeDir: string
  harnesses: Record<HarnessId, HarnessStatus>
}

export interface EnterpriseEnvironmentStatus {
  id: string
  name: string
  url: string
  available: boolean
  secure: boolean
  version?: string
  checkedAt: string
  message?: string
}

export type EnterprisePermission = 'teams:use' | 'teams:develop' | 'teams:admin'

export type EnterpriseConnectionImportResult = { status: 'cancelled' } | {
  status: 'saved' | 'unchanged'
  config: { version: 1; forgeOrigin: string; weaveOrigin: string }
  environmentOverride: boolean
  restartRequired: boolean
}

/** A secret asked for by the app on the assistant's behalf; see the main process's secret prompt. */
export interface SecretPromptRequest { id: string; title: string; label: string; detail?: string }
export type SecretPromptEvent = SecretPromptRequest | { id: string; closed: true }
export interface ActionConfirmationRequest { id: string; action: string; record: string; fields: Array<{ label: string; value: string }> }
export type ActionConfirmationEvent = ActionConfirmationRequest | { id: string; closed: true }
export interface OperationPromptRequest { id: string; kind: 'confirm' | 'reveal'; title: string; subject?: string; message: string; values?: Array<{ label: string; value: string }> }
export type OperationPromptEvent = OperationPromptRequest | { id: string; closed: true }

export interface EnterpriseSession {
  version: '1'
  status: 'signed-out' | 'signed-in' | 'blocked' | 'unavailable'
  environment: { origin: string; secure: boolean }
  storage: 'private-file' | 'session-only'
  identitySource?: { kind: 'forge-account'; issuer: string }
  user?: { id: string; weaveUserId?: string; name: string; email: string }
  organization?: { id: string; name: string }
  permissions?: EnterprisePermission[]
  message?: string
  /** A sign-in is waiting for the employee to approve it in their browser. */
  signIn?: { userCode: string; verificationUri: string; expiresAt: string }
}

export interface EnterpriseTeamMember {
  id: string
  name: string
  role: string
  duty?: string
  enabled: boolean
}

export interface EnterpriseWorkflowObservation {
  id: string
  name: string
  description?: string
  status: string
  publishedVersion?: number
  draftVersion?: number
  inspectedVersion?: number
  triggerType?: string
  latestRunId?: string
  draftUpdatedAt?: string
  triggerConfig?: Record<string, unknown>
  graphDefinition?: EnterpriseWorkflowGraphDefinition
  nodes: Array<{ id: string; type: string; label?: string; workerId?: string }>
  edges: Array<{ from: string; to: string; label?: string; route?: string }>
}

export interface EnterpriseWorkflowGraphDefinition extends Record<string, unknown> {
  schema_version: number
  entry_node_id: string
  nodes: Array<Record<string, unknown> & { id: string; type: string; label?: string; config?: Record<string, unknown> }>
  edges: Array<Record<string, unknown> & { id?: string; from_node_id: string; to_node_id: string; route?: string }>
}

export interface EnterpriseRunObservation {
  id: string
  status: string
  agent?: string
  step?: string
  startedAt?: string
  durationMs: number
  tokensIn: number
  tokensOut: number
  costUsd: number
}

export interface EnterpriseWorkCancellationResult {
  runId: string
  status: 'cancel_requested' | 'cancelled' | 'completed' | 'unknown'
  authorizationRevoked: boolean
  message: string
}

/** Account-scoped Weave projection; this is execution state, not Forge approval. */
export interface EnterpriseWorkRunState {
  runId: string
  status: 'queued' | 'running' | 'parked' | 'cancel_requested' | 'succeeded' | 'failed' | 'cancelled' | 'abandoned'
  isCurrent: boolean
  businessResult?: 'completed' | 'needs_input' | 'action_failed' | 'action_unknown'
}

export interface EnterpriseWorkRunStates {
  runs: EnterpriseWorkRunState[]
  missing: string[]
}

export interface EnterpriseWorkRunDetails {
  runId: string
  status: EnterpriseWorkRunState['status']
  acceptedAt?: string
  finishedAt?: string
  observedAt?: string
  members: Array<{ name: string; status: string; stages: Array<{ name: string; status: string; durationMs?: number }> }>
  activityComplete: boolean
  materials: Array<{ name: string; format: string; bytes: number }>
  result?: { title: string; summary: string; missingItems: string[] }
  explanation: string
  authorizationRequired: boolean
  actionOutcomes?: Array<{ actionName: string; status: 'succeeded' | 'failed' | 'unknown'; summary: string }>
  actionCounts?: { succeeded: number; failed: number; unknown: number }
}

export interface EnterpriseTaskScopeDisplay {
  version: '1'
  source: 'workbench-host'
  runReference: string
  team: string
  workflow: string
  reads: string[]
  writes: string[]
}

export interface EnterpriseTeamObservation {
  id: string
  name: string
  objective?: string
  status: string
  updatedAt: string
  evaluation?: string
  lead?: EnterpriseTeamMember
  workers: EnterpriseTeamMember[]
  workflows: EnterpriseWorkflowObservation[]
  runs: EnterpriseRunObservation[]
  summary?: { workerCount: number; activeWorkflowCount: number; publishedWorkflowCount: number; health?: string; reasons: string[] }
}

/** One sign-in of the person's own account from an external (MCP) client. */
export interface EnterpriseClientSession {
  id: string
  client: string
  createdAt: string
  lastUsedAt?: string
  expiresAt: string
}

export interface EnterpriseDevelopmentOverview {
  version: '1'
  loadedAt: string
  teams: EnterpriseTeamObservation[]
  runtimes: Array<{ id: string; name: string; engines: string[]; status: string; online: boolean }>
  models: string[]
}

export interface EnterpriseCreateTeamInput {
  version: '1'
  name: string
  objective: string
}

export interface EnterpriseCreateTeamResult {
  id: string
  name: string
  objective: string
}

export interface EnterpriseUpdateTeamInput {
  version: '1'
  teamId: string
  name: string
  objective: string
  expectedUpdatedAt: string
}

export interface EnterpriseCreateTeamMemberInput {
  version: '1'
  teamId: string
  name: string
  duty: string
}

export interface EnterpriseTeamMemberMutationResult {
  id: string
  name: string
}

export interface EnterpriseCreateWorkflowInput {
  version: '1'
  teamId: string
  name: string
  description: string
  leadId: string
  workerId: string
}

export interface EnterpriseCreateWorkflowResult {
  id: string
  name: string
  draftVersion: number
}

export interface EnterpriseUpdateWorkflowDraftInput {
  version: '1'
  workflowId: string
  draftVersion: number
  expectedUpdatedAt: string
  triggerConfig: Record<string, unknown>
  graphDefinition: EnterpriseWorkflowGraphDefinition
}

export interface EnterpriseUpdateWorkflowDraftResult {
  draftVersion: number
  updatedAt: string
}

export interface EnterpriseWorkflowValidation {
  valid: boolean
  issues: Array<{ code: string; message: string; nodeId?: string }>
}

export interface EnterpriseTeamMemberAgentConfiguration {
    toolLoopControl?: { sliceRounds: number; initialTotalRounds: number } | null
    maxToolRepeats?: number
    displayName: string
    role: string
    engine: string
    runtimeId: string
    model: string
    systemPrompt: string
    skillNames: string[]
    skills: EnterpriseTeamMemberSkill[]
    mcpServerIds: string[]
    businessCapabilityIds: string[]
    businessCapabilityBindings: EnterpriseBusinessCapabilityBinding[]
    permissionAllow: string[]
    permissionAsk: string[]
    permissionDeny: string[]
    memoryEnabled: boolean
    memoryScope: string
    maxTokens: number
    maxOutputTokens: number
    stepBudget: number
    maxCostUsd: number
    outputSchema: string
}

export interface EnterpriseBusinessCapability {
  id: string
  name: string
  description: string
  effect: 'read' | 'write'
  executionMode?: 'employee_only' | 'team_delegable'
  resourceType: string
  requiresEmployeeIntent: boolean
  status: 'available' | 'unavailable'
  actionName?: string
  objectName?: string
  requiresRecord?: boolean
  requiresConfirmation?: boolean
  unavailableReason?: string
  params?: Array<{ name: string; label?: string; type?: 'string' | 'number' | 'boolean' | 'array' | 'file' | 'unsupported'; multiple?: boolean; required?: boolean; description?: string; enum?: string[] }>
}

export interface EnterpriseBusinessCapabilityBinding {
  capabilityId: string
  parameters: Array<{
    name: string
    source: 'materials.single.id' | 'materials.single.name' | 'materials.single.sha256' | 'materials.manifest_json' | 'materials.ids'
  }>
}

export interface EnterpriseBusinessCapabilityCatalog {
  version: '1'
  provider: { id: string; name: string; status: 'available' | 'unavailable' }
  capabilities: EnterpriseBusinessCapability[]
  refreshedAt: string
}

export interface EnterpriseTeamMemberSkill {
  name: string
  description: string
  body: string
  alwaysActive: boolean
}

export interface EnterpriseTeamMemberRelationshipConfiguration {
    duty: string
    whenToUse: string
    contextInstruction: string
    allowedKinds: string[]
    defaultKind: string
    resultRequirement: string
    enabled: boolean
}

export interface EnterpriseTeamMemberConfigDraft {
  version: '1'
  teamId: string
  agentId: string
  agentName: string
  baseAgentVersion: number
  revision: number
  updatedAt: string
  updatedBy?: string
  publishedConfiguration?: EnterpriseTeamMemberAgentConfiguration
  publishedRelationship?: EnterpriseTeamMemberRelationshipConfiguration
  configuration: EnterpriseTeamMemberAgentConfiguration
  relationship: EnterpriseTeamMemberRelationshipConfiguration
}

export interface EnterpriseWorkChoice {
  teamId: string
  teamName: string
  teamObjective?: string
  workflowId: string
  workflowName: string
  workflowDescription?: string
  businessCapabilityIds: string[]
  version: number
}

export interface EnterpriseHumanTask {
  interactionId: string
  runId: string
  /** Present only for a Weave task projected from the current native inbox source. */
  inputRevisionID?: string
  workbenchSessionID?: string
  teamId: string
  workflowId: string
  workflowVersion: number
  title: string
  instructions: string
  audience?: string
  updatedAt: string
  source?: 'weave' | 'forge'
  mode?: 'human_step' | 'approval' | 'revision' | 'submitted'
  materialLabel?: string
}

export interface EnterpriseApprovalAction {
  semantic?: string
  label: string
  description: string
  execution: {
    tool: 'run_action'
    actionName: string
    objectName: string
    recordId: string
    requiresConfirmation?: boolean
    params: {
      approvalRequestId: string
      itemVersion: string
      sourceMaterialVersion: string
    }
  }
  inputs: Array<{ name: string; type: 'string'; label: string; required: boolean }>
}

export interface QuotationApprovalLines {
  version: '1'
  pricingVersion: number
  itemCount: number
  totalAmount: number
  rows: Array<{ position: number; name: string; lineType: 'material' | 'service'; quantity: number; taxedUnitPrice: number; taxRate: number; discountRate: number; taxedSubtotal: number; unitName?: string }>
}

export interface EnterpriseApprovalContext {
  requestId: string
  status: 'pending' | 'returned'
  viewer: 'current_approver' | 'original_submitter'
  title: string
  step: string
  businessObject: { objectName: string; recordId: string; recordName?: string }
  sourceMaterialVersion: string
  returnVersion?: string
  returnReason?: string
  fields: Array<{ label: string; value: string }>
  quotationLines?: QuotationApprovalLines
  availableActions?: EnterpriseApprovalAction[]
  files: Array<{ fileId: string; name: string; mediaType: 'text/plain; charset=utf-8'; bytes: number; sha256: string; content: string; verified: boolean }>
  originalFiles?: Array<{
    sourceKind: 'approval'
    requestId: string
    fileId: string
    name: string
    mediaType: 'application/pdf' | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    bytes: number
    sha256: string
    bytesBase64: string
    extraction: {
      status: 'complete' | 'partial' | 'unsupported'
      mediaType: 'text/plain; charset=utf-8'
      bytes: number
      sha256: string
      sourceSha256: string
      content: string
      extractor: 'utf8' | 'pdfjs-dist' | 'mammoth'
      coverage: {
        pdfPageCount?: number
        pdfTextPageCount?: number
        pdfPagesWithoutText?: number[]
        docxParagraphCount?: number
        docxTableCount?: number
        docxTableCellCount?: number
        docxOmittedContentCount?: number
      }
      limitations: Array<'page-without-text' | 'embedded-image' | 'unsupported-document-content'>
    }
  }>
}

/** Renderer-safe approval projection. Native object and file identifiers stay in the main process. */
export interface EnterpriseApprovalContextView {
  actionVersion?: string
  actions?: Array<{ actionRef: string; semantic: string; label: string }>
  title: string
  step: string
  returnReason?: string
  fields: Array<{ label: string; value: string }>
  quotationLines?: QuotationApprovalLines
  files: Array<{ name: string; content: string; verified: boolean }>
  originalFiles?: Array<{
    name: string
    mediaType: 'application/pdf' | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    bytes: number
    verified: boolean
    extraction: {
      status: 'complete' | 'partial' | 'unsupported'
      content: string
      coverage: {
        pdfPageCount?: number
        pdfTextPageCount?: number
        pdfPagesWithoutText?: number[]
        docxParagraphCount?: number
        docxTableCount?: number
        docxTableCellCount?: number
        docxOmittedContentCount?: number
      }
      limitations: Array<'page-without-text' | 'embedded-image' | 'unsupported-document-content'>
    }
  }>
}

export interface EnterpriseWorkItem {
  id: string
  kind: 'notification' | 'result' | 'failure' | 'revision_required' | 'human_review' | 'cancelled'
  notificationType?: string
  title: string
  summary?: string
  instructions?: string
  status: 'unknown' | 'unread' | 'pending' | 'in_progress' | 'completed' | 'cancelled'
  actionable: boolean
  read: boolean
  source: 'weave' | 'forge'
  createdAt: string
  actionUrl?: string
  workReference?: string
  runReference?: string
  sessionReference?: string
  materialLabel?: string
  returnReason?: string
  returnTarget?: 'origin_review' | 'team' | 'member' | 'human_step'
  reviewScope?: 'whole_team' | 'affected_members' | 'human_step'
}

/** Renderer-safe subset after the main process validates a native notification source. */
export interface EnterpriseWeaveWorkContinuationContextView {
  kind: 'weave'
  task: string
  runStatus: 'queued' | 'running' | 'parked' | 'cancel_requested' | 'succeeded' | 'failed' | 'cancelled' | 'abandoned'
  businessResult?: 'completed' | 'needs_input' | 'action_failed' | 'action_unknown'
  inputStatus?: 'current' | 'superseded' | 'closed'
  authorization?: { status: 'active' | 'renewal_required' | 'not_applicable'; reason?: string; canRenew: boolean }
  materials: Array<{
    name: string
    bytes: number
    sha256: string
    content: string
    extraction?: {
      status: 'complete' | 'partial' | 'unsupported'
      limitations: Array<'page-without-text' | 'embedded-image' | 'unsupported-document-content'>
    }
  }>
  finalResult?: {
    title: string
    contentType: string
    content: string
    disposition?: 'complete' | 'needs_input'
    summary?: string
    missingItems?: string[]
  }
  actionOutcomes?: Array<{ actionName: string; objectName: string; status: 'succeeded' | 'failed' | 'unknown'; summary: string }>
}

export interface EnterpriseBusinessNotificationContextView {
  kind: 'business'
  currentReadAt: string
  materialStatus: 'available' | 'none' | 'unavailable'
  record: {
    objectLabel: string
    name: string
    code?: string
    status?: string
    owner?: string
    fields: Array<{ label: string; value: unknown }>
    relations: Array<{
      label: string
      direction: 'related' | 'reference'
      records: Array<Array<{ label: string; value: unknown }>>
      returnedCount: number
      limit: number
      complete: boolean
      requiredForCalculation?: boolean
      expectedCount?: number
    }>
    completeness: 'complete' | 'partial' | 'truncated' | 'incomplete'
    pricingDetailCompleteness: 'complete' | 'incomplete' | 'unknown'
    expectedDetailCount?: number
    completenessNotes: string[]
  }
  materials: NonNullable<EnterpriseApprovalContextView['originalFiles']>
}

export type EnterpriseWorkContinuationContextView = EnterpriseWeaveWorkContinuationContextView | EnterpriseBusinessNotificationContextView

export interface EnterpriseWorkOverview {
  businessWork?: EmployeeBusinessWork[]
  loadedAt: string
  choices: EnterpriseWorkChoice[]
  tasks: EnterpriseHumanTask[]
  /** Pending sales-order approvals submitted by the current employee; recall is optional, not a to-do. */
  submittedApprovals?: EnterpriseHumanTask[]
  items: EnterpriseWorkItem[]
  runs: EnterpriseRunObservation[]
  reads: {
    runs: EnterpriseWorkReadStatus
    teamChoices: EnterpriseWorkReadStatus
    weaveTasks: EnterpriseWorkReadStatus
    forgeApprovals: EnterpriseWorkReadStatus
    businessWork?: EnterpriseWorkReadStatus
    notifications: EnterpriseWorkReadStatus
  }
}

export interface EnterpriseWorkReadStatus {
  status: 'loaded' | 'failed'
  error?: string
  /** The source holds more items than this refresh could show. */
  truncated?: boolean
}

export interface EnterpriseWorkReceipt {
  inputRevisionId?: string
  clientRequestId?: string
  taskSha256?: string
  workId: string
  runId: string
  taskId: string
  workflowId: string
  workflowVersion: number
  repeated: boolean
}

export interface EnterpriseWorkResource {
  type: 'forge-file'
  sourceKind?: 'owner' | 'approval'
  requestId?: string
  materialId?: string
  id: string
  name: string
  mediaType?: WorkspaceMaterialMimeType
  bytes: number
  sha256: string
}

export type ApplicationMenuName = 'file' | 'edit' | 'view' | 'window' | 'help'

export type AppUpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error' | 'unsupported'

export interface AppUpdateState {
  phase: AppUpdatePhase
  version?: string
  percent?: number
  message?: string
}

export interface ProjectScripts {
  setup: string
  run: string
  /** Exact setup command most recently started for this project. */
  setupLastRun?: string
  /** Missing while the latest setup command is running or was interrupted. */
  setupLastExitCode?: number
}

export interface ProjectRecord {
  id: string
  /** Agent harness this project grant belongs to; grants never cross harnesses. */
  harness: HarnessId
  /** App-managed personal workspaces let people start work without selecting a code project. */
  purpose?: 'personal' | 'project'
  name: string
  path: string
  folders: string[]
  primaryFolder: string
  materialsFolder?: string
  deliveriesFolder?: string
  pinned: boolean
  createdAt: string
  lastOpenedAt: string
  sessionCount: number
  gitBranch?: string
  inferred?: boolean
  readOnly?: boolean
  scripts?: ProjectScripts
}

export type WorkspaceMaterialMimeType =
  | 'text/plain'
  | 'text/markdown'
  | 'text/csv'
  | 'application/json'
  | 'application/pdf'
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/** An employee-selected source file copied byte-for-byte into the authorized workspace. */
export interface WorkspaceMaterialReference {
  projectId: string
  harness: HarnessId
  /** Absolute workspace identity retained locally and never sent to the model. */
  workspacePath: string
  name: string
  path: string
  sha256: string
  bytes: number
  mimeType: WorkspaceMaterialMimeType
}

export type WorkspaceMaterialPromptReference = Pick<WorkspaceMaterialReference, 'name' | 'path' | 'sha256' | 'bytes' | 'mimeType'>

/** Captured only by the trusted desktop input path; never a runtime/model argument. */
export interface EmployeePromptInput {
  text: string
  materials: WorkspaceMaterialReference[]
}

export interface SessionRecord {
  id: string
  /** Agent harness that owns this session; populated by the owning session service. */
  harness: HarnessId
  filePath: string
  projectPath: string
  title: string
  createdAt: string
  updatedAt: string
  lastUserMessageAt?: string
  status: SessionStatus
  model?: string
  provider?: string
  thinkingLevel?: string
  depth: number
  pinned?: boolean
  unread?: boolean
  /** Monotonic renderer lifecycle revision used to distinguish attention events. */
  eventRevision?: number
  /** Lifecycle revision that authored the current status; absent when the catalog owns it. */
  statusEventRevision?: number
  preview?: string
  archived?: boolean
  syncRevision?: number
}

export interface PromptImage {
  type: 'image'
  mimeType: string
  data: string
}

export interface BrowserAnnotationRect {
  x: number
  y: number
  width: number
  height: number
}

/** Element info captured from the embedded browser page. Every field is untrusted page data: bounded on capture, rendered as plain text only. */
export interface BrowserAnnotationElement {
  selector: string
  tagName: string
  id: string
  classes: string[]
  text: string
  href?: string
  src?: string
  rect: BrowserAnnotationRect
}

export interface BrowserAnnotation {
  id: string
  comment: string
  element: BrowserAnnotationElement
  pageUrl: string
  pageTitle: string
  /** True once the page navigated away after capture: the live marker is gone but the captured info remains valid. */
  stale: boolean
  createdAt: number
}

export type PrimeCompactionReason = 'manual' | 'threshold' | 'overflow' | 'requested'
export type PrimeCompactionStatus = 'running' | 'done' | 'failed' | 'cancelled'
export type PrimeCompactionOutcome = 'failed' | 'cancelled' | 'skipped'

export type MessagePart =
  | { type: 'text'; partId?: string; text: string }
  | { type: 'thinking'; partId?: string; text: string }
  | { type: 'toolCall'; partId?: string; id?: string; name: string; args?: unknown }
  | { type: 'toolResult'; partId?: string; name?: string; text: string; isError?: boolean; streaming?: boolean }
  | { type: 'agentMessage'; partId?: string; text: string; agentName?: string }
  | { type: 'image'; partId?: string; mimeType?: string; data?: string; dataTruncated?: boolean }
  | {
      type: 'compaction'
      partId?: string
      status: PrimeCompactionStatus
      reason?: PrimeCompactionReason
      outcome?: PrimeCompactionOutcome
      tokensBefore?: number
      firstKeptEntryId?: string
      summary?: string
      error?: string
      customInstructions?: string
      willRetry?: boolean
    }

export interface TranscriptMessage {
  id: string
  role: 'user' | 'assistant' | 'agent' | 'goal' | 'tool' | 'system'
  /** Renderer-local steering lifecycle. Persisted transcripts remain harness-owned. */
  steerState?: 'accepted' | 'read'
  /** Lightweight renderer-only boundary showing where an accepted steer was consumed. */
  kind?: 'steer-read-marker'
  timestamp?: string | number
  agentName?: string
  startedAt?: string | number
  completedAt?: string | number
  parts: MessagePart[]
  streaming?: boolean
}

export interface PrimeContextUsage {
  tokens: number | null
  contextWindow: number
  percent: number | null
}

export interface SessionUsageTokens {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

/** Cumulative cost and token totals for the in-context session, as reported by get_session_stats. */
export interface SessionUsage {
  /** USD cost summed from catalog pricing; null when the harness reports none. */
  cost: number | null
  tokens?: SessionUsageTokens
}

export interface RuntimeInfo {
  runtimeId: string
  harness: HarnessId
  sessionId?: string
  sessionFile?: string
  cwd: string
  isStreaming: boolean
  sessionActions?: SessionActionSnapshot
  isCompacting?: boolean
  model?: { provider?: string; id?: string; name?: string } | null
  /** Renderer-local notice; never persisted or used to update the model picker. */
  executingModel?: { provider?: string; id: string; label: string; isFallback: true } | null
  thinkingLevel?: string
  availableThinkingLevels?: PrimeThinkingLevel[]
  fastModeSupported?: boolean
  imageInputSupported?: boolean
  fastModeAvailable?: boolean
  serviceTier?: PrimeServiceTier
  contextUsage?: PrimeContextUsage
  sessionUsage?: SessionUsage
}

export const PRIME_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type PrimeThinkingLevel = (typeof PRIME_THINKING_LEVELS)[number]
export type PrimeServiceTier = 'auto' | 'default' | 'flex' | 'scale' | 'priority' | null
export type ProviderAuthMethod = 'oauth' | 'api_key' | 'external'
export type ProviderAuthSource = 'stored' | 'runtime' | 'environment' | 'prime_cli' | 'fallback' | 'models_json_key' | 'models_json_command' | 'stale'

export interface PrimeModelDescriptor {
  key: string
  provider: string
  id: string
  name: string
  reasoning: boolean
  input: Array<'text' | 'image'>
  contextWindow: number
  maxTokens: number
  availableThinkingLevels: PrimeThinkingLevel[]
  fastModeSupported: boolean
  available: boolean
  /** GooeyPi visibility policy for this harness; absent catalogs predate per-model controls. */
  enabled?: boolean
}

export interface PrimeProviderDescriptor {
  id: string
  name: string
  authMethod: ProviderAuthMethod
  configured: boolean
  authSource?: ProviderAuthSource
  authLabel?: string
  modelCount: number
  availableModelCount: number
  enabled: boolean
}

export interface PrimeModelCatalog {
  primeVersion: string
  refreshedAt: string
  models: PrimeModelDescriptor[]
  providers: PrimeProviderDescriptor[]
  warning?: string
}

export type ProviderAuthEvent =
  | { flowId: string; providerId: string; type: 'auth'; url: string; instructions?: string }
  | { flowId: string; providerId: string; type: 'progress'; message: string }
  | { flowId: string; providerId: string; type: 'prompt'; promptId: string; message: string; placeholder?: string; allowEmpty?: boolean }
  | { flowId: string; providerId: string; type: 'select'; promptId: string; message: string; options: Array<{ id: string; label: string }> }
  | { flowId: string; providerId: string; type: 'complete' | 'cancelled' }
  | { flowId: string; providerId: string; type: 'error'; error: string }

export interface PrimeEventEnvelope {
  runtimeId: string
  event: Record<string, unknown>
}

export interface SessionChangeEvent {
  filePath?: string
  /** Harness whose session catalog changed; absent events predate harness scoping. */
  harness?: HarnessId
}

export interface SkillRecord {
  id: string
  name: string
  description: string
  kind: 'skill' | 'extension' | 'prompt' | 'package' | 'mcp'
  location: 'bundled' | 'user' | 'project' | 'system'
  path?: string
  enabled: boolean
  icon?: string
  source?: string
  /** MCP server ids this package exists to bridge. Used to collapse duplicate capability rows. */
  associatedMcpServers?: string[]
  associatedPackageSource?: string
  /** Exact bounded map key used only for definition removal; never rendered as display copy. */
  definitionKey?: string
  /** False when an external definition key cannot be represented safely by the app removal API. */
  definitionRemovalAvailable?: boolean
  availability?: {
    available: boolean
    detail: string
    actionUrl?: string
  }
}

export interface PluginWarning {
  scope: 'user' | 'project'
  path: string
  message: string
}

export interface PluginCatalog {
  skills: SkillRecord[]
  warnings: PluginWarning[]
}

export type McpConnectionInput = {
  name: string
  scope: 'user' | 'project'
  projectPath?: string
} & (
  | { type: 'http'; url: string; auth?: 'none' | 'oauth' | 'bearer'; bearerTokenEnvVar?: string }
  | { type: 'stdio'; command: string; args?: string[] }
)

export interface McpStateInput {
  name: string
  scope: 'user' | 'project'
  projectPath?: string
  enabled: boolean
}

export interface CapabilityMutationInput {
  kind: 'package' | 'mcp'
  action: 'enable' | 'disable' | 'remove'
  name: string
  /** Exact bounded MCP map key for definition-only removal. */
  definitionKey?: string
  source?: string
  scope: 'user' | 'project'
  projectPath?: string
}

export interface ExtensionInstallInput {
  source: string
  scope: 'user' | 'project'
  projectPath?: string
}

export interface ProjectFileEntry { path: string; type: 'file' | 'directory' }
export interface ProjectFileListing { entries: ProjectFileEntry[]; skipped: number }

export interface GitWorktree {
  path: string
  name: string
  branch?: string
  head: string
  current: boolean
  detached: boolean
}

export const CHECKOUT_STRATEGIES = ['worktree', 'branch'] as const
export type CheckoutStrategy = (typeof CHECKOUT_STRATEGIES)[number]

export interface LocalGitBranch {
  name: string
  current: boolean
}

export type CheckoutCatalog =
  | { strategy: 'worktree'; activePath: string; checkouts: GitWorktree[] }
  | { strategy: 'branch'; activeName: string; checkouts: LocalGitBranch[] }

export type CheckoutAction =
  | { strategy: 'worktree'; operation: 'open'; path: string }
  | { strategy: 'worktree'; operation: 'create'; branch: string }
  | { strategy: 'branch'; operation: 'switch'; branch: string }
  | { strategy: 'branch'; operation: 'create'; branch: string }

export type CheckoutSelection =
  | { strategy: 'worktree'; path: string }
  | { strategy: 'branch'; branch: string }

export type CheckoutRefusalCode =
  | 'strategy-changed'
  | 'active-work'
  | 'dirty-worktree'
  | 'checkout-not-found'
  | 'checkout-already-exists'

export type CheckoutChangeResult =
  | { kind: 'applied'; project: ProjectRecord; checkout: CheckoutSelection }
  | { kind: 'unchanged'; project: ProjectRecord; checkout: CheckoutSelection }
  | { kind: 'cancelled' }
  | { kind: 'refused'; code: CheckoutRefusalCode; message: string }

export interface GitFileChange {
  path: string
  status: string
  staged: boolean
  additions: number
  deletions: number
}
export interface GitStatus {
  isRepo: boolean
  branch?: string
  upstream?: string
  ahead?: number
  behind?: number
  files: GitFileChange[]
  truncated?: boolean
  error?: string
}
export interface GitDiff { path?: string; staged: boolean; text: string; truncated: boolean; error?: string }

/**
 * The one result shape for subprocess-backed operations (git commit, package
 * install, MCP settings updates). `reason` classifies failures: the subprocess
 * timed out, exceeded its output limit, exited non-zero, or the operation was
 * blocked before or instead of running the subprocess.
 */
export type ProcessFailureReason = 'timeout' | 'overflow' | 'exit' | 'blocked'
export interface ProcessOutcome { ok: boolean; output: string; reason?: ProcessFailureReason }

export interface TerminalSpawnOptions { cwd: string; sessionPath?: string; shell?: string; command?: string; cols?: number; rows?: number }
export interface TerminalDataEvent { terminalId: string; data: string }
export interface TerminalExitEvent { terminalId: string; exitCode: number; signal?: number }
export interface TerminalSelectionContext { tabId: string; label: string; text: string; truncated: boolean }
export interface TerminalPromptContext extends TerminalSelectionContext { cwd?: string }
export interface TerminalActiveContext { label: string; content: string; truncated: boolean }

export type MessageEnterAction = 'queue' | 'steer'
export type PromptDeliveryIntent = 'queue' | 'steer'

export interface PetDefinition {
  /** Stable settings key. Codex pets are namespaced as codex/<folder>. */
  id: string
  /** Package manifest id, used to deduplicate bundled and Codex copies. */
  petId: string
  displayName: string
  description: string
  source: 'built-in' | 'codex'
  kind: 'orb' | 'spritesheet'
}

export interface QueuedPrompt {
  id: string
  text: string
  intent: PromptDeliveryIntent
  /** Stable presentation data while a steer waits for the agent to pick it up. */
  timestamp?: number
  parts?: MessagePart[]
  /** The most recent automatic flush attempt failed admission. */
  flushAttemptFailed?: boolean
  /** Opaque main-process context binding for a returned approval continuation. */
  returnedApprovalContextHandle?: string
  /** Opaque main-process context binding for read-only assistance on one current approval. */
  approvalReviewContextHandle?: string
  /** Opaque main-process binding for a Weave-owned work continuation. */
  workContinuationContextHandle?: string
  employeeInput?: EmployeePromptInput
}

export interface SessionActionSnapshot {
  queuedCount: number
  steering: string[]
  followUps: string[]
  active?: {
    kind: 'turn' | 'session_command'
    phase: 'preparing' | 'committing' | 'running'
    label?: string
  }
}

export const INTERFACE_FONT_SCALES = [105, 110, 115] as const
export type InterfaceFontScale = typeof INTERFACE_FONT_SCALES[number]
export const LOCALE_PREFERENCES = ['system', 'en', 'zh-CN'] as const
export type LocalePreference = typeof LOCALE_PREFERENCES[number]
export const PROJECT_SORT_MODES = ['recent', 'alphabetical'] as const
export type ProjectSortMode = typeof PROJECT_SORT_MODES[number]

export interface AppSettings {
  theme: ThemeMode
  locale: LocalePreference
  /** Bounded interface text scale; 110 is the designed default. */
  interfaceFontScale: InterfaceFontScale
  /** Order the renderer derives for project lists; 'recent' keeps launch behaviour unchanged. */
  projectSortMode: ProjectSortMode
  sidebarOpen: boolean
  inspectorOpen: boolean
  showFileChangesPopup: boolean
  checkoutStrategy: CheckoutStrategy
  /** Keep the desktop process available for scheduled work after its window closes. */
  keepRunningInBackground: boolean
  /** Ask the operating system to launch GooeyPi when the user signs in. */
  launchAtLogin: boolean
  terminalOpen: boolean
  defaultInspectorTab: InspectorTab
  browserHome: string
  browserAskForDownloads: boolean
  terminalShell: string
  reduceMotion: boolean
  showReasoningSummaries: boolean
  showToolCalls: boolean
  messageEnterAction: MessageEnterAction
  /** Optional absolute executable overrides; blank keeps automatic discovery. */
  runtimePaths: Record<HarnessId, string>
  /** Legacy visibility preference retained for state compatibility; executable detection is authoritative. */
  enabledHarnesses: HarnessId[]
  /**
   * Legacy diagnostics preference retained for persisted-state compatibility.
   * The Privacy UI deliberately ignores this field; any reporting use needs separate review.
   */
  telemetry: boolean
  /** GooeyPi-managed ask_user tool, shared by every interactive harness. */
  askUserEnabled: boolean
  /** Expose GooeyPi's thread-scoped in-app browser controls to new sessions. */
  browserEnabled: boolean
  /** Expose the separately installed TryCUA driver to new sessions through its official CLI. */
  computerUseEnabled: boolean
  /** Providers hidden from Prime Work's Prime model picker. */
  disabledProviders: string[]
  /** Models hidden from Prime Work's Prime model picker, stored as provider/model keys. */
  disabledModels: string[]
  /** Providers hidden from Prime Work's pi model picker; pi config is untouched. */
  piDisabledProviders: string[]
  /** Models hidden from Prime Work's pi model picker; pi config is untouched. */
  piDisabledModels: string[]
  /** Last usable model selected in each harness; blank falls back to the first usable catalog model. */
  lastSelectedModels: Record<HarnessId, string>
  /** Harness whose workspace the renderer shows; new installs default to Pi Work. */
  activeHarness: HarnessId
  /** Desktop companion shown above the workspace. */
  petEnabled: boolean
  /** Built-in or discovered pet selection id. */
  petId: string
  /** Desktop companion size as a percentage of its native workspace size. */
  petSize: number
  /** Speech-to-text path used by the composer microphone. */
  voiceTranscriptionProvider: VoiceTranscriptionProvider
  /** Provider model IDs stay configurable without exposing provider credentials. */
  voiceOpenAiLiveTranscriptionModel: string
  voiceOpenAiTranscriptionModel: string
  voiceGroqTranscriptionModel: string
  voiceDeepgramTranscriptionModel: string
  /** User-managed OpenAI-compatible Parakeet or Whisper transcription server. */
  voiceSelfHostedUrl: string
  voiceSelfHostedModel: string
  /** User-managed whisper.cpp installation for offline transcription. */
  voiceLocalWhisperExecutable: string
  voiceLocalWhisperModel: string
  /** Realtime orb model and synthesized voice. */
  voiceRealtimeModel: string
  voiceRealtimeVoice: string
}

export const VOICE_TRANSCRIPTION_PROVIDERS = ['openai-live', 'openai', 'groq', 'deepgram', 'self-hosted', 'local-whisper'] as const
export type VoiceTranscriptionProvider = typeof VOICE_TRANSCRIPTION_PROVIDERS[number]
export const VOICE_CREDENTIAL_PROVIDERS = ['openai', 'groq', 'deepgram', 'self-hosted'] as const
export type VoiceCredentialProvider = typeof VOICE_CREDENTIAL_PROVIDERS[number]

export interface VoiceCredentialStorageStatus {
  available: boolean
  message?: string
}

export interface VoiceCredentialStatus {
  configured: Record<VoiceCredentialProvider, boolean>
  source: Partial<Record<VoiceCredentialProvider, 'saved' | 'environment' | 'session'>>
  storage: VoiceCredentialStorageStatus
}

export type VoiceRealtimeCallRequest =
  | { mode: 'conversation'; sdp: string; harness: HarnessId }
  | { mode: 'transcription'; sdp: string }

export interface VoiceTranscriptionRequest {
  provider: Exclude<VoiceTranscriptionProvider, 'openai-live'>
  audio: Uint8Array
}

export interface VoiceSelfHostedTestRequest {
  url: string
  model: string
}

export interface VoiceProjectSummary {
  id: string
  harness: HarnessId
  name: string
  lastOpenedAt: string
}

export interface VoiceTaskStarted {
  projectId: string
  projectName: string
  harness: HarnessId
  runtimeId: string
  sessionId?: string
  sessionFile: string
  model?: Pick<PrimeModelDescriptor, 'key' | 'provider' | 'id' | 'name'>
  reasoning?: PrimeThinkingLevel
}

export type VoiceToolRequest =
  | { name: 'list_projects'; arguments: { query?: string } }
  | { name: 'list_models'; arguments: { query?: string } }
  | { name: 'start_task'; arguments: { project_id: string; prompt: string; title?: string; model?: string; reasoning?: string } }
  | { name: 'get_local_context'; arguments: Record<string, never> }
  | { name: 'search_web'; arguments: { query: string } }

export interface VoiceToolResult {
  output: string
  task?: VoiceTaskStarted
}

export type ScheduleDefinitionStatus = 'active' | 'paused' | 'completed' | 'blocked'
export type ScheduleRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'interrupted' | 'cancelled'
export type ScheduleCreatedBy = 'user' | 'agent'

export type ScheduleTarget =
  | { kind: 'project'; projectId: string }
  | { kind: 'session'; projectId: string; sessionId: string }

export type ScheduleTiming =
  | { kind: 'once'; at: string }
  | { kind: 'rrule'; dtstartLocal: string; timeZone: string; rrule: string }

export interface ScheduleExecution {
  model: 'auto' | string
  thinking: 'auto' | PrimeThinkingLevel
  speed: 'normal' | 'fast'
}

export interface ScheduleRunRecord {
  id: string
  taskId: string
  taskRevision: number
  trigger: 'scheduled' | 'manual'
  scheduledFor: string
  queuedAt: string
  startedAt?: string
  finishedAt?: string
  status: ScheduleRunStatus
  execution: ScheduleExecution
  sessionId?: string
  sessionFile?: string
  error?: string
  skippedCount?: number
}

export interface AutomationScheduleRecord {
  schemaVersion: 1
  id: string
  /** Harness that owns the target, model catalog, and runtime for every run. */
  harness: HarnessId
  revision: number
  title: string
  prompt: string
  target: ScheduleTarget
  timing: ScheduleTiming
  execution: ScheduleExecution
  status: ScheduleDefinitionStatus
  createdBy: ScheduleCreatedBy
  createdAt: string
  updatedAt: string
  nextRunAt?: string
  blockedReason?: string
  /** Projection only. Persisted ownership metadata lives in the main-process store. */
  ownerMigrationState?: 'bound' | 'migrated' | 'needs_review'
  runs: ScheduleRunRecord[]
}

export interface ScheduleInput {
  title?: string
  prompt: string
  target: ScheduleTarget
  timing: ScheduleTiming
  execution: ScheduleExecution
  createdBy?: ScheduleCreatedBy
}

export interface SchedulePatch {
  revision: number
  title?: string
  prompt?: string
  target?: ScheduleTarget
  timing?: ScheduleTiming
  execution?: ScheduleExecution
}

export interface SchedulePreview {
  timing: ScheduleTiming
  occurrences: string[]
}

export interface ScheduleChangeEvent {
  taskId?: string
  reason: 'created' | 'updated' | 'deleted' | 'run'
}

export interface NativeHeartbeatRecord {
  id: string
  source: 'heartbeat' | 'rlm_heartbeat'
  status: 'active' | 'paused'
  prompt: string
  schedule: string
  sessionId: string
  sessionFile: string
  activeSessionId: string
  deliveryMode?: 'steer' | 'follow_up'
  nextRunAt?: string
  lastRunAt?: string
  label?: string
  runtimeId?: string
}

/** One agent-controlled browser tab. The registry lives in the main process; the renderer hosts the webview guests and mirrors this state. */
export interface AgentBrowserTabRecord {
  tabId: string
  /** Canonical session file path of the thread this tab belongs to. */
  sessionFile: string
  url: string
  title: string
  /** Whether a live webview guest is currently bound to this tab. */
  attached: boolean
  /** Whether this is the session's currently targeted tab. */
  active: boolean
  canGoBack: boolean
  canGoForward: boolean
}

export interface AgentBrowserState {
  tabs: AgentBrowserTabRecord[]
}

/** Emitted for every agent browser action, so the UI can surface the Browser panel while the agent works. */
export interface AgentBrowserActivityEvent {
  sessionFile: string
  tabId: string
}

/** Emitted when the agent moves the pointer in a tab, so the UI can animate a synthetic cursor along the same path on the same clock. */
export interface AgentBrowserPointerEvent {
  tabId: string
  sessionFile: string
  /** Previous pointer position, or null when the cursor first appears in a tab. */
  from: { x: number; y: number } | null
  to: { x: number; y: number }
  action: 'move' | 'click' | 'scroll'
  /** How long the glide takes; 0 means the cursor appears in place. */
  durationMs: number
}

export interface PrimeWorkApi {
  app: { getMeta(): Promise<AppMeta>; refreshHarnesses(): Promise<{ meta: AppMeta; settings: AppSettings }>; openExternal(url: string): Promise<boolean>; revealPath(path: string): Promise<boolean>; popupMenu(menu: ApplicationMenuName, x: number, y: number): Promise<boolean>; setTitleBarTheme(theme: Exclude<ThemeMode, 'system'>): Promise<boolean>; onOpenSettings(callback: () => void): () => void }
  updates: {
    getState(): Promise<AppUpdateState>
    check(): Promise<AppUpdateState>
    downloadAndInstall(): Promise<boolean>
    onChanged(callback: (state: AppUpdateState) => void): () => void
  }
  enterprise: {
    importConnection(): Promise<EnterpriseConnectionImportResult>
    restartConnection(): Promise<void>
    teamWorkspace: import('./team-workspace').TeamWorkspaceBridge
    updateTeamDevelopment(runtimeId: string, input: import('./team-workspace').TeamDevelopmentContextInput): Promise<void>
    invalidateTeamDevelopmentTurn(runtimeId: string): Promise<void>
    getTeamDevelopmentProposal(runtimeId: string): Promise<import('./team-workspace').TeamDevelopmentProposalResult | undefined>
    getTeamDevelopmentState(runtimeId: string): Promise<import('./team-workspace').TeamDevelopmentState>
    getTeamDevelopmentStateForSession(sessionFile: string): Promise<import('./team-workspace').TeamDevelopmentState>
    invalidateHandoff(runtimeId: string): Promise<void>
    getStatus(): Promise<EnterpriseEnvironmentStatus[]>
    getFeishuStatus(): Promise<{ available: boolean; bound: boolean; expiresAt?: string }>
    createFeishuLinkCode(): Promise<{ code: string; expiresAt: string }>
    unlinkFeishu(): Promise<void>
    getSession(): Promise<EnterpriseSession>
    signIn(): Promise<EnterpriseSession>
    cancelSignIn(): Promise<EnterpriseSession>
    reopenSignIn(): Promise<void>
    signOut(): Promise<EnterpriseSession>
    onSessionChanged(callback: (session: EnterpriseSession) => void): () => void
    /** The assistant needs a secret; the window asks for it and answers the app directly. */
    onSecretPrompt(callback: (request: SecretPromptEvent) => void): () => void
    answerSecretPrompt(id: string, value: string | null): Promise<void>
    onActionConfirmation(callback: (request: ActionConfirmationEvent) => void): () => void
    answerActionConfirmation(id: string, confirmed: boolean): Promise<void>
    onOperationPrompt(callback: (request: OperationPromptEvent) => void): () => void
    answerOperationPrompt(id: string, confirmed: boolean): Promise<void>
    getDevelopmentOverview(): Promise<EnterpriseDevelopmentOverview>
    getBusinessCapabilityCatalog(): Promise<EnterpriseBusinessCapabilityCatalog>
    createDevelopmentTeam(input: EnterpriseCreateTeamInput): Promise<EnterpriseCreateTeamResult>
    updateDevelopmentTeam(input: EnterpriseUpdateTeamInput): Promise<void>
    createDevelopmentTeamMember(input: EnterpriseCreateTeamMemberInput): Promise<EnterpriseTeamMemberMutationResult>
    removeDevelopmentTeamMember(teamId: string, memberId: string): Promise<void>
    createDevelopmentWorkflow(input: EnterpriseCreateWorkflowInput): Promise<EnterpriseCreateWorkflowResult>
    createDevelopmentWorkflowDraft(workflowId: string): Promise<EnterpriseUpdateWorkflowDraftResult>
    updateDevelopmentWorkflowDraft(input: EnterpriseUpdateWorkflowDraftInput): Promise<EnterpriseUpdateWorkflowDraftResult>
    validateDevelopmentWorkflow(workflowId: string, version: number): Promise<EnterpriseWorkflowValidation>
    publishDevelopmentWorkflow(workflowId: string, version: number): Promise<void>
    archiveDevelopmentWorkflow(workflowId: string): Promise<void>
    getTeamMemberConfigDraft(teamId: string, agentId: string): Promise<EnterpriseTeamMemberConfigDraft>
    saveTeamMemberConfigDraft(draft: EnterpriseTeamMemberConfigDraft): Promise<EnterpriseTeamMemberConfigDraft>
    applyTeamMemberConfigDraft(teamId: string, agentId: string, revision: number): Promise<EnterpriseTeamMemberConfigDraft>
    getWorkOverview(): Promise<EnterpriseWorkOverview>
    getWorkRunStates(runIds: string[]): Promise<EnterpriseWorkRunStates>
    getWorkRunDetails(runId: string): Promise<EnterpriseWorkRunDetails>
    cancelWork(runId: string): Promise<EnterpriseWorkCancellationResult>
    getApprovalContext(approvalId: string): Promise<EnterpriseApprovalContextView>
    pinReturnedApprovalContext(approvalId: string): Promise<{ handle: string; context: EnterpriseApprovalContextView }>
    pinApprovalReviewContext(approvalId: string): Promise<{ handle: string; context: EnterpriseApprovalContextView }>
    pinWorkContinuationContext(item: Pick<EnterpriseWorkItem, 'id' | 'source' | 'notificationType' | 'workReference' | 'runReference' | 'sessionReference'>): Promise<{ handle: string; context: EnterpriseWorkContinuationContextView }>
    pinEmployeeBusinessContext(record: EmployeeBusinessRecord): Promise<{ handle: string; prompt: string }>
    submitWork(choice: EnterpriseWorkChoice, goal: string): Promise<EnterpriseWorkReceipt>
    completeHumanTask(task: Pick<EnterpriseHumanTask, 'runId' | 'interactionId' | 'inputRevisionID' | 'workbenchSessionID'>, payload: Record<string, unknown>): Promise<{ runId: string; repeated: boolean }>
  }
  projects: {
    list(harness?: HarnessId): Promise<ProjectRecord[]>
    listFiles(root: string, harness?: HarnessId): Promise<ProjectFileListing>
    importTextMaterial(projectId: string, workspacePath: string, name: string, bytes: Uint8Array, harness?: HarnessId): Promise<WorkspaceMaterialReference>
    listCheckouts(projectId: string, harness?: HarnessId): Promise<CheckoutCatalog>
    executeCheckout(projectId: string, action: CheckoutAction, harness?: HarnessId): Promise<CheckoutChangeResult>
    add(harness?: HarnessId): Promise<ProjectRecord | null>
    grantInferred(path: string, harness?: HarnessId): Promise<ProjectRecord>
    remove(id: string, harness?: HarnessId): Promise<boolean>
    touch(id: string, harness?: HarnessId): Promise<boolean>
    setPinned(id: string, pinned: boolean, harness?: HarnessId): Promise<boolean>
    updateScripts(id: string, scripts: Pick<ProjectScripts, 'setup' | 'run'>, harness?: HarnessId): Promise<ProjectScripts>
    markSetupStarted(id: string, setup: string, harness?: HarnessId): Promise<ProjectScripts>
    finishSetup(id: string, setup: string, exitCode: number, harness?: HarnessId): Promise<ProjectScripts | undefined>
  }
  sessions: {
    list(projectPath?: string, includeArchived?: boolean, harness?: HarnessId, force?: boolean): Promise<SessionRecord[]>
    read(filePath: string): Promise<TranscriptMessage[]>
    followUp(filePath: string, message: string, intent?: PromptDeliveryIntent): Promise<boolean>
    rename(filePath: string, title: string): Promise<boolean>
    archive(filePath: string, archived?: boolean): Promise<boolean>
    onChanged(callback: (event: SessionChangeEvent) => void): () => void
  }
  agent: {
    start(options: { cwd: string; sessionPath?: string; model?: string; thinking?: string; fast?: boolean; harness?: HarnessId }): Promise<RuntimeInfo>
    command(runtimeId: string, command: Record<string, unknown>, deliveryContext?: { returnedApprovalContextHandle?: string; approvalReviewContextHandle?: string; workContinuationContextHandle?: string; employeeInput?: EmployeePromptInput }): Promise<Record<string, unknown>>
    stop(runtimeId: string): Promise<boolean>
    list(): Promise<RuntimeInfo[]>
    onEvent(callback: (envelope: PrimeEventEnvelope) => void): () => void
  }
  providers: {
    catalog(force?: boolean, harness?: HarnessId): Promise<PrimeModelCatalog>
    saveApiKey(providerId: string, apiKey: string, harness?: HarnessId): Promise<PrimeModelCatalog>
    logout(providerId: string, harness?: HarnessId): Promise<PrimeModelCatalog>
    setEnabled(providerId: string, enabled: boolean, harness?: HarnessId): Promise<PrimeModelCatalog>
    setDisabled(providerIds: string[], harness?: HarnessId): Promise<PrimeModelCatalog>
    setModelEnabled(modelKey: string, enabled: boolean, harness?: HarnessId): Promise<PrimeModelCatalog>
    startOAuth(providerId: string): Promise<{ flowId: string }>
    respondOAuth(flowId: string, promptId: string, value?: string): Promise<boolean>
    cancelOAuth(flowId: string): Promise<boolean>
    onAuthEvent(callback: (event: ProviderAuthEvent) => void): () => void
  }
  voice: {
    credentialStatus(): Promise<VoiceCredentialStatus>
    saveApiKey(provider: VoiceCredentialProvider, apiKey: string): Promise<VoiceCredentialStatus>
    deleteApiKey(provider: VoiceCredentialProvider): Promise<VoiceCredentialStatus>
    createRealtimeCall(request: VoiceRealtimeCallRequest): Promise<string>
    transcribe(request: VoiceTranscriptionRequest): Promise<string>
    testSelfHosted(request: VoiceSelfHostedTestRequest): Promise<boolean>
    executeTool(request: VoiceToolRequest, harness: HarnessId): Promise<VoiceToolResult>
  }
  pets: {
    list(): Promise<PetDefinition[]>
    sprite(id: string): Promise<string | null>
  }
  terminal: {
    create(options: TerminalSpawnOptions): Promise<{ terminalId: string; shell: string }>
    bindSession(terminalId: string, sessionPath: string): Promise<boolean>
    input(terminalId: string, data: string): void
    resize(terminalId: string, cols: number, rows: number): void
    setActiveContext(terminalId: string, context: TerminalActiveContext): void
    clearActiveContext(terminalId: string): void
    kill(terminalId: string): Promise<boolean>
    onData(callback: (event: TerminalDataEvent) => void): () => void
    onExit(callback: (event: TerminalExitEvent) => void): () => void
  }
  git: { status(cwd: string): Promise<GitStatus>; diff(cwd: string, path?: string, staged?: boolean): Promise<GitDiff>; stage(cwd: string, paths: string[]): Promise<boolean>; unstage(cwd: string, paths: string[]): Promise<boolean>; restore(cwd: string, paths: string[]): Promise<boolean>; commit(cwd: string, message: string): Promise<ProcessOutcome> }
  plugins: {
    list(projectPath?: string, harness?: HarnessId): Promise<PluginCatalog>
    install(source: string, harness?: HarnessId): Promise<ProcessOutcome>
    installExtension(input: ExtensionInstallInput, harness?: HarnessId): Promise<ProcessOutcome>
    setMcpSupport(enabled: boolean, harness?: HarnessId): Promise<ProcessOutcome>
    connectMcp(input: McpConnectionInput, harness?: HarnessId): Promise<ProcessOutcome>
    setMcpEnabled(input: McpStateInput, harness?: HarnessId): Promise<ProcessOutcome>
    mutateCapability(input: CapabilityMutationInput, harness?: HarnessId): Promise<ProcessOutcome>
    refresh(harness?: HarnessId): Promise<PluginCatalog>
  }
  settings: { get(): Promise<AppSettings>; update(patch: Partial<AppSettings>): Promise<AppSettings>; resetBrowserData(): Promise<boolean> }
  browser: {
    state(): Promise<AgentBrowserState>
    attachTab(tabId: string, webContentsId: number): Promise<boolean>
    selectTab(tabId: string): Promise<boolean>
    closeTab(tabId: string): Promise<boolean>
    setPreviewContext(webContentsId: number | null, sessionFile: string | null): Promise<boolean>
    navigateTab(tabId: string, action: 'back' | 'forward' | 'reload' | 'url', url?: string): Promise<boolean>
    onChanged(callback: (state: AgentBrowserState) => void): () => void
    onPointer(callback: (event: AgentBrowserPointerEvent) => void): () => void
    onActivity(callback: (event: AgentBrowserActivityEvent) => void): () => void
  }
  heartbeats: {
    list(): Promise<NativeHeartbeatRecord[]>
    manage(id: string, action: 'pause' | 'resume' | 'stop'): Promise<NativeHeartbeatRecord | null>
  }
  schedules: {
    list(harness?: HarnessId): Promise<AutomationScheduleRecord[]>
    get(id: string): Promise<AutomationScheduleRecord>
    preview(timing: ScheduleTiming, count?: number): Promise<SchedulePreview>
    create(input: ScheduleInput, harness?: HarnessId): Promise<AutomationScheduleRecord>
    update(id: string, patch: SchedulePatch): Promise<AutomationScheduleRecord>
    pause(id: string): Promise<AutomationScheduleRecord>
    resume(id: string): Promise<AutomationScheduleRecord>
    delete(id: string): Promise<boolean>
    runNow(id: string): Promise<ScheduleRunRecord>
    onChanged(callback: (event: ScheduleChangeEvent) => void): () => void
  }
}

declare global { interface Window { prime: PrimeWorkApi } }
