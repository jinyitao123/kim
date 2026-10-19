import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentEnterpriseBridge } from '../../electron/main/enterprise/agent-bridge'
import { digest, HandoffStore, submissionUUID } from '../../electron/main/enterprise/handoff-store'
import { freezeApprovalOriginalMaterial, freezeMaterials, makeFrozenTextMaterial, normalizeFrozenMaterial, type FrozenMaterial } from '../../electron/main/enterprise/materials'
import type { EnterpriseApprovalAction, EnterpriseApprovalContext, EnterpriseSession, TranscriptMessage } from '../../src/types/api'
import { WorkRegistrationRejectedError, type EnterpriseBusinessNotificationContext, type EnterpriseWorkContinuationContext, type EnterpriseWorkNotificationSource, type NativeMcpActionArguments, type NativeMcpActionAttempt } from '../../electron/main/enterprise'
import type { EmployeeBusinessContext, EmployeeBusinessRequest, EmployeeBusinessSelection, EmployeeBusinessTarget } from '../../src/types/employee-business'
import { employeeBusinessRequestDigest } from '../../electron/main/enterprise/employee-business-contract'
import { ForgeBusinessReadError, type BusinessRecordSnapshot } from '../../electron/main/enterprise/business-records'
import { presentBusinessRecord } from '../../electron/main/enterprise/business-record-presentation'
import { appendWorkspaceMaterialContext } from '../../src/lib/workspace-material-attachments'
import { APPROVAL_REVIEW_SESSION_MARKER } from '../../src/lib/approval-review'
import { fixedWorkHandoff, taskScopeSHA256, type FixedWorkSource, type ForgeTaskScope } from '../../electron/main/enterprise/task-handoff'
import type { InitializationScope } from '../../electron/main/enterprise/initialization'
import type { InitializationAction } from '../../src/types/enterprise-initialization'

const bridges: AgentEnterpriseBridge[] = [], directories: string[] = []
afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()))
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
function user(id: string, text: string): TranscriptMessage { return { id, role: 'user', parts: [{ type: 'text', text }] } }
function forgeSession(id = 'employee-a'): EnterpriseSession {
  return {
    version: '1', status: 'signed-in', environment: { origin: 'https://forge.example.test', secure: true }, storage: 'session-only',
    user: { id, weaveUserId: `weave-${id}`, name: id, email: `${id}@example.test` },
    organization: { id: 'organization-a', name: '组织甲' }, permissions: ['teams:use'],
  }
}
function currentItemActionServiceStubs() {
  return {
    getSession: vi.fn(async () => forgeSession()),
    getApprovalActionHistory: vi.fn(async () => [] as unknown[]),
    runNativeMcpAction: vi.fn(async (_args: NativeMcpActionArguments, _assertCurrent: () => Promise<void>): Promise<NativeMcpActionAttempt> => ({ status: 'unknown' })),
  }
}
function workContinuationContext(): EnterpriseWorkContinuationContext {
  const task = '请按客户确认的技术协议继续检查交付范围。'
  const finalResult = '团队检查发现验收期限仍需确认。'
  return {
    version: '1' as const,
    source: { inputRevisionID: 'input-1', runID: 'run-1', workbenchSessionID: 'workbench-session-1', inputStatus: 'current' },
    input: {
      task, taskSHA256: digest(task), teamID: 'team-contract', workflowID: 'workflow-review', workflowVersion: 3,
      materials: [], sourceMessages: [{ messageID: 'employee-message', eventSeq: 1, sha256: digest('员工原始要求') }], authorizedBusinessCapabilityIDs: [],
    },
    run: { status: 'succeeded' as const, finalResult: { id: 'deliverable-1', title: '交付检查意见', contentType: 'text/markdown', content: finalResult, sha256: digest(finalResult), disposition: 'needs_input', summary: finalResult, missingItems: ['验收期限'] }, actionOutcomes: [] },
  }
}
function continuationTextMaterial(id: string, name: string, content: string): EnterpriseWorkContinuationContext['input']['materials'][number] {
  const frozen = makeFrozenTextMaterial(name, Buffer.from(content, 'utf8'))
  return {
    id, materialId: frozen.materialId, name: frozen.name, mediaType: frozen.mediaType,
    bytes: frozen.bytes, sha256: frozen.sha256, content: frozen.extraction.content, extraction: frozen.extraction,
  }
}
function completedReadOnlyContext(): EnterpriseWorkContinuationContext {
  const context = workContinuationContext()
  context.run.finalResult = { ...context.run.finalResult!, disposition: 'complete', summary: '只读检查完成。', missingItems: [] }
  context.run.actionOutcomes = []
  context.input.materials = ['原件甲.md', '原件乙.md'].map((name, index) => continuationTextMaterial(`frozen-original-${index + 1}`, name, `本轮固定原件 ${index + 1}`))
  return context
}
async function prepareCompletedReadOnlySubmit(f: Awaited<ReturnType<typeof fixture>>, context: EnterpriseWorkContinuationContext, id: string) {
  await openWorkContinuation(f, context, id)
  await f.input('我明确授权沿用这两份已固定原件，并由本轮查看的业务动作提交。', `employee-${id}-submit`)
  const discovered = await f.discover()
  const actionKey = discovered.available_actions[0]?.action_key
  if (!actionKey) throw new Error('fixture did not return a current business action')
  const { recordKey } = await f.findRecord('TEST-100 设备交接验收合同')
  const read = await f.call('read_business_record', { record_key: recordKey })
  if (read.status !== 200) throw new Error('fixture did not read the current business record')
  return {
    ...discovered, goal: '使用两份固定原件完成当前员工明确授权的业务提交。', business_record_key: recordKey,
    business_actions: [actionKey], materials: [], reuse_material_names: context.input.materials.map((material) => material.name),
  }
}
function businessNotificationContext(notificationID: string, options: { recordId?: string; materialStatus?: 'available' | 'none' | 'unavailable'; content?: string } = {}): EnterpriseBusinessNotificationContext {
  const sourceBytes = Buffer.from('%PDF-current-contract')
  const content = options.content ?? '当前批准合同原件内容。'
  const sha256 = digest(sourceBytes)
  const material = {
    sourceKind: 'approval' as const, requestId: 'approval-current', fileId: 'approval-file-current',
    name: '当前批准合同.pdf', mediaType: 'application/pdf' as const, bytes: sourceBytes.length, sha256,
    extraction: {
      status: 'complete' as const, mediaType: 'text/plain; charset=utf-8' as const,
      bytes: Buffer.byteLength(content), sha256: digest(content), sourceSha256: sha256, content,
      extractor: 'pdfjs-dist' as const, coverage: { pdfPageCount: 1, pdfTextPageCount: 1 }, limitations: [],
    },
  }
  const candidate = {
    objectName: 'forge_sales_contract', objectLabel: '销售合同', recordId: options.recordId ?? 'contract-current',
    name: '设备验收合同', code: 'C-100', status: '内部复核通过', recordVersion: 'v2',
  }
  const snapshot: BusinessRecordSnapshot = {
    version: 1, capturedAt: '2026-09-30T01:00:00Z', objectLabel: '销售合同',
    record: [{ label: '合同名称', value: candidate.name }, { label: '状态', value: candidate.status }],
    relations: [], completeness: 'complete', pricingDetailCompleteness: 'unknown', completenessNotes: [],
  }
  return {
    kind: 'business', notificationID,
    source: { system: 'forge', objectName: candidate.objectName, recordId: candidate.recordId },
    materialStatus: options.materialStatus ?? 'available',
    materialReferences: options.materialStatus === 'none' || options.materialStatus === 'unavailable' ? [] : [{
      sourceKind: 'approval' as const, requestId: 'approval-current', fileId: 'approval-file-current',
      name: '当前批准合同.pdf', mediaType: 'application/pdf' as const, bytes: sourceBytes.length, sha256,
    }],
    record: {
      candidate,
      snapshot, presentation: presentBusinessRecord(snapshot, [{ name: 'name', label: '合同名称', type: 'text' }, { name: 'status', label: '状态', type: 'text' }]),
    },
    currentReadAt: '2026-09-30T01:00:00Z',
    materials: options.materialStatus === 'none' || options.materialStatus === 'unavailable' ? [] : [material],
  }
}
async function fixture(objectName = 'forge_sales_contract', configureStorage = true, harness: 'pi' | 'loom' = 'pi') {
  const cwd = await mkdtemp(join(tmpdir(), 'handoff-')); directories.push(cwd)
  const content = '# 合同\n客户：测试客户\n金额：12345 元\n交期：2026-10-01\n'
  const sourceContent = '# 原提交合同\n客户：测试客户\n'
  const materialPath = '材料/附件/合同.md'
  await mkdir(join(cwd, '材料', '附件'), { recursive: true })
  await writeFile(join(cwd, materialPath), content)
  const materialReference = { projectId: 'project-test', harness, workspacePath: cwd, name: '合同.md', path: materialPath, sha256: digest(content), bytes: Buffer.byteLength(content), mimeType: 'text/markdown' as const }
  const materials = [{ path: materialPath, sha256: digest(content) }]
  const approvalContext = (requestId: string, returnVersion: string, recordId: string): EnterpriseApprovalContext => ({
    requestId, status: 'returned', viewer: 'original_submitter', title: '测试合同', step: '销售修改',
    businessObject: { objectName, recordId, recordName: '测试合同' }, sourceMaterialVersion: digest(`source:${requestId}`),
    returnVersion, returnReason: '请补齐验收要求', fields: [{ label: '合同名称', value: '测试合同' }],
    files: [{ fileId: `source-file-${requestId}`, name: '原合同.md', mediaType: 'text/plain; charset=utf-8', bytes: Buffer.byteLength(sourceContent), sha256: digest(sourceContent), content: sourceContent, verified: true }],
  })
  const contexts = new Map([['approval-1', approvalContext('approval-1', 'revise-1', 'contract-1')], ['approval-2', approvalContext('approval-2', 'revise-2', 'contract-2')]])
  const approvalActions: unknown[] = []
  const revisionReceipts = new Map<string, Record<string, unknown>>()
  const businessCapabilityId = `forge:action:${objectName}.submit`
  const choice = { teamId: 'team-contract', teamName: '合同团队', teamObjective: '复核合同并完成交接', workflowId: 'workflow-review', workflowName: '合同复核', workflowDescription: '接合同全文，检查金额和交期，交付复核意见', businessCapabilityIds: [businessCapabilityId], version: 3 }
  const businessCandidate = { objectName, objectLabel: objectName === 'forge_quote' ? '销售报价' : '销售合同', recordId: 'contract-1', name: 'TEST-100 设备交接验收合同', code: 'SC-TEST-001', status: '草稿', owner: '销售人员', recordVersion: 'v7' }
  const businessSnapshot: BusinessRecordSnapshot = {
    version: 1, capturedAt: '2026-09-24T00:00:00.000Z', objectLabel: businessCandidate.objectLabel,
    record: [{ label: '合同名称', value: businessCandidate.name }, { label: '合同编号', value: businessCandidate.code }, { label: '审核状态', value: businessCandidate.status }, { label: '版本', value: businessCandidate.recordVersion }],
    relations: [], completeness: 'complete', pricingDetailCompleteness: 'unknown', completenessNotes: [],
  }
  let continuationSequence = 1
  const service = {
    accountKey: vi.fn(async () => 'employee-a'),
    getSession: vi.fn(async () => forgeSession()),
    getApprovalContext: vi.fn(async (requestId: string) => {
      const context = contexts.get(requestId)
      if (!context) throw new Error('这项审批已无法由当前员工处理，请刷新待办')
      return structuredClone(context)
    }),
    getApprovalActionHistory: vi.fn(async () => structuredClone(approvalActions)),
    runNativeMcpAction: vi.fn(async (_args: NativeMcpActionArguments, assertCurrent: () => Promise<void>): Promise<NativeMcpActionAttempt> => {
      await assertCurrent()
      return { status: 'unknown' as const, code: 'IN_DOUBT', message: 'Forge 原生动作结果待核对。' }
    }),
    getWorkContinuationContext: vi.fn(async (references: { workReference: string; runReference: string; sessionReference: string }) => {
      const context = workContinuationContext()
      context.source.inputRevisionID = references.workReference
      context.source.runID = references.runReference
      context.source.workbenchSessionID = references.sessionReference
      return context
    }),
    getBusinessNotificationContext: vi.fn(async (notificationID: string) => businessNotificationContext(notificationID, { recordId: businessCandidate.recordId })),
    getEmployeeBusinessContext: vi.fn(async (selection: EmployeeBusinessTarget): Promise<EmployeeBusinessContext> => {
      if ('objectName' in selection) throw new Error('record fixture requires an existing record')
      return {
      version: '1', contextId: '10000000-0000-4000-8000-000000000001', contextVersion: 'a'.repeat(64), recordVersion: 'v7', expiresAt: new Date(Date.now() + 60_000).toISOString(), readOnly: true,
      ...selection, actions: [{ action_ref: 1, capabilityId: 'forge:action:sales_contract.Sign', declarationVersion: 'b'.repeat(64), label: '登记签署', description: '员工登记', effect: 'write', executionMode: 'employee_only', parameters: [{ name: 'signed_on', label: '签署日期', type: 'date', required: true }] }],
    } }),
    executeEmployeeBusinessAction: vi.fn(async (request: EmployeeBusinessRequest) => ({ version: '1' as const, operationId: request.opKey, contextId: request.contextId, requestDigest: employeeBusinessRequestDigest(request), status: 'succeeded' as const, repeated: false, updatedAt: new Date().toISOString() })),
    getEmployeeBusinessOperation: vi.fn(async () => { throw new Error('404') }),
    getWorkNotificationSource: vi.fn(async (notificationID: string): Promise<EnterpriseWorkNotificationSource> => ({
      version: '1', notificationID, kind: 'revision_required',
      source: { system: 'weave' as const, workReference: 'input-1', runReference: 'run-1', sessionReference: 'workbench-session-1' },
    })),
    getTeamCatalog: vi.fn(async () => [{ id: choice.teamId, name: choice.teamName, objective: choice.teamObjective }, { id: 'leave', name: '休假团队', objective: '安排休假' }]),
    getTeamChoices: vi.fn(async () => [choice]),
    getBusinessCapabilities: vi.fn(async () => [{ id: businessCapabilityId, name: '提交合同', description: '把合同提交到业务流程', effect: 'write' as const, resourceType: objectName, requiresRecord: true, requiresEmployeeIntent: true, status: 'available' as const }]),
    getBusinessObjectDirectory: vi.fn(async () => ({ objects: [{ objectName, label: businessCandidate.objectLabel }], complete: true, totalCount: 1 })),
    findBusinessRecords: vi.fn(async (_objectName: string, _summary: string, offset = 0, limit = 20) => ({ records: [businessCandidate], offset, limit, hasMore: false, complete: true })),
    readBusinessRecord: vi.fn(async () => ({ candidate: businessCandidate, snapshot: structuredClone(businessSnapshot) })),
    stageWorkMaterials: vi.fn(async (items: FrozenMaterial[]) => items.map((raw, index) => {
      const item = normalizeFrozenMaterial(raw)
      return {
        type: 'forge-file' as const, ...(item.sourceKind ? { sourceKind: item.sourceKind } : {}),
        materialId: item.materialId, id: `file-${index + 1}`, name: item.name, mediaType: item.mediaType, bytes: item.bytes, sha256: item.sha256,
      }
    })),
    getRunContinuationReferences: vi.fn(async (runID: string) => ({ workReference: 'input-1', runReference: runID, sessionReference: 'workbench-session-1' })),
    renewWorkAuthorization: vi.fn(async (_intent: unknown, observer: { assertCurrent(): Promise<void> }) => { await observer.assertCurrent(); return { status: 'resumed' as const, authorizationRenewed: true, message: '已续授权并恢复原工作。' } }),
    submitWork: vi.fn(async (_choice: unknown, _goal: string, source?: {
      assertCurrent(): Promise<void>
      idempotencySeed?: string
      continuation?: { inputRevisionID: string; runID: string }
      resources?: Array<{ sourceKind?: string; requestId?: string; name: string; bytes: number; sha256: string }>
      authorizedBusinessCapabilityIds?: string[]
    }) => {
      await source?.assertCurrent()
      if (source?.continuation) {
        const sequence = ++continuationSequence
        return { workId: `work-${sequence}`, runId: `run-${sequence}`, inputRevisionId: `input-${sequence}`, taskId: `task-${sequence}`, workflowId: choice.workflowId, workflowVersion: 3, repeated: false }
      }
      return { workId: 'work', runId: 'run', taskId: 'task', workflowId: choice.workflowId, workflowVersion: 3, repeated: false }
    }),
    submitApprovalRevision: vi.fn(async (requestId: string, body: { idempotencyKey: string }, assertCurrent: () => Promise<void>) => {
      await assertCurrent()
      const receipt = { requestId, bindingId: '550e8400-e29b-41d4-a716-446655440000', newVersionDigest: digest('new-revision-v1'), state: 'resumed', repeated: true }
      revisionReceipts.set(body.idempotencyKey, receipt)
      return { status: 200, body: { data: receipt } }
    }),
    getApprovalRevisionReceipt: vi.fn(async (requestId: string, idempotencyKey: string, assertCurrent: () => Promise<void>) => {
      await assertCurrent()
      const receipt = revisionReceipts.get(idempotencyKey)
      return receipt?.requestId === requestId ? { status: 200, body: { data: receipt } } : { status: 404, body: {} }
    }),
  }
  let activeTranscript: TranscriptMessage[] = []
  let sessionPath = '/sessions/current.jsonl'
  let runtimeId = 'runtime'
  let sessionSequence = 0
  const transcripts = new Map<string, TranscriptMessage[]>([[sessionPath, activeTranscript]])
  const sessions = { read: vi.fn(async (filePath: unknown) => transcripts.get(String(filePath)) ?? []) }
  const storageDirectory = join(cwd, 'secure-intents')
  const bridge = new AgentEnterpriseBridge({
    service, sessions: { prime: sessions, pi: sessions, loom: sessions }, extensionPath: '/extensions/enterprise.ts',
    ...(configureStorage ? { storage: { directory: storageDirectory } } : {}),
  })
  await bridge.start(); bridges.push(bridge)
  let environment = bridge.environmentFor({ cwd, sessionPath, harness })
  bridge.bindSession(environment.GOOEYPI_ENTERPRISE_TOKEN, sessionPath, 'runtime')
  let turnKey = ''
  const callWithTurn = async (method: string, params: Record<string, unknown> = {}, requestTurnKey = turnKey) => {
    const response = await fetch(environment.GOOEYPI_ENTERPRISE_URL!, { method: 'POST', headers: { Authorization: `Bearer ${environment.GOOEYPI_ENTERPRISE_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params: { turn_key: requestTurnKey, ...params } }) })
    return { status: response.status, body: await response.json() as { ok: boolean; result: Record<string, unknown>; error?: string } }
  }
  const call = (method: string, params: Record<string, unknown> = {}) => callWithTurn(method, params)
  const input = async (text: string, id: string, employeeInput?: import('../../src/types/api').EmployeePromptInput) => {
    await bridge.employeeCommand(runtimeId, { type: 'prompt', message: text }, undefined, undefined, undefined, employeeInput)
    activeTranscript.push(user(id, text))
    const active = await call('activate', { prompt: text }); turnKey = active.body.result?.turn_key as string
    return turnKey
  }
  const startNewSession = (name: string) => {
    sessionSequence += 1
    sessionPath = `/sessions/${name}-${sessionSequence}.jsonl`
    activeTranscript = []
    transcripts.set(sessionPath, activeTranscript)
    runtimeId = `runtime-${name}-${sessionSequence}`
    environment = bridge.environmentFor({ cwd, harness })
    bridge.bindSession(environment.GOOEYPI_ENTERPRISE_TOKEN, sessionPath, runtimeId)
    turnKey = ''
    return { path: sessionPath, runtimeId }
  }
  const relogin = async (options: { accountKey?: string; sessionPath?: string } = {}) => {
    bridge.invalidateAccount()
    if (options.accountKey) service.accountKey.mockResolvedValue(options.accountKey)
    sessionPath = options.sessionPath ?? sessionPath
    activeTranscript = transcripts.get(sessionPath) ?? []
    transcripts.set(sessionPath, activeTranscript)
    environment = bridge.environmentFor({ cwd, sessionPath, harness })
    bridge.bindSession(environment.GOOEYPI_ENTERPRISE_TOKEN, sessionPath, 'runtime')
  }
  const openReturned = async (requestId = 'approval-1') => {
    const context = contexts.get(requestId)
    if (!context?.returnVersion) throw new Error('test fixture has no returned context')
    const binding = await bridge.pinReturnedApprovalContext(requestId)
    startNewSession(`returned-${requestId}`)
    const text = `打开退回审批 ${requestId}`
    await bridge.employeeCommand(runtimeId, { type: 'prompt', message: text }, binding.handle)
    activeTranscript.push(user(`opened-${requestId}`, text))
    const active = await call('activate', { prompt: text })
    turnKey = active.body.result?.turn_key as string
    return { context: binding.context, turnKey }
  }
  const openApprovalReview = async (requestId = 'approval-1') => {
    const binding = await bridge.pinApprovalReviewContext(requestId)
    startNewSession(`review-${requestId}`)
    const text = `请只读复核「${binding.context.title}」\n\n${APPROVAL_REVIEW_SESSION_MARKER}`
    await bridge.employeeCommand(runtimeId, { type: 'prompt', message: text }, undefined, undefined, binding.handle)
    activeTranscript.push(user(`reviewed-${requestId}`, text))
    const active = await call('activate', { prompt: text })
    turnKey = active.body.result?.turn_key as string
    return { context: binding.context, turnKey, path: sessionPath, runtimeId }
  }
  const openBusinessResult = async (notificationID = 'business-notice') => {
    const binding = await bridge.pinWorkContinuationContext({ id: notificationID, source: 'forge' as const })
    if (binding.context.kind !== 'business') throw new Error('test fixture did not return a business notification context')
    startNewSession(`business-${notificationID}`)
    const prompt = '请只读查看当前业务结果。'
    await bridge.employeeCommand(runtimeId, { type: 'prompt', message: prompt }, undefined, binding.handle)
    activeTranscript.push(user(`opened-${notificationID}`, prompt))
    const active = await call('activate', { prompt })
    turnKey = active.body.result?.turn_key as string
    return { context: binding.context, turnKey, path: sessionPath, runtimeId }
  }
  const discover = async () => {
    const search = await call('search', { work_summary: '复核合同' })
    const teams = search.body.result.teams as Array<{ team_key: string }>
    const describe = await call('describe', { team_key: teams[0].team_key })
    const capabilities = describe.body.result.capabilities as Array<{ handoff_key: string; business_actions: Array<{ action_key: string }> }>
    return { handoff_key: capabilities[0].handoff_key, business_actions: [], goal: '复核这版合同', materials, available_actions: capabilities[0].business_actions }
  }
  const findRecord = async (workSummary: string) => {
    const directory = await call('list_business_objects')
    const objectRef = (directory.body.result.objects as Array<{ object_ref: string }>)[0]?.object_ref
    if (!objectRef) throw new Error('fixture did not return a business object')
    const found = await call('find_business_record', { object_ref: objectRef, work_summary: workSummary })
    const recordKey = (found.body.result.records as Array<{ record_key: string }>)[0]?.record_key
    if (!recordKey) throw new Error('fixture did not return a business record')
    return { directory, objectRef, found, recordKey }
  }
  await input(appendWorkspaceMaterialContext('这版给他们看看', [materialReference]), 'employee-turn-1')
  return { call, callWithTurn, input, getTurnKey: () => turnKey, setTurnKey: (value: string) => { turnKey = value }, relogin, startNewSession, discover, findRecord, openReturned, openApprovalReview, openBusinessResult, service, bridge, get environment() { return environment }, get runtimeId() { return runtimeId }, get sessionPath() { return sessionPath }, get transcript() { return activeTranscript }, transcripts, materials, cwd, content, businessCapabilityId, contexts, storageDirectory, revisionReceipts, approvalActions, businessCandidate, businessSnapshot, sessions }
}

async function openWorkContinuation(f: Awaited<ReturnType<typeof fixture>>, context: EnterpriseWorkContinuationContext, id: string) {
  f.service.getWorkContinuationContext.mockImplementation(async (references) => {
    const current = structuredClone(context)
    current.source.inputRevisionID = references.workReference
    current.source.runID = references.runReference
    current.source.workbenchSessionID = references.sessionReference
    return current
  })
  const source = { workReference: 'input-1', runReference: 'run-1', sessionReference: 'workbench-session-1' }
  const binding = await f.bridge.pinWorkContinuationContext({ id, source: 'weave', ...source })
  const prompt = `继续原工作\n${binding.context.materials.map((item) => `《${item.name}》`).join('、')}`
  await f.bridge.employeeCommand(f.runtimeId, { type: 'prompt', message: prompt }, undefined, binding.handle)
  f.transcript.push(user(`opened-${id}`, prompt))
  const activated = await f.call('activate', { prompt })
  expect(activated.status, JSON.stringify(activated.body)).toBe(200)
  f.setTurnKey(activated.body.result.turn_key as string)
  return source
}
async function openNeedsInputContinuation(f: Awaited<ReturnType<typeof fixture>>, context: EnterpriseWorkContinuationContext, id: string) {
  return openWorkContinuation(f, context, id)
}
async function freezeOfficeOriginals(f: Awaited<ReturnType<typeof fixture>>, context: EnterpriseWorkContinuationContext) {
  const originals = await Promise.all([
    readFile(new URL('../fixtures/materials/合同样例.docx', import.meta.url)),
    readFile(new URL('../fixtures/materials/技术协议样例.pdf', import.meta.url)),
  ])
  const paths = ['材料/附件/合同样例.docx', '材料/附件/技术协议样例.pdf']
  for (let index = 0; index < paths.length; index++) await writeFile(join(f.cwd, paths[index]!), originals[index]!)
  const frozen = await freezeMaterials(f.cwd, paths.map((path, index) => ({ path, sha256: digest(originals[index]!) })))
  context.input.materials = frozen.map((material, index) => ({
    id: `forge-read-only-original-${index}`, materialId: material.materialId, sourceKind: 'owner',
    name: material.name, mediaType: material.mediaType, bytes: material.bytes, sha256: material.sha256,
    content: material.extraction.content, extraction: material.extraction,
  }))
  return frozen
}

describe('employee-bound material handoff', () => {
  it.each([{ newCount: 11, reuseCount: 0 }, { newCount: 1, reuseCount: 10 }, { newCount: 6, reuseCount: 5 }])('rejects $newCount new plus $reuseCount reused files before upload and registration', async ({ newCount, reuseCount }) => {
    const f = await fixture()
    const parent = completedReadOnlyContext()
    parent.input.materials = Array.from({ length: reuseCount }, (_, index) => continuationTextMaterial(`parent-${index}`, `原材料${index}.md`, `固定材料${index}`))
    if (reuseCount) await openWorkContinuation(f, parent, `notice-count-${newCount}-${reuseCount}`)
    const attachments = await Promise.all(Array.from({ length: newCount }, async (_, index) => {
      const path = `材料/附件/新材料${index}.md`, content = `员工新材料${index}`
      await writeFile(join(f.cwd, path), content)
      return { projectId: 'project-test', harness: 'pi' as const, workspacePath: f.cwd, name: `新材料${index}.md`, path, sha256: digest(content), bytes: Buffer.byteLength(content), mimeType: 'text/markdown' as const }
    }))
    await f.input(appendWorkspaceMaterialContext('交给原团队检查，明确允许复用所选原材料。', attachments), 'employee-count')
    const params = await f.discover()
    const rejected = await f.call('submit', { ...params, materials: attachments.map(({ path, sha256 }) => ({ path, sha256 })), reuse_material_names: parent.input.materials.map(({ name }) => name) })
    expect(rejected.status).toBe(409)
    expect(rejected.body.error).toContain('最多允许 10 份材料')
    expect(f.service.stageWorkMaterials).not.toHaveBeenCalled()
    expect(f.service.submitWork).not.toHaveBeenCalled()
  })

  it('rejects a legacy eleven-file frozen intent on recovery before any upload or registration', async () => {
    const f = await fixture(), params = await f.discover()
    f.service.stageWorkMaterials.mockRejectedValueOnce(new Error('upload interrupted'))
    const first = await f.call('submit', params)
    const recoveryKey = first.body.result.recovery_key as string
    const savedPath = join(f.storageDirectory, `${recoveryKey}.json`)
    const saved = JSON.parse(await readFile(savedPath, 'utf8')) as { value: { materials: FrozenMaterial[] } }
    saved.value.materials = Array.from({ length: 11 }, (_, index) => makeFrozenTextMaterial(`旧材料${index}.md`, Buffer.from(`旧材料${index}`)))
    await writeFile(savedPath, JSON.stringify(saved))
    f.service.stageWorkMaterials.mockClear()
    const restarted = new AgentEnterpriseBridge({ service: f.service, sessions: { prime: f.sessions, pi: f.sessions, loom: f.sessions }, extensionPath: '/extensions/enterprise.ts', storage: { directory: f.storageDirectory } })
    await restarted.start(); bridges.push(restarted)
    const environment = restarted.environmentFor({ cwd: f.cwd, sessionPath: f.sessionPath, harness: 'pi' })
    restarted.bindSession(environment.GOOEYPI_ENTERPRISE_TOKEN, f.sessionPath, 'restart-count')
    const prompt = f.transcript[0]!.parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
    await restarted.employeeCommand('restart-count', { type: 'prompt', message: prompt })
    f.transcript.push(user('employee-recovery-count', prompt))
    const call = async (method: string, request: Record<string, unknown>) => {
      const response = await fetch(environment.GOOEYPI_ENTERPRISE_URL!, { method: 'POST', headers: { Authorization: `Bearer ${environment.GOOEYPI_ENTERPRISE_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params: request }) })
      return await response.json() as { result: Record<string, unknown> }
    }
    const active = await call('activate', { prompt })
    const recovered = await call('recover', { turn_key: active.result.turn_key, recovery_key: recoveryKey })
    expect(recovered.result, JSON.stringify(recovered)).toMatchObject({ status: 'rejected', submitted: false })
    expect(recovered.result.message).toContain('最多允许 10 份材料')
    expect(f.service.stageWorkMaterials).not.toHaveBeenCalled()
    expect(f.service.submitWork).not.toHaveBeenCalled()
  })

  it('accepts exactly ten combined new and explicitly reused files', async () => {
    const f = await fixture(), parent = completedReadOnlyContext()
    parent.input.materials = Array.from({ length: 9 }, (_, index) => continuationTextMaterial(`parent-${index}`, `原材料${index}.md`, `固定材料${index}`))
    await openWorkContinuation(f, parent, 'notice-count-ten')
    const path = f.materials[0]!.path
    await f.input(appendWorkspaceMaterialContext('复用九份原材料，并交接本轮附件。', [{ projectId: 'project-test', harness: 'pi', workspacePath: f.cwd, name: '测试材料.md', path, sha256: digest(f.content), bytes: Buffer.byteLength(f.content), mimeType: 'text/markdown' }]), 'employee-count-ten')
    const accepted = await f.call('submit', { ...await f.discover(), reuse_material_names: parent.input.materials.map(({ name }) => name) })
    expect(accepted.body.result.status).toBe('accepted')
    expect(f.service.stageWorkMaterials.mock.calls[0]?.[0]).toHaveLength(1)
    expect(f.service.submitWork.mock.calls[0]?.[2]?.resources).toHaveLength(10)
  })

  it.each(['completed', 'needs_input', 'action_failed', 'action_unknown'] as const)('passes server business result %s to Pi independently of the model opinion', async (businessResult) => {
    const f = await fixture(), context = completedReadOnlyContext()
    context.run.businessResult = businessResult
    context.run.finalResult = { ...context.run.finalResult!, disposition: 'needs_input', summary: '模型仍建议补件', missingItems: ['日期'] }
    f.service.getWorkContinuationContext.mockResolvedValueOnce(context)
    const binding = await f.bridge.pinWorkContinuationContext({ id: `business-result-${businessResult}`, source: 'weave', workReference: 'input-1', runReference: 'run-1', sessionReference: 'workbench-session-1' })
    expect(binding.context).toMatchObject({ businessResult, finalResult: { disposition: 'needs_input' } })
    if (businessResult === 'action_failed' || businessResult === 'action_unknown') {
      context.input.materials = [continuationTextMaterial('frozen-failed-file', '原材料.md', '原材料')]
      await openWorkContinuation(f, context, `no-replay-${businessResult}`)
      await f.input('补交原材料再试一次。', 'employee-retry-failed')
      const refused = await f.call('submit', { ...await f.discover(), materials: [], reuse_material_names: ['原材料.md'] })
      expect(refused.status).toBe(409)
      expect(refused.body.error).toContain('不允许复用原材料')
      expect(f.service.stageWorkMaterials).not.toHaveBeenCalled()
      expect(f.service.submitWork).not.toHaveBeenCalled()
    }
  })

  it('reads and binds the exact Weave work context before opening a Pi continuation', async () => {
    const f = await fixture()
    const item = { id: 'notice-1', source: 'weave' as const, notificationType: 'weave.team_run.revision_required' }
    const binding = await f.bridge.pinWorkContinuationContext(item)
    expect(f.service.getWorkNotificationSource).toHaveBeenCalledWith('notice-1')
    expect(binding.context).toMatchObject({ task: '请按客户确认的技术协议继续检查交付范围。', runStatus: 'succeeded', finalResult: { title: '交付检查意见' } })
    f.service.getWorkNotificationSource.mockResolvedValueOnce({
      version: '1', notificationID: 'notice-wrong-kind', kind: 'failure',
      source: { system: 'weave', workReference: 'input-1', runReference: 'run-1', sessionReference: 'workbench-session-1' },
    })
    await expect(f.bridge.pinWorkContinuationContext({ ...item, id: 'notice-wrong-kind' })).rejects.toThrow('Forge 工作消息来源与当前通知不匹配')
    const prompt = `继续原工作\n${binding.context.task}`
    await f.bridge.employeeCommand(f.runtimeId, { type: 'prompt', message: prompt }, undefined, binding.handle)
    f.transcript.push(user('continued-work', prompt))
    await expect(f.call('activate', { prompt })).resolves.toMatchObject({ body: { result: { turn_key: expect.any(String) } } })
  })

  it('pins Forge business results to the current authorized record and keeps unavailable materials distinct', async () => {
    const f = await fixture()
    const binding = await f.bridge.pinWorkContinuationContext({ id: 'business-notice-1', source: 'forge' })
    expect(f.service.getBusinessNotificationContext).toHaveBeenCalledWith('business-notice-1')
    expect(binding.context).toMatchObject({
      kind: 'business', materialStatus: 'available',
      record: { name: '设备验收合同', status: '内部复核通过' },
      materials: [{ name: '当前批准合同.pdf', verified: true, extraction: { content: '当前批准合同原件内容。' } }],
    })
    expect(binding.context.kind === 'business' && binding.context.record.fields).toEqual(expect.arrayContaining([{ label: '合同名称', value: '设备验收合同' }]))
    expect(JSON.stringify(binding.context)).not.toContain('contract-current')
    expect(JSON.stringify(binding.context)).not.toContain('approval-file-current')

    f.service.getBusinessNotificationContext.mockResolvedValueOnce(businessNotificationContext('business-unavailable', { materialStatus: 'unavailable' }))
    const unavailable = await f.bridge.pinWorkContinuationContext({ id: 'business-unavailable', source: 'forge' })
    expect(unavailable.context).toMatchObject({ kind: 'business', materialStatus: 'unavailable', materials: [] })
  })

  it('projects a Forge result excerpt without exposing hidden relation data or weakening its full snapshot fence', async () => {
    const f = await fixture()
    const source = businessNotificationContext('business-hidden-fields')
    const hidden = 'a'.repeat(64), uuid = '10000000-0000-4000-8000-000000000001'
    source.record.snapshot.record.push({ label: '隐藏核价版本', value: 12 }, { label: '材料数据', value: JSON.stringify({ file_id: uuid }) })
    source.record.snapshot.relations.push({ label: '订单明细', direction: 'related', records: [[{ label: '物料名称', value: '设备 A' }, { label: '原件摘要', value: hidden }]], recordIds: [uuid], returnedCount: 1, limit: 12, complete: false })
    source.record.snapshot.completeness = 'partial'
    source.record.presentation = presentBusinessRecord(source.record.snapshot, [
      { name: 'name', label: '合同名称', type: 'text' }, { name: 'status', label: '状态', type: 'text' },
      { name: 'pricing_version', label: '隐藏核价版本', type: 'number', hidden: true }, { name: 'extra', label: '材料数据', type: 'text' },
    ], [{ label: '订单明细', direction: 'related', fields: [{ name: 'name', label: '物料名称', type: 'text' }, { name: 'sha256', label: '原件摘要', type: 'text' }] }])
    f.service.getBusinessNotificationContext.mockResolvedValueOnce(source)
    const binding = await f.bridge.pinWorkContinuationContext({ id: source.notificationID, source: 'forge' })
    expect(binding.context).toMatchObject({ kind: 'business', record: { completeness: 'partial', relations: [{ complete: false, records: [[{ label: '物料名称', value: '设备 A' }]] }], completenessNotes: expect.arrayContaining([expect.stringContaining('未能完整读取')]) } })
    for (const value of ['隐藏核价版本', '材料数据', '原件摘要', hidden, uuid]) expect(JSON.stringify(binding.context)).not.toContain(value)
    const changed = structuredClone(source)
    changed.record.snapshot.record[2].value = 13
    f.service.getBusinessNotificationContext.mockResolvedValueOnce(changed)
    const session = f.startNewSession('business-hidden-fence')
    await expect(f.bridge.employeeCommand(session.runtimeId, { type: 'prompt', message: '只读查看当前业务结果' }, undefined, binding.handle)).rejects.toThrow('Forge 当前记录或材料版本已变化')
    expect(f.service.executeEmployeeBusinessAction).not.toHaveBeenCalled()
  })

  it('opens a Forge business result as read-only, then lets a later employee message use normal tools', async () => {
    const f = await fixture()
    const opened = await f.openBusinessResult()
    expect(opened.context).toMatchObject({ kind: 'business', record: { name: '设备验收合同' } })
    for (const method of ['search', 'submit', 'revision_submit', 'recover', 'list_business_objects', 'find_business_record', 'read_business_record']) {
      const result = await f.call(method)
      expect(result.status, `${method} should be blocked on initial message open`).toBe(409)
      expect(result.body.error).toContain('只允许查看本次核验')
    }
    expect(f.service.submitWork).not.toHaveBeenCalled()
    expect(f.service.submitApprovalRevision).not.toHaveBeenCalled()

    await f.input('我有新的工作要求，请按当前权限重新查找相关记录。', 'business-new-employee-request')
    const search = await f.call('search', { work_summary: '设备验收合同' })
    expect(search.status).toBe(200)
    expect(search.body.result.teams).toEqual(expect.arrayContaining([expect.objectContaining({ name: '合同团队' })]))
    expect(f.service.submitWork).not.toHaveBeenCalled()
  })

  it('rejects a business result handle when the current record or account changes before it binds', async () => {
    const f = await fixture()
    const binding = await f.bridge.pinWorkContinuationContext({ id: 'business-stale-record', source: 'forge' })
    const session = f.startNewSession('business-stale-record')
    f.service.getBusinessNotificationContext.mockResolvedValueOnce(businessNotificationContext('business-stale-record', { recordId: 'contract-replaced' }))
    await expect(f.bridge.employeeCommand(session.runtimeId, { type: 'prompt', message: '查看当前业务结果' }, undefined, binding.handle))
      .rejects.toThrow('Forge 当前记录或材料版本已变化')

    const other = await fixture()
    const otherBinding = await other.bridge.pinWorkContinuationContext({ id: 'business-other-account', source: 'forge' })
    const otherSession = other.startNewSession('business-other-account')
    other.service.accountKey.mockResolvedValue('employee-b')
    await expect(other.bridge.employeeCommand(otherSession.runtimeId, { type: 'prompt', message: '查看当前业务结果' }, undefined, otherBinding.handle))
      .rejects.toThrow('当前账号已变化')
  })

  it('keeps the verified business notification source for a new employee-only action without handing it to a team', async () => {
    const f = await fixture()
    await f.openBusinessResult('business-employee-action')
    expect((await f.call('run_current_item_action', { action_ref: 1, values: { signed_on: '2026-10-03' } })).status).toBe(409)
    await f.input('请登记签署，签署日期2026-10-03。', 'employee-signature-request')
    const listed = await f.call('list_current_item_actions')
    expect(listed.status).toBe(200)
    expect(listed.body.result).toMatchObject({ actions: [{ action_ref: 1 }] })
    expect(f.service.getEmployeeBusinessContext).toHaveBeenCalledWith(expect.objectContaining({ source: { kind: 'business_notification', reference: 'business-employee-action' } }))
    expect((await f.call('run_current_item_action', { action_ref: 1, values: { signed_on: '2026-10-03' } })).body.result.status).toBe('succeeded')
    expect(f.service.executeEmployeeBusinessAction).toHaveBeenCalledOnce()
    expect(f.service.runNativeMcpAction).not.toHaveBeenCalled()
    expect(f.service.submitWork).not.toHaveBeenCalled()
  })

  it('pins a business work record into a fresh read-only session and refuses altered opening text', async () => {
    const f = await fixture()
    const binding = await f.bridge.pinEmployeeBusinessContext({ objectName: 'forge_sales_contract', recordId: 'contract-1', label: '合同' })
    const opened = f.startNewSession('business-work')
    await expect(f.bridge.employeeCommand(opened.runtimeId, { type: 'prompt', message: `${binding.prompt}\n替换要求` }, undefined, binding.handle)).rejects.toThrow('上下文已失效')
    expect(f.service.executeEmployeeBusinessAction).not.toHaveBeenCalled()
    const fresh = await f.bridge.pinEmployeeBusinessContext({ objectName: 'forge_sales_contract', recordId: 'contract-1', label: '合同' })
    const newSession = f.startNewSession('business-work-fresh')
    await f.bridge.employeeCommand(newSession.runtimeId, { type: 'prompt', message: fresh.prompt }, undefined, fresh.handle)
    f.transcript.push(user('opened-business-record', fresh.prompt))
    const activated = await f.call('activate', { prompt: fresh.prompt }); f.setTurnKey(activated.body.result.turn_key as string)
    expect((await f.call('run_current_item_action', { action_ref: 1, values: { signed_on: '2026-10-03' } })).status).toBe(409)
    await f.input('请登记签署，日期2026-10-03。', 'business-record-later-message')
    expect((await f.call('list_current_item_actions')).status).toBe(200)
    expect((await f.call('run_current_item_action', { action_ref: 1, values: { signed_on: '2026-10-03' } })).body.result.status).toBe('succeeded')
  })

  it('passes team missing-item opinions and a successful Forge action into the Pi continuation context', async () => {
    const f = await fixture()
    const context = workContinuationContext()
    context.run.finalResult = {
      ...context.run.finalResult!, disposition: 'needs_input', summary: '合同还缺验收日期。', missingItems: ['验收日期'],
    }
    context.run.actionOutcomes = [{
      nodeID: 'submit', callID: 'call-submit', actionName: 'contract_submit', objectName: 'sales_contract',
      status: 'succeeded', summary: 'Forge 已确认提交成功。',
    }]
    f.service.getWorkContinuationContext.mockResolvedValueOnce(context)
    const binding = await f.bridge.pinWorkContinuationContext({
      id: 'notice-needs-input', source: 'weave', workReference: 'input-1', runReference: 'run-1', sessionReference: 'workbench-session-1',
    })
    expect(binding.context.finalResult).toMatchObject({ disposition: 'needs_input', summary: '合同还缺验收日期。', missingItems: ['验收日期'] })
    expect(binding.context.actionOutcomes).toEqual([{
      actionName: 'contract_submit', objectName: 'sales_contract', status: 'succeeded', summary: 'Forge 已确认提交成功。',
    }])
  })

  it('passes trusted Weave action outcomes to Pi without exposing the bound record id', async () => {
    const f = await fixture()
    const context = workContinuationContext()
    context.run.actionOutcomes = [{
      nodeID: 'review', callID: 'call-1', actionName: 'contract_submit_frozen_material', objectName: 'sales_contract',
      recordID: 'contract-internal-1', status: 'succeeded', summary: '已由 Forge 确认合同材料提交成功。',
    }]
    f.service.getWorkContinuationContext.mockResolvedValueOnce(context)
    const binding = await f.bridge.pinWorkContinuationContext({ id: 'notice-action-outcome', source: 'weave', workReference: 'input-1', runReference: 'run-1', sessionReference: 'workbench-session-1' })
    expect(binding.context.actionOutcomes).toEqual([{
      actionName: 'contract_submit_frozen_material', objectName: 'sales_contract', status: 'succeeded', summary: '已由 Forge 确认合同材料提交成功。',
    }])
    expect(JSON.stringify(binding.context.actionOutcomes)).not.toContain('contract-internal-1')

    const missingContext = workContinuationContext()
    delete missingContext.run.actionOutcomes
    f.service.getWorkContinuationContext.mockResolvedValueOnce(missingContext)
    const missing = await f.bridge.pinWorkContinuationContext({ id: 'notice-no-action-outcomes', source: 'weave', workReference: 'input-1', runReference: 'run-1', sessionReference: 'workbench-session-1' })
    expect(missing.context).not.toHaveProperty('actionOutcomes')
  })

  it('keeps the parent work across two employee turns while refreshing the team and authorizing each new handoff', async () => {
    const f = await fixture()
    const item = { id: 'notice-two-rounds', source: 'weave' as const, workReference: 'input-1', runReference: 'run-1', sessionReference: 'workbench-session-1' }
    const binding = await f.bridge.pinWorkContinuationContext(item)
    expect(f.service.getWorkNotificationSource).not.toHaveBeenCalled()
    const openedPrompt = `继续原团队工作\n${binding.context.task}`
    await f.bridge.employeeCommand(f.runtimeId, { type: 'prompt', message: openedPrompt }, undefined, binding.handle)
    f.transcript.push(user('continued-work-open', openedPrompt))
    const opened = await f.call('activate', { prompt: openedPrompt })
    expect(opened.body.result.turn_key).toBeTypeOf('string')

    const revisedMaterial = '# 合同\n已补验收期限\n'
    await writeFile(join(f.cwd, '材料', '附件', '合同.md'), revisedMaterial)
    f.bridge.invalidateHandoff('runtime')
    const oldTurn = await f.callWithTurn('activate', { prompt: openedPrompt }, opened.body.result.turn_key as string)
    expect(oldTurn.status).toBe(409)
    const revisedReference = { projectId: 'project-test', harness: 'pi' as const, workspacePath: f.cwd, name: '合同.md', path: '材料/附件/合同.md', sha256: digest(revisedMaterial), bytes: Buffer.byteLength(revisedMaterial), mimeType: 'text/markdown' as const }
    await f.input(appendWorkspaceMaterialContext('我补上验收期限了，再让原团队按这版检查。', [revisedReference]), 'continued-work-round-2')
    const round2 = await f.discover()
    const second = await f.call('submit', {
      ...round2,
      goal: '按我这次补充的验收期限，继续核对原工作。',
      materials: [{ path: '材料/附件/合同.md', sha256: digest(revisedMaterial) }],
    })
    expect(second.status).toBe(200)
    expect(second.body.result.status).toBe('accepted')
    expect(f.service.submitWork.mock.calls[0]?.[2]).toMatchObject({ continuation: {
      workbenchSessionID: 'workbench-session-1', inputRevisionID: 'input-1', runID: 'run-1', teamID: 'team-contract',
    }, authorizedBusinessCapabilityIds: [] })

    f.bridge.invalidateHandoff('runtime')
    await f.input(appendWorkspaceMaterialContext('再补一处表述，请继续检查刚才那版。', [revisedReference]), 'continued-work-round-3')
    const round3 = await f.discover()
    const third = await f.call('submit', {
      ...round3,
      goal: '继续检查刚才那版补充后的合同。',
      materials: [{ path: '材料/附件/合同.md', sha256: digest(revisedMaterial) }],
    })
    expect(third.status).toBe(200)
    expect(third.body.result.status).toBe('accepted')
    expect(f.service.submitWork.mock.calls[1]?.[2]).toMatchObject({ continuation: {
      workbenchSessionID: 'workbench-session-1', inputRevisionID: 'input-2', runID: 'run-2', teamID: 'team-contract',
    }, authorizedBusinessCapabilityIds: [] })
    expect(f.service.getTeamCatalog).toHaveBeenCalledTimes(2)
    expect(f.service.getTeamChoices).toHaveBeenCalledTimes(4)
    expect(f.service.getBusinessCapabilities).toHaveBeenCalledTimes(2)
    expect(f.service.stageWorkMaterials).toHaveBeenCalledTimes(2)
    expect(f.service.stageWorkMaterials.mock.calls.map(([materials]) => materials[0]?.extraction.content)).toEqual([revisedMaterial, revisedMaterial])
  })

  it('marks a failed read-only continuation as a fresh input in the same work session', async () => {
    const f = await fixture()
    f.service.getWorkContinuationContext.mockImplementation(async (references) => {
      const context = workContinuationContext()
      context.source.inputRevisionID = references.workReference
      context.source.runID = references.runReference
      context.source.workbenchSessionID = references.sessionReference
      context.run.status = 'failed'
      context.run.finalResult = undefined
      return context
    })
    const binding = await f.bridge.pinWorkContinuationContext({ id: 'failed-work', source: 'weave', workReference: 'input-1', runReference: 'run-1', sessionReference: 'workbench-session-1' })
    const reference = { projectId: 'project-test', harness: 'pi' as const, workspacePath: f.cwd, name: '合同.md', path: '材料/附件/合同.md', sha256: digest(f.content), bytes: Buffer.byteLength(f.content), mimeType: 'text/markdown' as const }
    const openingPrompt = '查看上次失败的团队结果。'
    await f.bridge.employeeCommand(f.runtimeId, { type: 'prompt', message: openingPrompt }, undefined, binding.handle)
    f.transcript.push(user('failed-run-opening', openingPrompt))
    const activated = await f.call('activate', { prompt: openingPrompt })
    expect(activated.status, JSON.stringify(activated.body)).toBe(200)
    const turnKey = activated.body.result.turn_key as string
    const search = await f.callWithTurn('search', { work_summary: '复核合同' }, turnKey)
    const teamKey = (search.body.result.teams as Array<{ team_key: string }>)[0]!.team_key
    const described = await f.callWithTurn('describe', { team_key: teamKey }, turnKey)
    const handoffKey = (described.body.result.capabilities as Array<{ handoff_key: string }>)[0]!.handoff_key
    const openingSubmit = await f.callWithTurn('submit', { handoff_key: handoffKey, business_actions: [], goal: '只读检查这版合同', materials: f.materials }, turnKey)
    expect(openingSubmit.status).toBe(409)
    expect(openingSubmit.body.error).toContain('打开工作消息只授权查看')
    expect(f.service.submitWork).not.toHaveBeenCalled()

    await f.input(appendWorkspaceMaterialContext('这版合同重新交给原团队只读检查。', [reference]), 'failed-run-new-materials')
    const params = await f.discover()
    const result = await f.call('submit', params)
    expect(result.body.result.status).toBe('accepted')
    expect(f.service.submitWork.mock.calls[0]?.[2]).toMatchObject({ continuation: {
      workbenchSessionID: 'workbench-session-1', inputRevisionID: 'input-1', runID: 'run-1', restartAfterFailedRun: true,
    }, authorizedBusinessCapabilityIds: [] })
  })

  it('restarts the latest failed read-only work with its frozen Office originals without reuploading them', async () => {
    const f = await fixture()
    const originals = await Promise.all([
      readFile(new URL('../fixtures/materials/合同样例.docx', import.meta.url)),
      readFile(new URL('../fixtures/materials/技术协议样例.pdf', import.meta.url)),
    ])
    const paths = ['材料/附件/合同样例.docx', '材料/附件/技术协议样例.pdf']
    for (let index = 0; index < paths.length; index++) await writeFile(join(f.cwd, paths[index]!), originals[index]!)
    const frozen = await freezeMaterials(f.cwd, paths.map((path, index) => ({ path, sha256: digest(originals[index]!) })))
    const context = workContinuationContext()
    context.run.status = 'failed'
    context.run.finalResult = undefined
    context.input.materials = frozen.map((material, index) => ({
      id: `forge-original-${index}`, materialId: material.materialId, sourceKind: 'owner',
      name: material.name, mediaType: material.mediaType, bytes: material.bytes, sha256: material.sha256,
      content: material.extraction.content, extraction: material.extraction,
    }))
    f.service.getWorkContinuationContext.mockImplementation(async (references) => ({
      ...structuredClone(context),
      source: { ...context.source, inputRevisionID: references.workReference, runID: references.runReference, workbenchSessionID: references.sessionReference },
    }))
    await openNeedsInputContinuation(f, context, 'notice-failed-originals')
    await f.input('请沿用刚才失败运行中已冻结的这两份原件，重新交原团队只读检查；不要上传副本。', 'failed-originals-retry')
    const discovered = await f.discover()
    const result = await f.call('submit', {
      ...discovered, materials: [], reuse_material_names: frozen.map((material) => material.name), business_actions: [],
    })
    expect(result.body.result.status).toBe('accepted')
    // The Host, not the model, states what the team may do.
    expect(result.body.result.allowed_scope).toBe('本次只交给团队查看和分析，不允许业务写入；2 份材料')
    expect(result.body.result.scope_display).toMatchObject({ version: '1', source: 'workbench-host', reads: ['本次员工工作内容', '合同样例.docx', '技术协议样例.pdf'], writes: [] })
    expect(f.service.stageWorkMaterials).not.toHaveBeenCalled()
    expect(f.service.submitWork.mock.calls[0]?.[2]).toMatchObject({
      continuation: { inputRevisionID: context.source.inputRevisionID, runID: context.source.runID, restartAfterFailedRun: true },
      resources: context.input.materials.map(({ id, materialId, name, sha256 }) => ({ id, materialId, name, sha256 })),
    })
  })

  it('asks to reopen the original work when a historical chat has lost its trusted binding', async () => {
    const f = await fixture(), parent = workContinuationContext()
    parent.run.status = 'failed'
    parent.run.finalResult = undefined
    parent.input.materials = [continuationTextMaterial('original-file', '原材料.md', '已冻结的材料')]
    await openWorkContinuation(f, parent, 'failed-before-relogin')
    await f.relogin()
    await f.input('请复用原材料，重新交原团队只读检查。', 'reuse-after-relogin')
    const rejected = await f.call('submit', { ...await f.discover(), materials: [], business_actions: [], reuse_material_names: ['原材料.md'] })

    expect(rejected.status).toBe(409)
    expect(rejected.body.error).toContain('当前会话没有绑定原工作')
    expect(rejected.body.error).toContain('从“我的工作”重新打开原工作消息')
    expect(rejected.body.error).not.toContain('正常结束')
    expect(rejected.body.error).not.toContain('业务动作回执')
    expect(f.service.stageWorkMaterials).not.toHaveBeenCalled()
    expect(f.service.submitWork).not.toHaveBeenCalled()
  })

  it.each(['failed', 'needs_input', 'completed', 'completed-new-action', 'needs_input-new-action-attachments', 'completed-new-action-attachments', 'needs_input-prior-write-new-action', 'needs_input-prior-write-readonly'] as const)('creates a separate input and task grant after an eligible terminal %s source', async (outcome) => {
    const f = await fixture(), parent = completedReadOnlyContext()
    const newAttachmentsOnly = outcome.endsWith('-attachments')
    const newBusinessAction = outcome.includes('-new-action')
    const needsInput = outcome.startsWith('needs_input')
    const priorWriteScope = outcome.includes('prior-write')
    parent.source.inputStatus = 'current'
    parent.input.authorizedBusinessCapabilityIDs = priorWriteScope ? [f.businessCapabilityId] : []
    if (priorWriteScope) {
      parent.input.workflowVersion = 9
      const choices = await f.service.getTeamChoices()
      choices[0]!.version = 10
      await freezeOfficeOriginals(f, parent)
    }
    parent.input.registrationID = '550e8400-e29b-41d4-a716-446655440101'
    parent.run.authorization = { status: newAttachmentsOnly ? 'active' : 'renewal_required', canRenew: false, grantID: 'old-terminal-grant', generation: 1 }
    if (outcome === 'failed') {
      parent.run.status = 'failed'
      parent.run.finalResult = undefined
    } else {
      parent.run.businessResult = needsInput ? 'needs_input' : 'completed'
      parent.run.finalResult = { ...parent.run.finalResult!, disposition: needsInput ? 'needs_input' : 'complete', missingItems: needsInput ? ['补充说明'] : [] }
    }
    const freshReferences = newAttachmentsOnly ? ['修订正文.md', '配套说明.md'].map((name, index) => {
      const content = `本轮修订附件 ${index + 1}`
      return { projectId: 'project-test', harness: 'pi' as const, workspacePath: f.cwd, name, path: `材料/附件/${name}`, sha256: digest(content), bytes: Buffer.byteLength(content), mimeType: 'text/markdown' as const, content }
    }) : []
    const params = newAttachmentsOnly ? await (async () => {
      for (const reference of freshReferences) await writeFile(join(f.cwd, reference.path), reference.content)
      await openWorkContinuation(f, parent, `terminal-${outcome}`)
      await f.input(appendWorkspaceMaterialContext('明确用本轮两份新附件提交合同，不复用旧材料。', freshReferences), `employee-new-${outcome}`)
      const discovered = await f.discover(), { recordKey } = await f.findRecord('测试合同')
      await f.call('read_business_record', { record_key: recordKey })
      return { ...discovered, business_record_key: recordKey, business_actions: [discovered.available_actions[0]!.action_key], materials: freshReferences.map(({ path, sha256 }) => ({ path, sha256 })), reuse_material_names: [] }
    })() : newBusinessAction ? await prepareCompletedReadOnlySubmit(f, parent, `expired-${outcome}`)
      : await (async () => {
        await openWorkContinuation(f, parent, `expired-${outcome}`)
        await f.input('明确复用原材料，按新输入交原团队只读检查，不恢复旧运行。', `employee-new-${outcome}`)
        return { ...await f.discover(), materials: [], reuse_material_names: parent.input.materials.map(({ name }) => name) }
      })()
    const newInputID = '550e8400-e29b-41d4-a716-446655440202'
    const grants: Array<{ request_id: string; scope: ForgeTaskScope; expected_generation?: number }> = []
    const registrations: Array<Record<string, unknown>> = []
    const tokens: Array<string | undefined> = []
    f.service.submitWork.mockImplementation(async (choice, task, rawSource) => {
      const source = rawSource as FixedWorkSource
      const selected = choice as Parameters<typeof fixedWorkHandoff>[0]
      expect(selected.version).toBe(priorWriteScope ? 10 : 3)
      return fixedWorkHandoff(choice as Parameters<typeof fixedWorkHandoff>[0], task, source, {
        projectID: 'project-test', issuer: 'https://forge.example.test', identityIssuer: 'https://identity.example.test',
        nativeIdentity: async () => ({ id: 'employee-a', organizationID: 'organization-a' }),
        assertCurrent: source.assertCurrent,
        forge: async (path, body) => {
          expect(path).toBe('/api/v1/apps/forge/task-delegations')
          const grant = body as typeof grants[number]
          grants.push(grant)
          return { status: 200, body: {
            version: '1', token_type: 'forge_task', access_token: 'synthetic-new-task-token', grant_id: 'new-grant', generation: 1,
            issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            issuer: 'https://forge.example.test', identity_issuer: 'https://identity.example.test',
            subject: { id: 'employee-a', organization_id: 'organization-a' }, scope: grant.scope, scope_sha256: taskScopeSHA256(grant.scope),
          } }
        },
        weave: async (path, body, token) => {
          const request = body as Record<string, unknown>
          if (path === '/v1/workbench/dispatch-inputs/prepare') {
            expect(request.expected_revision_id).toBe(parent.source.inputRevisionID)
            expect(request.workbench_session_id).toBe(parent.source.workbenchSessionID)
            expect(request.registration_id).not.toBe(parent.input.registrationID)
            expect(request.workflow_version).toBe(selected.version)
            if (outcome === 'failed') expect(request).not.toHaveProperty('revision_context')
            else expect(request.revision_context).toEqual({ parent_input_revision_id: parent.source.inputRevisionID, parent_run_id: parent.source.runID })
            return { status: 200, body: { input_revision_id: newInputID } }
          }
          if (path === '/v1/workbench/dispatch-inputs') {
            registrations.push(request); tokens.push(token)
            return { status: 200, body: { input_revision_id: newInputID, client_request_id: 'new-client-request', task_sha256: digest(task) } }
          }
          expect(path).toBe('/v1/teams/team-contract/dispatch')
          expect(request.input_revision_id).toBe(newInputID)
          return { status: 201, body: { run_id: 'new-run', task_id: 'new-task', workflow_id: 'workflow-review', workflow_version: selected.version } }
        },
      })
    })

    const submitted = await f.call('submit', params)
    expect(submitted.body.result.status, JSON.stringify(submitted.body)).toBe('accepted')
    expect(f.service.renewWorkAuthorization).not.toHaveBeenCalled()
    if (newAttachmentsOnly) expect(f.service.stageWorkMaterials).toHaveBeenCalledOnce()
    else expect(f.service.stageWorkMaterials).not.toHaveBeenCalled()
    expect(grants).toHaveLength(1)
    expect(grants[0]!.request_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(grants[0]!.request_id).not.toBe(parent.input.registrationID)
    expect(grants[0]!).not.toHaveProperty('expected_generation')
    expect(grants[0]!.scope.input_revision_id).toBe(newInputID)
    expect(grants[0]!.scope.input_revision_id).not.toBe(parent.source.inputRevisionID)
    expect(grants[0]!.scope.allowed_actions).toEqual(newBusinessAction ? [f.businessCapabilityId] : [])
    expect(grants[0]!.scope.workflow_version).toBe(priorWriteScope ? 10 : 3)
    if (priorWriteScope) {
      expect(parent.input.workflowVersion).toBe(9)
      expect(parent.run.authorization).toMatchObject({ status: 'renewal_required', canRenew: false, grantID: 'old-terminal-grant' })
      expect(parent.run.actionOutcomes).toEqual([])
    }
    if (newAttachmentsOnly) {
      expect(grants[0]!.scope.resources.map(({ name, sha256, bytes }) => ({ name, sha256, bytes }))).toEqual(freshReferences.map(({ name, sha256, bytes }) => ({ name, sha256, bytes })))
      expect(grants[0]!.scope.resources.some(({ id }) => parent.input.materials.some((material) => material.id === id))).toBe(false)
    } else expect(grants[0]!.scope.resources).toHaveLength(parent.input.materials.length)
    expect(registrations).toHaveLength(1)
    expect(tokens).toEqual(['synthetic-new-task-token'])
    const saved = await Promise.all((await readdir(f.storageDirectory)).map((file) => readFile(join(f.storageDirectory, file), 'utf8')))
    expect(saved.join('')).toContain(grants[0]!.request_id)
    expect(saved.join('')).not.toContain('synthetic-new-task-token')
    expect(saved.join('')).not.toContain('old-terminal-grant')
  })

  it.each(['missing-outcomes', 'unknown-outcome', 'failed-no-effect', 'successful-outcome', 'failed-run', 'completed-run', 'cancelled', 'closed', 'superseded', 'missing-scope', 'missing-result'] as const)('does not relax prior write-scope protection for %s', async (reason) => {
    const f = await fixture(), parent = completedReadOnlyContext()
    parent.input.authorizedBusinessCapabilityIDs = [f.businessCapabilityId]
    parent.run.businessResult = 'needs_input'
    parent.run.finalResult = { ...parent.run.finalResult!, disposition: 'needs_input', missingItems: ['补充说明'] }
    parent.run.authorization = { status: 'renewal_required', canRenew: false }
    if (reason === 'missing-outcomes') delete parent.run.actionOutcomes
    else if (reason === 'unknown-outcome' || reason === 'failed-no-effect' || reason === 'successful-outcome') {
      const receipt = { nodeID: 'node', callID: 'call', actionName: '提交', objectName: 'contract', status: reason === 'unknown-outcome' ? 'unknown' as const : reason === 'successful-outcome' ? 'succeeded' as const : 'failed' as const, summary: '平台已有动作记录', noEffect: reason === 'failed-no-effect' }
      parent.run.actionOutcomes = [receipt]
    } else if (reason === 'failed-run' || reason === 'cancelled') { parent.run.status = reason === 'failed-run' ? 'failed' : 'cancelled'; delete parent.run.businessResult }
    else if (reason === 'completed-run') { parent.run.businessResult = 'completed'; parent.run.finalResult = { ...parent.run.finalResult!, disposition: 'complete', missingItems: [] } }
    else if (reason === 'closed' || reason === 'superseded') parent.source.inputStatus = reason
    else if (reason === 'missing-scope') delete parent.input.authorizedBusinessCapabilityIDs
    else if (reason === 'missing-result') delete parent.run.finalResult
    const params = await prepareCompletedReadOnlySubmit(f, parent, `prior-write-${reason}`)
    expect((await f.call('submit', params)).status).toBe(409)
    expect(f.service.submitWork).not.toHaveBeenCalled()
    expect(f.service.stageWorkMaterials).not.toHaveBeenCalled()
    expect(f.service.renewWorkAuthorization).not.toHaveBeenCalled()
  })

  it.each(['source', 'parent-result', 'latest-version'] as const)('rechecks %s before accepting a fresh needs-input continuation', async (changed) => {
    const f = await fixture(), parent = completedReadOnlyContext()
    parent.input.authorizedBusinessCapabilityIDs = [f.businessCapabilityId]
    parent.input.workflowVersion = 9
    parent.run.businessResult = 'needs_input'
    parent.run.finalResult = { ...parent.run.finalResult!, disposition: 'needs_input', missingItems: ['补充说明'] }
    parent.run.authorization = { status: 'renewal_required', canRenew: false }
    const choices = await f.service.getTeamChoices()
    choices[0]!.version = 10
    const params = await prepareCompletedReadOnlySubmit(f, parent, `needs-input-changed-${changed}`)
    if (changed === 'source') f.service.getWorkContinuationContext.mockResolvedValueOnce({ ...parent, source: { ...parent.source, runID: 'different-run' } })
    if (changed === 'parent-result') parent.run.actionOutcomes = [{ nodeID: 'node', callID: 'call', actionName: '提交', objectName: 'contract', status: 'unknown', summary: '新发现未确认动作' }]
    if (changed === 'latest-version') choices[0]!.version = 11
    const result = await f.call('submit', params)
    expect(result.status).toBe(409)
    expect(f.service.submitWork).not.toHaveBeenCalled()
    expect(f.service.stageWorkMaterials).not.toHaveBeenCalled()
    expect(f.service.renewWorkAuthorization).not.toHaveBeenCalled()
  })

  it.each(['parked', 'parked-active', 'running', 'cancelled', 'abandoned', 'closed', 'superseded', 'closed-no-authorization', 'superseded-no-authorization', 'missing-input-status', 'missing-scope', 'write-scope', 'missing-outcomes', 'unknown-action', 'successful-action', 'failed-new-action'] as const)('refuses a new input from an ineligible %s source', async (reason) => {
    const f = await fixture(), parent = completedReadOnlyContext()
    parent.source.inputStatus = 'current'
    parent.input.authorizedBusinessCapabilityIDs = []
    parent.run.authorization = { status: 'renewal_required', canRenew: false }
    if (reason === 'parked' || reason === 'parked-active') {
      parent.run.status = 'parked'
      parent.run.authorization = { status: reason === 'parked-active' ? 'active' : 'renewal_required', canRenew: true }
    } else if (reason === 'running' || reason === 'cancelled' || reason === 'abandoned') parent.run.status = reason
    else if (reason === 'closed' || reason === 'superseded') parent.source.inputStatus = reason
    else if (reason === 'closed-no-authorization' || reason === 'superseded-no-authorization') {
      parent.source.inputStatus = reason === 'closed-no-authorization' ? 'closed' : 'superseded'
      delete parent.run.authorization
    }
    else if (reason === 'missing-input-status') delete parent.source.inputStatus
    else if (reason === 'missing-scope') delete parent.input.authorizedBusinessCapabilityIDs
    else if (reason === 'write-scope') parent.input.authorizedBusinessCapabilityIDs = [f.businessCapabilityId]
    else if (reason === 'missing-outcomes') delete parent.run.actionOutcomes
    else if (reason === 'unknown-action' || reason === 'successful-action') parent.run.actionOutcomes = [{ nodeID: 'node', callID: 'call', actionName: 'submit', objectName: 'record', status: reason === 'unknown-action' ? 'unknown' : 'succeeded', summary: '平台动作回执' }]
    else if (reason === 'failed-new-action') { parent.run.status = 'failed'; parent.run.finalResult = undefined }
    await openWorkContinuation(f, parent, `ineligible-${reason}`)
    const newAttachmentsOnly = reason === 'closed-no-authorization' || reason === 'superseded-no-authorization'
    const prompt = newAttachmentsOnly ? appendWorkspaceMaterialContext('请按新消息交接这份新附件。', [{ projectId: 'project-test', harness: 'pi', workspacePath: f.cwd, name: '合同.md', path: '材料/附件/合同.md', sha256: digest(f.content), bytes: Buffer.byteLength(f.content), mimeType: 'text/markdown' }]) : '请按新消息交接原材料。'
    await f.input(prompt, `employee-ineligible-${reason}`)
    const discovered = await f.discover()
    const rejected = await f.call('submit', { ...discovered, materials: newAttachmentsOnly ? discovered.materials : [], reuse_material_names: newAttachmentsOnly ? [] : parent.input.materials.map(({ name }) => name), business_actions: reason === 'failed-new-action' ? [discovered.available_actions[0]!.action_key] : [] })
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(409)
    if (newAttachmentsOnly) expect(rejected.body.error).toContain('不能沿旧事项创建新输入')
    expect(f.service.renewWorkAuthorization).not.toHaveBeenCalled()
    expect(f.service.stageWorkMaterials).not.toHaveBeenCalled()
    expect(f.service.submitWork).not.toHaveBeenCalled()
  })

  it('refreshes authorization before deciding whether a newly expired source can create an input', async () => {
    const f = await fixture(), parent = completedReadOnlyContext()
    parent.run.status = 'parked'
    parent.run.authorization = { status: 'active', canRenew: false }
    await openWorkContinuation(f, parent, 'authorization-before-refresh')
    await f.input('请按新输入交接这项工作。', 'employee-before-auth-change')
    const params = await f.discover()
    parent.run.authorization = { status: 'renewal_required', canRenew: true }
    const rejected = await f.call('submit', params)
    expect(rejected.status).toBe(409)
    expect(rejected.body.error).toContain('不能用新交接或新输入替代')
    expect(f.service.stageWorkMaterials).not.toHaveBeenCalled()
    expect(f.service.submitWork).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'completed failure', runStatus: 'succeeded' as const, businessResult: 'action_failed' as const, actionStatus: 'failed' as const },
    { label: 'failed run with a recorded action', runStatus: 'failed' as const, businessResult: 'action_failed' as const, actionStatus: 'failed' as const },
    { label: 'unknown action result', runStatus: 'succeeded' as const, businessResult: 'action_unknown' as const, actionStatus: 'unknown' as const },
  ])('keeps terminal action outcomes read-only on open and blocks a new action request for $label', async ({ label, runStatus, businessResult, actionStatus }) => {
    const f = await fixture(), parent = completedReadOnlyContext()
    parent.run.status = runStatus
    if (runStatus === 'failed') parent.run.finalResult = undefined
    parent.run.businessResult = businessResult
    parent.run.actionOutcomes = [{ nodeID: 'convert', callID: 'call-1', actionName: 'convert_lead', objectName: 'sales_lead', status: actionStatus, summary: '平台记录的业务动作结果' }]
    parent.run.authorization = { status: 'renewal_required', canRenew: false }

    await openWorkContinuation(f, parent, `terminal-action-${label}`)
    const opening = await f.discover(), actionKey = opening.available_actions[0]!.action_key
    const openingSubmit = await f.call('submit', { ...opening, business_actions: [actionKey] })
    expect(openingSubmit.status).toBe(409)
    expect(openingSubmit.body.error).toContain('打开工作消息只授权查看')
    expect(f.service.submitWork).not.toHaveBeenCalled()
    expect(f.service.renewWorkAuthorization).not.toHaveBeenCalled()
    expect(f.service.runNativeMcpAction).not.toHaveBeenCalled()

    await f.input('本轮明确请求针对当前业务记录提出新的办理要求，不恢复旧团队运行。', `new-action-${label}`)
    const current = await f.discover(), currentActionKey = current.available_actions[0]!.action_key
    const rejected = await f.call('submit', { ...current, business_actions: [currentActionKey] })
    expect(rejected.status).toBe(409)
    expect(rejected.body.error).toContain('原工作已结束且有业务动作回执，需核对 Forge 回执；不能沿旧工作恢复或重放')
    expect(f.service.submitWork).not.toHaveBeenCalled()
    expect(f.service.stageWorkMaterials).not.toHaveBeenCalled()
    expect(f.service.renewWorkAuthorization).not.toHaveBeenCalled()
    expect(f.service.runNativeMcpAction).not.toHaveBeenCalled()
  })

  it.each(['unknown-outcome', 'failed-outcome', 'successful-outcome', 'business-unknown', 'business-failed', 'missing-outcomes', 'missing-scope', 'write-scope'] as const)('rejects active terminal %s sources even with new attachments and no reused files', async (reason) => {
    const f = await fixture(), parent = completedReadOnlyContext()
    parent.source.inputStatus = 'current'
    parent.input.authorizedBusinessCapabilityIDs = []
    parent.run.authorization = { status: 'active', canRenew: false }
    if (reason === 'missing-scope') delete parent.input.authorizedBusinessCapabilityIDs
    else if (reason === 'write-scope') parent.input.authorizedBusinessCapabilityIDs = [f.businessCapabilityId]
    else if (reason === 'missing-outcomes') delete parent.run.actionOutcomes
    else if (reason === 'business-unknown' || reason === 'business-failed') parent.run.businessResult = reason === 'business-unknown' ? 'action_unknown' : 'action_failed'
    else parent.run.actionOutcomes = [{ nodeID: 'node', callID: 'call', actionName: 'submit', objectName: 'record', status: reason === 'unknown-outcome' ? 'unknown' : reason === 'failed-outcome' ? 'failed' : 'succeeded', summary: '平台动作回执' }]
    await openWorkContinuation(f, parent, `active-terminal-${reason}`)
    const attachment = { projectId: 'project-test', harness: 'pi' as const, workspacePath: f.cwd, name: '合同.md', path: '材料/附件/合同.md', sha256: digest(f.content), bytes: Buffer.byteLength(f.content), mimeType: 'text/markdown' as const }
    await f.input(appendWorkspaceMaterialContext('用本轮新附件提交合同，不复用旧材料。', [attachment]), `employee-active-terminal-${reason}`)
    const discovered = await f.discover(), { recordKey } = await f.findRecord('测试合同')
    await f.call('read_business_record', { record_key: recordKey })
    const rejected = await f.call('submit', { ...discovered, business_record_key: recordKey, business_actions: [discovered.available_actions[0]!.action_key], reuse_material_names: [] })
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(409)
    expect(f.service.stageWorkMaterials).not.toHaveBeenCalled()
    expect(f.service.submitWork).not.toHaveBeenCalled()
    expect(f.service.renewWorkAuthorization).not.toHaveBeenCalled()
  })

  it('rechecks terminal source eligibility before fixing a new task grant intent', async () => {
    const f = await fixture(), parent = completedReadOnlyContext()
    parent.source.inputStatus = 'current'
    parent.input.authorizedBusinessCapabilityIDs = []
    parent.run.authorization = { status: 'renewal_required', canRenew: false }
    await openWorkContinuation(f, parent, 'before-new-grant')
    await f.input('明确复用原材料，按新输入只读检查。', 'employee-before-new-grant')
    f.service.submitWork.mockImplementation(async (_choice, _task, rawSource) => {
      const source = rawSource as FixedWorkSource
      parent.run.status = 'parked'
      parent.run.authorization = { status: 'active', canRenew: true }
      await source.fixDelegationIntent('550e8400-e29b-41d4-a716-446655440202', {} as ForgeTaskScope)
      throw new Error('new grant intent must not be created')
    })
    const rejected = await f.call('submit', { ...await f.discover(), materials: [], reuse_material_names: parent.input.materials.map(({ name }) => name) })
    expect(rejected.body.result.status).not.toBe('accepted')
    expect(rejected.body.result.message).toContain('不能用新交接或新输入替代')
    const saved = await Promise.all((await readdir(f.storageDirectory)).map((file) => readFile(join(f.storageDirectory, file), 'utf8')))
    expect(saved.join('')).not.toContain('requestID')
    expect(f.service.renewWorkAuthorization).not.toHaveBeenCalled()
  })

  it('refuses a different team when describing a linked continuation', async () => {
    const f = await fixture()
    const binding = await f.bridge.pinWorkContinuationContext({ id: 'notice-team-change', source: 'weave', workReference: 'input-1', runReference: 'run-1', sessionReference: 'workbench-session-1' })
    const prompt = '继续原合同工作'
    await f.bridge.employeeCommand(f.runtimeId, { type: 'prompt', message: prompt }, undefined, binding.handle)
    f.transcript.push(user('continued-work-team-check', prompt))
    const active = await f.call('activate', { prompt })
    const turnKey = active.body.result.turn_key as string
    const search = await f.callWithTurn('search', { work_summary: '安排休假' }, turnKey)
    const leave = (search.body.result.teams as Array<{ team_key: string; name: string }>).find((team) => team.name === '休假团队')
    expect(leave).toBeDefined()

    const result = await f.callWithTurn('describe', { team_key: leave!.team_key }, turnKey)
    expect(result.status).toBe(409)
    expect(result.body.error).toContain('原工作续办必须使用原团队')
    expect(f.service.getTeamChoices).not.toHaveBeenCalled()
  })

  it('rejects mismatched or changed Weave source references before Pi receives a continuation', async () => {
    const f = await fixture()
    const item = { id: 'notice-stale', source: 'weave' as const, workReference: 'input-1', runReference: 'run-1', sessionReference: 'workbench-session-1' }
    const mismatched = workContinuationContext()
    mismatched.source.runID = 'another-run'
    f.service.getWorkContinuationContext.mockResolvedValueOnce(mismatched)
    await expect(f.bridge.pinWorkContinuationContext(item)).rejects.toThrow('工作消息与原团队工作不匹配')

    const opened = workContinuationContext(), statusChanged = workContinuationContext()
    statusChanged.run.status = 'running'
    f.service.getWorkContinuationContext.mockResolvedValueOnce(opened).mockResolvedValueOnce(statusChanged)
    const binding = await f.bridge.pinWorkContinuationContext(item)
    await expect(f.bridge.employeeCommand(f.runtimeId, { type: 'prompt', message: '继续原工作' }, undefined, binding.handle)).resolves.toBeUndefined()

    const current = workContinuationContext(), changedResult = workContinuationContext()
    const newerResult = '团队重新核对后的不同结论。'
    changedResult.run.finalResult = { ...changedResult.run.finalResult!, content: newerResult, sha256: digest(newerResult) }
    f.service.getWorkContinuationContext.mockResolvedValueOnce(current).mockResolvedValueOnce(changedResult)
    const resultBinding = await f.bridge.pinWorkContinuationContext(item)
    await expect(f.bridge.employeeCommand(f.runtimeId, { type: 'prompt', message: '按新结果继续' }, undefined, resultBinding.handle)).rejects.toThrow('团队工作或固定材料版本已变化')
  })

  it('invalidates a continuation if Weave action facts change after they were pinned', async () => {
    const f = await fixture(), item = { id: 'notice-action-facts', source: 'weave' as const, workReference: 'input-1', runReference: 'run-1', sessionReference: 'workbench-session-1' }
    const pinned = workContinuationContext()
    pinned.run.actionOutcomes = [{ nodeID: 'review', callID: 'call-1', actionName: 'submit_contract', objectName: 'sales_contract', status: 'succeeded', summary: '提交成功。' }]
    const changed = workContinuationContext()
    changed.run.actionOutcomes = [{ nodeID: 'review', callID: 'call-1', actionName: 'submit_contract', objectName: 'sales_contract', status: 'unknown', summary: '结果未知。' }]
    f.service.getWorkContinuationContext.mockResolvedValueOnce(pinned).mockResolvedValueOnce(changed)
    const binding = await f.bridge.pinWorkContinuationContext(item)
    await expect(f.bridge.employeeCommand(f.runtimeId, { type: 'prompt', message: '继续核实原动作' }, undefined, binding.handle)).rejects.toThrow('团队工作或固定材料版本已变化')
  })

  it('fails closed when an original Forge file needs the restricted owner-only reader', async () => {
    const f = await fixture()
    const context = workContinuationContext()
    context.input.materials.push({ id: 'file-private', name: '合同.txt', bytes: 10, sha256: digest('合同内容') })
    f.service.getWorkContinuationContext.mockResolvedValueOnce(context)
    await expect(f.bridge.pinWorkContinuationContext({ id: 'notice-missing-bytes', source: 'weave', workReference: 'input-1', runReference: 'run-1', sessionReference: 'workbench-session-1' })).rejects.toThrow('没有取得经核验的原文')
  })

  it('passes only Forge-owner-verified original file text to the Pi context', async () => {
    const f = await fixture()
    const content = '原工作固定材料正文'
    const context = workContinuationContext()
    context.input.materials.push({ id: 'file-private', name: '合同.txt', bytes: Buffer.byteLength(content), sha256: digest(content), mediaType: 'text/plain; charset=utf-8', content })
    f.service.getWorkContinuationContext.mockResolvedValueOnce(context)
    const binding = await f.bridge.pinWorkContinuationContext({ id: 'notice-original-file', source: 'weave', workReference: 'input-1', runReference: 'run-1', sessionReference: 'workbench-session-1' })
    expect(binding.context.materials).toEqual([{ name: '合同.txt', bytes: Buffer.byteLength(content), sha256: digest(content), content }])
  })

  it('keeps a new Pi turn when the reported session file has not been created yet', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'handoff-future-session-')); directories.push(cwd)
    const transcript: TranscriptMessage[] = []
    const service = {
      ...currentItemActionServiceStubs(),
      accountKey: vi.fn(async () => 'employee-a'), getApprovalContext: vi.fn(), getWorkNotificationSource: vi.fn(), getBusinessNotificationContext: vi.fn(), getWorkContinuationContext: vi.fn(async () => workContinuationContext()),
      getTeamCatalog: vi.fn(async () => [{ id: 'team-lead', name: '线索分析团队', objective: '整理线索事实' }]),
      getTeamChoices: vi.fn(async () => []), getBusinessCapabilities: vi.fn(async () => []),
      getBusinessObjectDirectory: vi.fn(async () => ({ objects: [], complete: true, totalCount: 0 })),
      findBusinessRecords: vi.fn(async () => ({ records: [], offset: 0, limit: 20, hasMore: false, complete: true })),
      readBusinessRecord: vi.fn(async () => { throw new Error('not used in this fixture') }), stageWorkMaterials: vi.fn(async () => []), submitWork: vi.fn(),
      submitApprovalRevision: vi.fn(async () => ({ status: 404, body: {} })),
      getApprovalRevisionReceipt: vi.fn(async () => ({ status: 404, body: {} })),
    }
    const sessions = { read: vi.fn(async () => transcript) }
    sessions.read.mockRejectedValueOnce(Object.assign(new Error('session file not created'), { code: 'ENOENT' }))
    const bridge = new AgentEnterpriseBridge({ service, sessions: { prime: sessions, pi: sessions, loom: sessions }, extensionPath: '/extensions/enterprise.ts' })
    await bridge.start(); bridges.push(bridge)
    const environment = bridge.environmentFor({ cwd, harness: 'pi' })
    bridge.bindSession(environment.GOOEYPI_ENTERPRISE_TOKEN, '/sessions/future.jsonl', 'new-runtime')
    const prompt = '把这版线索交给团队只做分析'
    await bridge.employeeCommand('new-runtime', { type: 'prompt', message: prompt })
    transcript.push(user('new-message', prompt))
    const call = async (method: string, params: Record<string, unknown>) => {
      const response = await fetch(environment.GOOEYPI_ENTERPRISE_URL!, {
        method: 'POST', headers: { Authorization: `Bearer ${environment.GOOEYPI_ENTERPRISE_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, params }),
      })
      return { status: response.status, body: await response.json() as { result?: Record<string, unknown>; error?: string } }
    }
    const active = await call('activate', { prompt })
    expect(active.status).toBe(200)
    const search = await call('search', { turn_key: active.body.result?.turn_key, work_summary: '线索事实分析' })
    expect(search.status).toBe(200)
    expect(search.body.result?.teams).toEqual([{ team_key: expect.any(String), name: '线索分析团队', summary: '整理线索事实' }])
  })

  it('keeps the first Pi employee turn when the runtime token is bound before its session file', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'handoff-race-')); directories.push(cwd)
    const transcript: TranscriptMessage[] = []
    const service = {
      ...currentItemActionServiceStubs(),
      accountKey: vi.fn(async () => 'employee-a'), getApprovalContext: vi.fn(), getWorkNotificationSource: vi.fn(), getBusinessNotificationContext: vi.fn(), getWorkContinuationContext: vi.fn(async () => workContinuationContext()), getTeamCatalog: vi.fn(async () => [{ id: 'team-lead', name: '线索分析团队', objective: '整理线索并返回依据和待确认项' }]), getTeamChoices: vi.fn(async () => []),
      getBusinessCapabilities: vi.fn(async () => []),
      getBusinessObjectDirectory: vi.fn(async () => ({ objects: [], complete: true, totalCount: 0 })),
      findBusinessRecords: vi.fn(async () => ({ records: [], offset: 0, limit: 20, hasMore: false, complete: true })),
      readBusinessRecord: vi.fn(async () => { throw new Error('not used in this fixture') }),
      stageWorkMaterials: vi.fn(async () => []), submitWork: vi.fn(),
      submitApprovalRevision: vi.fn(async () => ({ status: 404, body: {} })), getApprovalRevisionReceipt: vi.fn(async () => ({ status: 404, body: {} })),
    }
    const sessions = { read: vi.fn(async () => transcript) }
    const bridge = new AgentEnterpriseBridge({ service, sessions: { prime: sessions, pi: sessions, loom: sessions }, extensionPath: '/extensions/enterprise.ts' })
    await bridge.start(); bridges.push(bridge)
    const environment = bridge.environmentFor({ cwd, harness: 'pi' })
    bridge.bindSession(environment.GOOEYPI_ENTERPRISE_TOKEN, undefined, 'new-runtime')
    const call = async (method: string, params: Record<string, unknown>) => {
      const response = await fetch(environment.GOOEYPI_ENTERPRISE_URL!, {
        method: 'POST', headers: { Authorization: `Bearer ${environment.GOOEYPI_ENTERPRISE_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, params }),
      })
      return { status: response.status, body: await response.json() as { result?: Record<string, unknown>; error?: string } }
    }
    const firstPrompt = '读取材料/北辰线索沟通纪要.md，先整理再查找可承接团队'

    // The desktop forwards the first prompt before Pi has reported its new
    // session file. The runtime token exists, but is still in the pending map.
    await bridge.employeeCommand('new-runtime', { type: 'prompt', message: firstPrompt })
    const firstActivation = await call('activate', { prompt: firstPrompt })
    expect(firstActivation.status).toBe(200)
    const firstTurnKey = firstActivation.body.result?.turn_key as string
    expect(firstTurnKey).toBeTruthy()
    transcript.push(user('first-turn', firstPrompt))
    transcript.push({ id: 'assistant-read-material', role: 'assistant', parts: [{ type: 'text', text: '已读取北辰线索沟通纪要.md。' }] })
    const firstSearchPromise = call('search', { turn_key: firstTurnKey, work_summary: '整理北辰设备线索的需求和待确认事项' })
    const bindingWaiters = (bridge as unknown as { sessionBindingWaiters: Map<string, Set<() => void>> }).sessionBindingWaiters
    await vi.waitFor(() => expect(bindingWaiters.size).toBe(1))
    bridge.bindRuntimeSession('new-runtime', '/sessions/new.jsonl')
    const firstSearch = await firstSearchPromise
    expect(firstSearch.status).toBe(200)
    expect(firstSearch.body.result?.teams).toEqual([{ team_key: expect.any(String), name: '线索分析团队', summary: '整理线索并返回依据和待确认项' }])

    const followUp = '按刚才的纪要继续找线索分析团队'
    // The renderer revokes the previous turn before queuing a changed employee
    // request; the following IPC command must establish a fresh turn on the
    // already-bound runtime.
    bridge.invalidateHandoff('new-runtime')
    await bridge.employeeCommand('new-runtime', { type: 'follow_up', message: followUp })
    transcript.push(user('follow-up-turn', followUp))
    const followUpActivation = await call('activate', { prompt: followUp })
    expect(followUpActivation.status).toBe(200)
    const followUpTurnKey = followUpActivation.body.result?.turn_key as string
    expect(followUpTurnKey).toBeTruthy()
    expect(followUpTurnKey).not.toBe(firstTurnKey)

    const staleTurn = await call('search', { turn_key: firstTurnKey, work_summary: '旧轮次的请求' })
    expect(staleTurn.status).toBe(409)
    expect(staleTurn.body.error).toContain('员工要求已变化')

    const followUpSearch = await call('search', { turn_key: followUpTurnKey, work_summary: '继续整理北辰线索' })
    expect(followUpSearch.status).toBe(200)
    service.accountKey.mockResolvedValue('employee-b')
    const changedAccount = await call('search', { turn_key: followUpTurnKey, work_summary: '切换账号后的旧轮次' })
    expect(changedAccount.status).toBe(409)
    expect(changedAccount.body.error).toContain('员工轮次或账号已变化')
  })

  it('clears a first-prompt authorization when its pending runtime handoff is invalidated', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'handoff-pending-invalidate-')); directories.push(cwd)
    const transcript: TranscriptMessage[] = []
    const service = {
      ...currentItemActionServiceStubs(),
      accountKey: vi.fn(async () => 'employee-a'), getApprovalContext: vi.fn(), getWorkNotificationSource: vi.fn(), getBusinessNotificationContext: vi.fn(), getWorkContinuationContext: vi.fn(async () => workContinuationContext()), getTeamCatalog: vi.fn(async () => []), getTeamChoices: vi.fn(async () => []),
      getBusinessCapabilities: vi.fn(async () => []), getBusinessObjectDirectory: vi.fn(async () => ({ objects: [], complete: true, totalCount: 0 })),
      findBusinessRecords: vi.fn(async () => ({ records: [], offset: 0, limit: 20, hasMore: false, complete: true })), readBusinessRecord: vi.fn(async () => { throw new Error('not used in this fixture') }),
      stageWorkMaterials: vi.fn(async () => []), submitWork: vi.fn(),
      submitApprovalRevision: vi.fn(async () => ({ status: 404, body: {} })), getApprovalRevisionReceipt: vi.fn(async () => ({ status: 404, body: {} })),
    }
    const sessions = { read: vi.fn(async () => transcript) }
    const bridge = new AgentEnterpriseBridge({ service, sessions: { prime: sessions, pi: sessions, loom: sessions }, extensionPath: '/extensions/enterprise.ts' })
    await bridge.start(); bridges.push(bridge)
    const environment = bridge.environmentFor({ cwd, harness: 'pi' })
    bridge.bindSession(environment.GOOEYPI_ENTERPRISE_TOKEN, undefined, 'pending-runtime')
    await bridge.employeeCommand('pending-runtime', { type: 'prompt', message: '读取北辰沟通纪要' })

    bridge.invalidateHandoff('pending-runtime')
    expect((bridge as unknown as { pendingRuntimeTokens: Map<string, string> }).pendingRuntimeTokens.has('pending-runtime')).toBe(false)
    await bridge.employeeCommand('pending-runtime', { type: 'prompt', message: '改成另一条线索' })
    transcript.push(user('changed-intent', '改成另一条线索'))
    bridge.bindRuntimeSession('pending-runtime', '/sessions/pending.jsonl')

    const response = await fetch(environment.GOOEYPI_ENTERPRISE_URL!, {
      method: 'POST', headers: { Authorization: `Bearer ${environment.GOOEYPI_ENTERPRISE_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'activate', params: { prompt: '改成另一条线索' } }),
    })
    expect(response.status).toBe(409)
    expect((await response.json() as { error?: string }).error).toContain('员工轮次或账号已变化')
  })

  it('does not treat an old same-text message in a restored session as a new authorization', async () => {
    const f = await fixture()
    const sameText = '这版给他们看看'
    await f.bridge.employeeCommand(f.runtimeId, { type: 'prompt', message: sameText })
    const activation = await f.call('activate', { prompt: sameText })
    expect(activation.status).toBe(200)
    const turnKey = activation.body.result?.turn_key as string

    const result = await f.callWithTurn('search', { work_summary: '复核合同' }, turnKey)
    expect(result.status).toBe(409)
    expect(result.body.error).toContain('当前员工输入尚未进入原会话')
    expect(f.service.submitWork).not.toHaveBeenCalled()
  })

  it('rejects a new-session first prompt if the transcript contains more than that one user message', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'handoff-new-session-ambiguous-')); directories.push(cwd)
    const transcript: TranscriptMessage[] = []
    const service = {
      ...currentItemActionServiceStubs(),
      accountKey: vi.fn(async () => 'employee-a'), getApprovalContext: vi.fn(), getWorkNotificationSource: vi.fn(), getBusinessNotificationContext: vi.fn(), getWorkContinuationContext: vi.fn(async () => workContinuationContext()), getTeamCatalog: vi.fn(async () => []), getTeamChoices: vi.fn(async () => []),
      getBusinessCapabilities: vi.fn(async () => []), getBusinessObjectDirectory: vi.fn(async () => ({ objects: [], complete: true, totalCount: 0 })),
      findBusinessRecords: vi.fn(async () => ({ records: [], offset: 0, limit: 20, hasMore: false, complete: true })), readBusinessRecord: vi.fn(async () => { throw new Error('not used in this fixture') }),
      stageWorkMaterials: vi.fn(async () => []), submitWork: vi.fn(),
      submitApprovalRevision: vi.fn(async () => ({ status: 404, body: {} })), getApprovalRevisionReceipt: vi.fn(async () => ({ status: 404, body: {} })),
    }
    const sessions = { read: vi.fn(async () => transcript) }
    const bridge = new AgentEnterpriseBridge({ service, sessions: { prime: sessions, pi: sessions, loom: sessions }, extensionPath: '/extensions/enterprise.ts' })
    await bridge.start(); bridges.push(bridge)
    const environment = bridge.environmentFor({ cwd, harness: 'pi' })
    bridge.bindSession(environment.GOOEYPI_ENTERPRISE_TOKEN, undefined, 'ambiguous-runtime')
    const prompt = '读取北辰沟通纪要'
    await bridge.employeeCommand('ambiguous-runtime', { type: 'prompt', message: prompt })
    const activateResponse = await fetch(environment.GOOEYPI_ENTERPRISE_URL!, {
      method: 'POST', headers: { Authorization: `Bearer ${environment.GOOEYPI_ENTERPRISE_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'activate', params: { prompt } }),
    })
    const activated = await activateResponse.json() as { result: { turn_key: string } }
    transcript.push(user('first-prompt', prompt), user('unexpected-follow-up', '改成别的材料'))
    bridge.bindRuntimeSession('ambiguous-runtime', '/sessions/ambiguous.jsonl')

    const response = await fetch(environment.GOOEYPI_ENTERPRISE_URL!, {
      method: 'POST', headers: { Authorization: `Bearer ${environment.GOOEYPI_ENTERPRISE_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'search', params: { turn_key: activated.result.turn_key, work_summary: '北辰线索' } }),
    })
    expect(response.status).toBe(409)
    expect((await response.json() as { error?: string }).error).toContain('无法核对新 Pi 会话中的员工消息顺序')
  })

  it('revokes a runtime claim when the reported session path differs from its scoped path', async () => {
    const f = await fixture()
    expect(() => f.bridge.bindSession(f.environment.GOOEYPI_ENTERPRISE_TOKEN, '/sessions/other.jsonl', 'runtime'))
      .toThrow('桌面会话文件与授权会话不匹配')
    expect((await f.call('activate', { prompt: '这版给他们看看' })).status).toBe(401)
  })

  it('filters summaries, expands only one team, and hands off actual frozen contract content', async () => {
    const f = await fixture()
    const search = await f.call('search', { work_summary: '检查合同' })
    expect(search.body.result.teams).toHaveLength(1)
    expect(f.service.getTeamChoices).not.toHaveBeenCalled()
    const params = await f.discover()
    const submitted = await f.call('submit', params)
    expect(submitted.status).toBe(200)
    expect(submitted.body.result.status).toBe('accepted')
    const task = JSON.parse(f.service.submitWork.mock.calls[0][1])
    expect(task.materials[0]).toMatchObject({
      materialId: expect.stringMatching(/^[0-9a-f]{24}$/), name: '合同.md', mediaType: 'text/markdown',
      bytes: Buffer.byteLength(f.content), sha256: digest(f.content),
      extraction: { status: 'complete', sourceSha256: digest(f.content), sha256: digest(f.content), content: f.content },
    })
    expect(JSON.stringify(task)).not.toContain(Buffer.from(f.content).toString('base64'))
    expect(f.service.submitWork.mock.calls[0][2]).toMatchObject({ authorizedBusinessCapabilityIds: [] })
  })
  it('freezes employee-selected PDF as owner and carries that source binding only in the Forge resource', async () => {
    const f = await fixture()
    const source = await readFile(new URL('../fixtures/materials/sample-two-page.pdf', import.meta.url))
    const path = '材料/附件/验收附件.pdf'
    await writeFile(join(f.cwd, path), source)
    const reference = {
      projectId: 'project-test', harness: 'pi' as const, workspacePath: f.cwd,
      name: '验收附件.pdf', path, sha256: digest(source), bytes: source.length, mimeType: 'application/pdf' as const,
    }
    const prompt = appendWorkspaceMaterialContext('请只读核对这份验收附件。', [reference])
    await f.input(prompt, 'employee-pdf-turn')
    const discovered = await f.discover()
    const submitted = await f.call('submit', { ...discovered, materials: [{ path, sha256: digest(source) }] })

    expect(submitted.status).toBe(200)
    expect(f.service.stageWorkMaterials.mock.calls[0]?.[0][0]).toMatchObject({ sourceKind: 'owner', name: '验收附件.pdf', bytes: source.length, sha256: digest(source) })
    const task = JSON.parse(f.service.submitWork.mock.calls[0]![1]) as { materials: Array<Record<string, unknown>> }
    expect(task.materials[0]).not.toHaveProperty('sourceKind')
    expect(task.materials[0]).not.toHaveProperty('bytesBase64')
    const resources = f.service.submitWork.mock.calls[0]![2]!.resources
    expect(resources![0]).toMatchObject({ sourceKind: 'owner', name: '验收附件.pdf', bytes: source.length, sha256: digest(source) })
    expect(resources![0]).not.toHaveProperty('requestId')
  })
  it('accepts more than eight small files under the existing byte and extraction budgets', async () => {
    const f = await fixture()
    const references = Array.from({ length: 9 }, (_, index) => {
      const path = `材料/附件/补充-${index + 1}.md`
      const content = `补充材料 ${index + 1}`
      return { path, content, sha256: digest(content) }
    })
    await Promise.all(references.map(({ path, content }) => writeFile(join(f.cwd, path), content)))
    const attachments = references.map(({ path, content, sha256 }) => ({
      projectId: 'project-test', harness: 'pi' as const, workspacePath: f.cwd,
      name: path.split('/').at(-1)!, path, sha256, bytes: Buffer.byteLength(content), mimeType: 'text/markdown' as const,
    }))
    await f.input(appendWorkspaceMaterialContext('请把这九份补充材料交给合同团队检查。', attachments), 'employee-nine-small-files')
    const discovered = await f.discover()
    const submitted = await f.call('submit', {
      ...discovered,
      materials: references.map(({ path, sha256 }) => ({ path, sha256 })),
    })

    expect(submitted.status).toBe(200)
    expect(submitted.body.result.status).toBe('accepted')
    expect(f.service.stageWorkMaterials.mock.calls[0]?.[0]).toHaveLength(9)
    const request = f.service.submitWork.mock.calls[0]
    expect(request?.[2]?.resources).toHaveLength(9)
    expect((JSON.parse(request![1]) as { materials: unknown[] }).materials).toHaveLength(9)
  })
  it('reuses one exact parent DOCX with a new PDF, stages only the new attachment, and recovers the same fixed input', async () => {
    const f = await fixture()
    const docxPath = '材料/附件/合同样例.docx'
    const docxSource = await readFile(new URL('../fixtures/materials/合同样例.docx', import.meta.url))
    await writeFile(join(f.cwd, docxPath), docxSource)
    const [docx] = await freezeMaterials(f.cwd, [{ path: docxPath, sha256: digest(docxSource) }])
    if (!docx) throw new Error('DOCX fixture did not freeze')
    const parentContext = workContinuationContext()
    parentContext.run.finalResult = {
      ...parentContext.run.finalResult!, disposition: 'needs_input',
      summary: '还缺一份补充材料。', missingItems: ['补充 PDF'],
    }
    parentContext.input.materials.push({
      id: 'forge-original-docx', materialId: docx.materialId, sourceKind: 'owner',
      name: docx.name, mediaType: docx.mediaType, bytes: docx.bytes, sha256: docx.sha256,
      content: docx.extraction.content, extraction: docx.extraction,
    })
    const source = await openNeedsInputContinuation(f, parentContext, 'notice-needs-input-docx')

    const pdfSource = await readFile(new URL('../fixtures/materials/sample-two-page.pdf', import.meta.url))
    const pdfPath = '材料/附件/补充材料.pdf'
    await writeFile(join(f.cwd, pdfPath), pdfSource)
    const pdfReference = {
      projectId: 'project-test', harness: 'pi' as const, workspacePath: f.cwd,
      name: '补充材料.pdf', path: pdfPath, sha256: digest(pdfSource), bytes: pdfSource.length, mimeType: 'application/pdf' as const,
    }
    const employeePrompt = appendWorkspaceMaterialContext(
      '请把补充 PDF 交给原合同团队，并明确复用这份已冻结的合同样例 DOCX。', [pdfReference],
    )
    await f.input(employeePrompt, 'employee-needs-input-pdf')
    const discovered = await f.discover()
    f.service.submitWork.mockRejectedValueOnce(new Error('dispatch response lost after server acceptance'))
    const submitted = await f.call('submit', {
      ...discovered,
      goal: '结合已冻结的合同样例和本轮补充 PDF 重新检查缺项。',
      materials: [{ path: pdfPath, sha256: digest(pdfSource) }],
      reuse_material_names: [docx.name],
    })
    expect(submitted.body.result.status).toBe('unknown')
    const recoveryKey = submitted.body.result.recovery_key as string
    const recovered = await f.call('recover', { recovery_key: recoveryKey })
    expect(recovered.body.result.status).toBe('accepted')

    expect(f.service.stageWorkMaterials).toHaveBeenCalledOnce()
    const staged = f.service.stageWorkMaterials.mock.calls[0]?.[0]
    expect(staged).toHaveLength(1)
    expect(staged?.[0]).toMatchObject({ name: '补充材料.pdf', sourceKind: 'owner', sha256: digest(pdfSource) })
    const [firstCall, retryCall] = f.service.submitWork.mock.calls
    expect(firstCall?.[2]?.idempotencySeed).toContain('employee-needs-input-pdf')
    expect(firstCall?.[2]?.idempotencySeed).toBe(retryCall?.[2]?.idempotencySeed)
    expect(firstCall?.[2]?.resources).toEqual(retryCall?.[2]?.resources)
    expect(firstCall?.[2]?.continuation).toEqual({
      workbenchSessionID: source.sessionReference, inputRevisionID: source.workReference,
      runID: source.runReference, teamID: 'team-contract',
    })
    expect(firstCall?.[2]?.resources).toMatchObject([
      { id: 'forge-original-docx', materialId: docx.materialId, name: docx.name, sourceKind: 'owner', sha256: docx.sha256 },
      { name: '补充材料.pdf', sourceKind: 'owner', sha256: digest(pdfSource) },
    ])
    const task = JSON.parse(firstCall![1]) as { materials: Array<Record<string, unknown>> }
    expect(task.materials.map(({ name }) => name)).toEqual([docx.name, '补充材料.pdf'])
    expect(task.materials[0]).toMatchObject({ sha256: docx.sha256, extraction: { sourceSha256: docx.sha256, content: docx.extraction.content } })
    expect(task.materials[1]).toMatchObject({ sha256: digest(pdfSource), extraction: { sourceSha256: digest(pdfSource) } })
    expect(JSON.stringify(firstCall?.[2]?.resources)).not.toContain(docx.bytesBase64)
    expect(recovered.body.result.materials).toEqual([{ name: docx.name }, { name: '补充材料.pdf' }])
  })
  it('reuses two exact materials from a completed read-only check after a new employee authorization', async () => {
    const f = await fixture()
    const parent = completedReadOnlyContext()
    await freezeOfficeOriginals(f, parent)
    const params = await prepareCompletedReadOnlySubmit(f, parent, 'completed-readonly-approve')
    const submitted = await f.call('submit', params)

    expect(submitted.status).toBe(200)
    expect(submitted.body.result.status).toBe('accepted')
    expect(f.service.stageWorkMaterials).not.toHaveBeenCalled()
    const [choice, taskText, delivery] = f.service.submitWork.mock.calls[0]!
    expect(choice).toMatchObject({ teamId: 'team-contract', workflowId: 'workflow-review', version: 3 })
    expect(delivery).toMatchObject({
      authorizedBusinessCapabilityIds: [f.businessCapabilityId],
      continuation: { workbenchSessionID: 'workbench-session-1', inputRevisionID: 'input-1', runID: 'run-1', teamID: 'team-contract' },
    })
    expect(delivery).toBeDefined()
    expect(delivery!.continuation).not.toHaveProperty('restartAfterFailedRun')
    expect(delivery!.resources).toEqual(parent.input.materials.map(({ id, materialId, name, mediaType, bytes, sha256 }) => ({
      type: 'forge-file', id, materialId, sourceKind: 'owner', name, mediaType, bytes, sha256,
    })))
    expect((JSON.parse(taskText) as { materials: Array<{ name: string }> }).materials.map(({ name }) => name))
      .toEqual(parent.input.materials.map(({ name }) => name))
  })

  it('refuses completed read-only material reuse when the action receipt is missing, nonempty, or unknown', async () => {
    const variants: Array<{ label: string; outcomes?: EnterpriseWorkContinuationContext['run']['actionOutcomes'] }> = [
      { label: 'missing' },
      { label: 'already-succeeded', outcomes: [{ nodeID: 'review', callID: 'call-1', actionName: 'submit', objectName: 'record', status: 'succeeded', summary: '已执行' }] },
      { label: 'unknown', outcomes: [{ nodeID: 'review', callID: 'call-1', actionName: 'submit', objectName: 'record', status: 'unknown', summary: '结果未知' }] },
    ]
    for (const variant of variants) {
      const f = await fixture()
      const parent = completedReadOnlyContext()
      if (variant.outcomes === undefined) delete parent.run.actionOutcomes
      else parent.run.actionOutcomes = variant.outcomes
      parent.input.materials = [continuationTextMaterial('frozen-parent-file', '检查原件.md', '已冻结的检查材料。')]
      await openWorkContinuation(f, parent, `completed-reuse-${variant.label}`)
      await f.input('我明确授权提交，但不要在动作回执缺失、已有动作或未知时复用旧材料。', `employee-${variant.label}`)
      const discovered = await f.discover()
      const rejected = await f.call('submit', {
        ...discovered, materials: [], reuse_material_names: ['检查原件.md'], business_actions: [],
      })

      expect(rejected.status, variant.label).toBe(409)
      expect(rejected.body.error, variant.label).toContain('不允许复用原材料')
      expect(rejected.body.error, variant.label).not.toContain('没有绑定原工作')
      expect(f.service.stageWorkMaterials, variant.label).not.toHaveBeenCalled()
      expect(f.service.submitWork, variant.label).not.toHaveBeenCalled()
    }
  })

  it('rejects a completed continuation when Weave says the expected parent head has advanced', async () => {
    const f = await fixture()
    const parent = completedReadOnlyContext()
    parent.input.materials = [continuationTextMaterial('frozen-parent-file', '检查原件.md', '已冻结的检查材料。')]
    const params = await prepareCompletedReadOnlySubmit(f, parent, 'completed-stale-head')
    f.service.submitWork.mockRejectedValueOnce(new WorkRegistrationRejectedError('parent revision advanced'))

    const rejected = await f.call('submit', params)

    expect(rejected.body.result, JSON.stringify(rejected.body)).toMatchObject({ status: 'rejected', submitted: false })
    expect(f.service.stageWorkMaterials).not.toHaveBeenCalled()
    expect(f.service.submitWork).toHaveBeenCalledOnce()
  })

  it('renews the same opened work only after a new explicit employee turn and persists intent without tokens', async () => {
    const f = await fixture(), context = completedReadOnlyContext()
    context.run.status = 'parked'
    context.run.authorization = { status: 'renewal_required', canRenew: true, generation: 1, retryNodeID: 'submit', scope: {
      input_revision_id: 'input-1', registration_id: '550e8400-e29b-41d4-a716-446655440901', task_sha256: context.input.taskSHA256,
      workflow_id: context.input.workflowID, workflow_version: context.input.workflowVersion, allowed_actions: [], resources: [],
    } }
    f.service.getWorkContinuationContext.mockResolvedValue(structuredClone(context))
    const binding = await f.bridge.pinWorkContinuationContext({ id: context.source.runID, source: 'weave', notificationType: 'weave.workbench_run' })
    const openPrompt = '只读打开原工作并核对授权状态。'
    await f.bridge.employeeCommand(f.runtimeId, { type: 'prompt', message: openPrompt }, undefined, binding.handle)
    f.transcript.push(user('opened-parked-original', openPrompt))
    const activated = await f.call('activate', { prompt: openPrompt }); f.setTurnKey(activated.body.result.turn_key as string)
    expect(f.service.getRunContinuationReferences).toHaveBeenCalledWith(context.source.runID)
    const opened = await f.call('authorization_renew', { employee_request: '打开原工作' })
    expect(opened.status).toBe(409)
    expect(f.service.renewWorkAuthorization).not.toHaveBeenCalled()
    const request = '继续原工作，材料和业务范围都保持原来这次授权。'
    const attached: import('../../src/types/api').WorkspaceMaterialReference = { projectId: 'project-test', harness: 'pi', workspacePath: f.cwd, name: '合同.md', path: '材料/附件/合同.md', sha256: digest(f.content), bytes: Buffer.byteLength(f.content), mimeType: 'text/markdown' }
    const runtimePrompt = appendWorkspaceMaterialContext(request, [attached])
    await f.input(runtimePrompt, 'employee-renew-original', { text: request, materials: [attached] })
    const replacement = await f.call('submit', await f.discover())
    expect(replacement.status).toBe(409)
    expect(replacement.body.error).toContain('不能用新交接或新输入替代')
    const wrong = await f.call('authorization_renew', { employee_request: '旧消息的要求' })
    expect(wrong.status).toBe(409)
    expect((await f.call('authorization_renew', { employee_request: runtimePrompt })).status).toBe(409)
    const waiting = deferred<{ status: 'resumed'; authorizationRenewed: boolean; message: string }>(), started = deferred<void>()
    f.service.renewWorkAuthorization.mockImplementationOnce(async (_intent, observer) => { await observer.assertCurrent(); started.resolve(); return waiting.promise })
    const dispatched = vi.spyOn(f.bridge as unknown as { dispatch(method: string, ...args: unknown[]): Promise<unknown> }, 'dispatch')
    const firstRenewal = f.call('authorization_renew', { employee_request: request }); await started.promise
    const duplicateRenewal = f.call('authorization_renew', { employee_request: request })
    await vi.waitFor(() => expect(dispatched.mock.calls.filter(([method]) => method === 'authorization_renew')).toHaveLength(2))
    waiting.resolve({ status: 'resumed', authorizationRenewed: true, message: '已续授权并恢复原工作。' })
    const renewed = await firstRenewal
    expect((await duplicateRenewal).body.result).toEqual(renewed.body.result)
    expect(f.service.renewWorkAuthorization).toHaveBeenCalledOnce()
    expect(renewed.body.result).toMatchObject({ status: 'resumed', authorizationRenewed: true })
    expect(f.service.stageWorkMaterials).not.toHaveBeenCalled()
    expect(f.service.submitWork).not.toHaveBeenCalled()
    expect(f.service.renewWorkAuthorization.mock.calls[0]?.[0]).toMatchObject({ source: context.source, expectedGeneration: 1, scope: context.run.authorization.scope })
    const saved = await Promise.all((await readdir(f.storageDirectory)).map((file) => readFile(join(f.storageDirectory, file), 'utf8')))
    expect(saved.join('')).toContain('retryRequestID')
    expect(saved.join('')).toContain('requestID')
    expect(saved.join('')).not.toContain('access_token')
  })

  it('preserves an old absent-business-result fingerprint and recovers the original frozen handoff', async () => {
    const f = await fixture(), parent = completedReadOnlyContext()
    parent.input.materials = [continuationTextMaterial('legacy-fixed-file', '旧版固定材料.md', '旧服务已核验的固定材料')]
    const params = await prepareCompletedReadOnlySubmit(f, parent, 'legacy-fingerprint-recovery')
    const bindings = (f.bridge as unknown as { workContinuations: Map<string, { context: EnterpriseWorkContinuationContext; fingerprint: string }> }).workContinuations
    const bound = bindings.get(f.environment.GOOEYPI_ENTERPRISE_TOKEN!)!
    expect(bound.context.run.businessResult).toBeUndefined()
    const legacyFingerprint = digest(JSON.stringify({ source: bound.context.source, input: bound.context.input, finalResult: bound.context.run.finalResult ?? null, actionOutcomes: bound.context.run.actionOutcomes ?? null }))
    expect(bound.fingerprint).toBe(legacyFingerprint)
    // Emulate a continuation pinned before the new result field existed.
    bound.fingerprint = legacyFingerprint
    f.service.submitWork.mockRejectedValueOnce(new Error('dispatch response lost'))
    const first = await f.call('submit', params)
    expect(first.body.result.status).toBe('unknown')
    const recoveryKey = first.body.result.recovery_key as string
    const persisted = JSON.parse(await readFile(join(f.storageDirectory, `${recoveryKey}.json`), 'utf8')) as { value: { task: string; reusedMaterials: Array<{ name: string }> } }
    expect(persisted.value.reusedMaterials).toMatchObject([{ name: '旧版固定材料.md' }])
    const recovered = await f.call('recover', { recovery_key: recoveryKey })
    expect(recovered.body.result.status, JSON.stringify(recovered.body)).toBe('accepted')
    expect(f.service.stageWorkMaterials).not.toHaveBeenCalled()
    const [original, retry] = f.service.submitWork.mock.calls
    expect(original?.[1]).toBe(persisted.value.task)
    expect(retry?.[1]).toBe(original?.[1])
    expect(retry?.[2]?.idempotencySeed).toBe(original?.[2]?.idempotencySeed)
    expect(retry?.[2]?.resources).toEqual(original?.[2]?.resources)
  })

  it('rejects old frozen continuation recovery when the server explicitly adds a business result', async () => {
    const f = await fixture(), parent = completedReadOnlyContext()
    parent.input.materials = [continuationTextMaterial('fixed-result-file', '固定材料.md', '本轮固定材料')]
    const params = await prepareCompletedReadOnlySubmit(f, parent, 'new-business-result-fingerprint')
    f.service.submitWork.mockRejectedValueOnce(new Error('dispatch response lost'))
    const first = await f.call('submit', params)
    expect(first.body.result.status).toBe('unknown')
    parent.run.businessResult = 'completed'
    const recovered = await f.call('recover', { recovery_key: first.body.result.recovery_key as string })
    expect(recovered.body.error).toContain('团队结果已变化')
    expect(f.service.submitWork).toHaveBeenCalledOnce()
    expect(f.service.stageWorkMaterials).not.toHaveBeenCalled()
  })

  it('recovers the same frozen completed-check handoff after an unknown receipt', async () => {
    const f = await fixture()
    const parent = completedReadOnlyContext()
    await freezeOfficeOriginals(f, parent)
    const params = await prepareCompletedReadOnlySubmit(f, parent, 'completed-readonly-recovery')
    f.service.submitWork.mockRejectedValueOnce(new Error('dispatch response lost after server acceptance'))

    const first = await f.call('submit', params)
    expect(first.body.result.status).toBe('unknown')
    const recovered = await f.call('recover', { recovery_key: first.body.result.recovery_key as string })

    expect(recovered.body.result.status).toBe('accepted')
    expect(f.service.stageWorkMaterials).not.toHaveBeenCalled()
    const [firstCall, retryCall] = f.service.submitWork.mock.calls
    expect(firstCall?.[2]?.idempotencySeed).toBe(retryCall?.[2]?.idempotencySeed)
    expect(firstCall?.[2]?.resources).toEqual(retryCall?.[2]?.resources)
    expect(firstCall?.[2]?.authorizedBusinessCapabilityIds).toEqual([f.businessCapabilityId])
  })

  it('rejects ambiguous, stale, and wrong-source reuse before staging any new attachment', async () => {
    const f = await fixture()
    const docxPath = '材料/附件/合同样例.docx'
    const docxSource = await readFile(new URL('../fixtures/materials/合同样例.docx', import.meta.url))
    await writeFile(join(f.cwd, docxPath), docxSource)
    const [docx] = await freezeMaterials(f.cwd, [{ path: docxPath, sha256: digest(docxSource) }])
    if (!docx) throw new Error('DOCX fixture did not freeze')
    const parentContext = workContinuationContext()
    parentContext.run.finalResult = { ...parentContext.run.finalResult!, disposition: 'needs_input', summary: '缺件', missingItems: ['PDF'] }
    parentContext.input.materials.push({
      id: 'forge-original-docx', materialId: docx.materialId, sourceKind: 'owner', name: docx.name,
      mediaType: docx.mediaType, bytes: docx.bytes, sha256: docx.sha256,
      content: docx.extraction.content, extraction: docx.extraction,
    })
    const duplicate = {
      ...parentContext.input.materials[0]!, id: 'another-forge-original-docx',
      sha256: digest('different original'), materialId: digest('different material').slice(0, 24),
    }
    parentContext.input.materials.push(duplicate)
    await openNeedsInputContinuation(f, parentContext, 'notice-needs-input-ambiguous')

    const pdfSource = await readFile(new URL('../fixtures/materials/sample-two-page.pdf', import.meta.url))
    const pdfPath = '材料/附件/补充材料.pdf'
    await writeFile(join(f.cwd, pdfPath), pdfSource)
    const reference = {
      projectId: 'project-test', harness: 'pi' as const, workspacePath: f.cwd,
      name: '补充材料.pdf', path: pdfPath, sha256: digest(pdfSource), bytes: pdfSource.length, mimeType: 'application/pdf' as const,
    }
    await f.input(appendWorkspaceMaterialContext('请补交 PDF。', [reference]), 'employee-needs-input-ambiguous')
    const discovered = await f.discover()
    const ambiguous = await f.call('submit', {
      ...discovered, materials: [{ path: pdfPath, sha256: digest(pdfSource) }], reuse_material_names: [docx.name],
    })
    expect(ambiguous.status).toBe(409)
    expect(ambiguous.body.error).toContain('多份同名材料')
    expect(f.service.stageWorkMaterials).not.toHaveBeenCalled()
    expect(f.service.submitWork).not.toHaveBeenCalled()

    const changedContext = structuredClone(parentContext)
    changedContext.input.materials[0]!.sha256 = digest('a changed frozen source')
    f.service.getWorkContinuationContext.mockImplementation(async (references) => {
      const context = structuredClone(changedContext)
      context.source.inputRevisionID = references.workReference
      context.source.runID = references.runReference
      context.source.workbenchSessionID = references.sessionReference
      return context
    })
    const stale = await f.call('submit', { ...discovered, materials: [{ path: pdfPath, sha256: digest(pdfSource) }] })
    expect(stale.status).toBe(409)
    expect(stale.body.error).toContain('已变化')
    expect(f.service.stageWorkMaterials).not.toHaveBeenCalled()
    expect(f.service.submitWork).not.toHaveBeenCalled()

    const g = await fixture()
    const wrongSourceContext = workContinuationContext()
    wrongSourceContext.run.finalResult = { ...wrongSourceContext.run.finalResult!, disposition: 'needs_input', summary: '缺件', missingItems: ['PDF'] }
    wrongSourceContext.input.materials.push({
      id: 'forge-approval-docx', materialId: docx.materialId, sourceKind: 'approval',
      name: docx.name, mediaType: docx.mediaType, bytes: docx.bytes, sha256: docx.sha256,
      content: docx.extraction.content, extraction: docx.extraction,
    })
    await openNeedsInputContinuation(g, wrongSourceContext, 'notice-needs-input-wrong-source')
    const wrongSourcePdfPath = '材料/附件/补充材料.pdf'
    const wrongSourceReference = { ...reference, path: wrongSourcePdfPath }
    await writeFile(join(g.cwd, wrongSourcePdfPath), pdfSource)
    await g.input(appendWorkspaceMaterialContext('请补交 PDF，并复用原合同文件。', [wrongSourceReference]), 'employee-needs-input-wrong-source')
    const wrongSourceParams = await g.discover()
    const wrongSource = await g.call('submit', {
      ...wrongSourceParams, materials: [{ path: wrongSourcePdfPath, sha256: digest(pdfSource) }], reuse_material_names: [docx.name],
    })
    expect(wrongSource.status).toBe(409)
    expect(wrongSource.body.error).toContain('受控来源')
    expect(g.service.stageWorkMaterials).not.toHaveBeenCalled()
    expect(g.service.submitWork).not.toHaveBeenCalled()
  })
  it('allows ten small materials across a needs_input continuation when byte budgets permit', async () => {
    const f = await fixture()
    const parentContext = workContinuationContext()
    parentContext.run.finalResult = { ...parentContext.run.finalResult!, disposition: 'needs_input', summary: '缺件', missingItems: ['补充材料'] }
    const names = Array.from({ length: 9 }, (_, index) => `冻结材料${index + 1}.txt`)
    for (const [index, name] of names.entries()) {
      const content = `原输入材料 ${index + 1}`
      const sha256 = digest(content)
      parentContext.input.materials.push({
        id: `forge-text-${index + 1}`,
        materialId: digest(JSON.stringify([name, 'text/plain', sha256])).slice(0, 24),
        name, mediaType: 'text/plain', bytes: Buffer.byteLength(content), sha256, content,
      })
    }
    await openNeedsInputContinuation(f, parentContext, 'notice-needs-input-eight-materials')
    const newMaterialPath = '材料/附件/第九份.md'
    const newMaterialContent = '第九份补充材料'
    const newMaterialHash = digest(newMaterialContent)
    await writeFile(join(f.cwd, newMaterialPath), newMaterialContent)
    const reference = {
      projectId: 'project-test', harness: 'pi' as const, workspacePath: f.cwd,
      name: '第九份.md', path: newMaterialPath, sha256: newMaterialHash, bytes: Buffer.byteLength(newMaterialContent), mimeType: 'text/markdown' as const,
    }
    await f.input(appendWorkspaceMaterialContext('补交这一份材料，并复用当前事项的九份冻结材料。', [reference]), 'employee-needs-input-nine-materials')
    const discovered = await f.discover()
    const submitted = await f.call('submit', {
      ...discovered,
      materials: [{ path: newMaterialPath, sha256: newMaterialHash }],
      reuse_material_names: names,
    })
    expect(submitted.status).toBe(200)
    expect(submitted.body.result.status).toBe('accepted')
    expect(f.service.stageWorkMaterials.mock.calls[0]?.[0]).toHaveLength(1)
    const request = f.service.submitWork.mock.calls[0]
    expect(request?.[2]?.resources).toHaveLength(10)
    expect((JSON.parse(request![1]) as { materials: unknown[] }).materials).toHaveLength(10)
  })
  it('authorizes only the business action selected for the current employee intent', async () => {
    const f = await fixture(), params = await f.discover()
    const actionKey = params.available_actions[0].action_key
    const { directory, found, recordKey } = await f.findRecord('TEST-100 设备交接验收合同')
    expect(directory.body.result).toMatchObject({ status: 'complete', directory_complete: true })
    expect(found.body.result).toMatchObject({ status: 'candidate', selection_required: true, has_more: false, complete: true })
    expect(found.body.result.records).toEqual([{ record_key: recordKey, name: 'TEST-100 设备交接验收合同', object: '销售合同', code: 'SC-TEST-001', status: '草稿', owner: '销售人员', record_version: 'v7' }])
    expect(JSON.stringify(found.body.result.records)).not.toContain('contract-1')
    const detail = await f.call('read_business_record', { record_key: recordKey })
    expect(detail.body.result).toMatchObject({
      status: 'read', record_key: recordKey, complete: true,
      snapshot: { record: expect.arrayContaining([expect.objectContaining({ label: '合同名称' })]), completeness: 'complete' },
    })
    expect((await f.call('submit', { ...params, business_record_key: recordKey, business_actions: [actionKey] })).status).toBe(200)
    expect(f.service.submitWork.mock.calls[0][2]).toMatchObject({
      authorizedBusinessCapabilityIds: [f.businessCapabilityId],
      businessContext: { objectName: 'forge_sales_contract', recordId: 'contract-1', recordVersion: 'v7' },
    })
    const task = JSON.parse(f.service.submitWork.mock.calls[0][1])
    expect(task.businessSnapshot).toEqual(f.businessSnapshot)
    expect(task).not.toHaveProperty('businessContext.recordId')
    expect(f.service.readBusinessRecord).toHaveBeenCalledOnce()
  })

  it('reads current Forge records without a team lookup and does not grant write capability', async () => {
    const f = await fixture()
    expect((await f.call('list_business_objects', { handoff_key: 'legacy-untrusted-key' })).status).toBe(200)
    const { directory, found, recordKey } = await f.findRecord('TEST-100 设备交接验收合同')
    expect(directory.body.result.objects).toHaveLength(1)
    expect(f.service.findBusinessRecords).toHaveBeenCalledWith('forge_sales_contract', 'TEST-100 设备交接验收合同', 0, 20)
    expect(found.body.result.status).toBe('candidate')
    expect(f.service.getTeamCatalog).not.toHaveBeenCalled()
    expect(f.service.getTeamChoices).not.toHaveBeenCalled()
    expect(f.service.getBusinessCapabilities).not.toHaveBeenCalled()

    const unauthorizedWrite = await f.call('submit', {
      handoff_key: 'not-discovered', goal: '提交当前业务记录', business_actions: [], materials: [], business_record_key: recordKey,
    })
    expect(unauthorizedWrite.status).toBe(409)
    expect(unauthorizedWrite.body.error).toContain('请先查看团队的承接能力')
    expect(f.service.submitWork).not.toHaveBeenCalled()

    f.service.findBusinessRecords.mockRejectedValueOnce(new ForgeBusinessReadError('forbidden', 'permission denied'))
    const denied = await f.call('find_business_record', {
      object_ref: (directory.body.result.objects as Array<{ object_ref: string }>)[0]!.object_ref,
      work_summary: 'TEST-100 设备交接验收合同',
    })
    expect(denied.body.result).toMatchObject({ status: 'forbidden', records: [] })
    expect(await f.service.accountKey()).toBe('employee-a')
  })

  it('rejects a business record from the wrong object for a team action', async () => {
    const f = await fixture()
    const quoteCandidate = { ...f.businessCandidate, objectName: 'forge_quote', objectLabel: '销售报价' }
    f.service.getBusinessObjectDirectory.mockResolvedValueOnce({
      objects: [{ objectName: 'forge_quote', label: '销售报价' }], complete: true, totalCount: 1,
    })
    f.service.findBusinessRecords.mockResolvedValueOnce({
      records: [quoteCandidate], offset: 0, limit: 20, hasMore: false, complete: true,
    })
    const { recordKey } = await f.findRecord('TEST-100 设备交接验收合同')
    const params = await f.discover()
    const rejected = await f.call('submit', {
      ...params, materials: [], business_actions: [params.available_actions[0]!.action_key], business_record_key: recordKey,
    })
    expect(rejected.status).toBe(409)
    expect(rejected.body.error).toContain('绑定该动作所需的业务记录')
    expect(f.service.submitWork).not.toHaveBeenCalled()
  })

  it('discards an object directory result that arrives after the employee changes turns', async () => {
    const f = await fixture()
    let release!: (value: { objects: Array<{ objectName: string; label: string }>; complete: boolean; totalCount: number }) => void
    f.service.getBusinessObjectDirectory.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const pending = f.call('list_business_objects')
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await f.input('改查另一份业务记录', 'employee-turn-after-directory')
    release({ objects: [{ objectName: 'forge_sales_contract', label: '销售合同' }], complete: true, totalCount: 1 })
    expect(await pending).toMatchObject({ status: 409, body: { error: expect.stringContaining('员工轮次') } })
  })

  it('discards a selected-record read that arrives after the employee changes turns', async () => {
    const f = await fixture()
    const { recordKey } = await f.findRecord('TEST-100 设备交接验收合同')
    let release!: (value: { candidate: typeof f.businessCandidate; snapshot: BusinessRecordSnapshot }) => void
    f.service.readBusinessRecord.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const pending = f.call('read_business_record', { record_key: recordKey })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await f.input('改成查另一份记录', 'employee-turn-after-record-read')
    release({ candidate: f.businessCandidate, snapshot: f.businessSnapshot })
    expect(await pending).toMatchObject({ status: 409, body: { error: expect.stringContaining('员工轮次') } })
    expect(f.service.submitWork).not.toHaveBeenCalled()
  })
  it('rejects a record key after the employee account changes', async () => {
    const f = await fixture()
    const { recordKey } = await f.findRecord('TEST-100 设备交接验收合同')
    await f.relogin({ accountKey: 'employee-b' })
    await f.input('请核对当前员工可见的业务记录。', 'employee-b-read')
    const result = await f.call('read_business_record', { record_key: recordKey })
    expect(result.status).toBe(409)
    expect(result.body.error).toMatch(/当前员工轮次|员工账号|业务记录选择已失效/)
    expect(f.service.readBusinessRecord).not.toHaveBeenCalled()
  })
  it('reads a bound record in a Weave result before team lookup and permits only a later authorized matching action', async () => {
    const f = await fixture()
    const context = workContinuationContext()
    context.input.businessRecord = { objectName: 'forge_sales_contract', recordID: 'contract-1', recordVersion: 'v7' }
    context.input.materials = [continuationTextMaterial('bound-original', '合同原件.md', '本轮固定合同材料')]
    await openWorkContinuation(f, context, 'notice-bound-record')
    f.service.getBusinessObjectDirectory.mockResolvedValueOnce({
      objects: [
        { objectName: 'forge_sales_contract', label: '销售合同' },
        { objectName: 'forge_quote', label: '销售报价' },
      ], complete: true, totalCount: 2,
    })
    const directory = await f.call('list_business_objects')
    expect(directory.body.result.objects).toEqual([{ object_ref: expect.any(String), name: '销售合同' }])
    const objectRef = (directory.body.result.objects as Array<{ object_ref: string }>)[0]!.object_ref
    const found = await f.call('find_business_record', { object_ref: objectRef, work_summary: '合同' })
    expect(found.body.result.records).toEqual([expect.objectContaining({ name: f.businessCandidate.name })])
    expect(f.service.readBusinessRecord).toHaveBeenCalledWith('forge_sales_contract', 'contract-1')
    expect(f.service.getTeamCatalog).not.toHaveBeenCalled()

    const staleRecordKey = (found.body.result.records as Array<{ record_key: string }>)[0]!.record_key
    await f.input('我明确授权当前团队用已声明的合同动作提交这条记录。', 'employee-authorized-followup')
    const params = await f.discover()
    const staleWrite = await f.call('submit', {
      ...params, materials: [], business_actions: [params.available_actions[0]!.action_key], business_record_key: staleRecordKey,
    })
    expect(staleWrite.status).toBe(409)
    expect(staleWrite.body.error).toMatch(/不属于当前员工轮次|业务记录选择已失效/)

    const current = await f.findRecord('合同')
    const submitted = await f.call('submit', {
      ...params, materials: [], business_actions: [params.available_actions[0]!.action_key], business_record_key: current.recordKey,
    })
    expect(submitted.status).toBe(200)
    expect(f.service.submitWork.mock.calls[0]?.[2]).toMatchObject({
      authorizedBusinessCapabilityIds: [f.businessCapabilityId],
      businessContext: { objectName: 'forge_sales_contract', recordId: 'contract-1', recordVersion: 'v7' },
    })
  })
  it('binds approval review sessions to one employee, request, business record, and current material round', async () => {
    const f = await fixture()
    const first = await f.openApprovalReview('approval-1')
    const second = await f.openApprovalReview('approval-2')
    expect(second.path).not.toBe(first.path)
    const saved = await Promise.all((await readdir(f.storageDirectory)).map(async (file) => {
      const record = JSON.parse(await readFile(join(f.storageDirectory, file), 'utf8')) as { value: Record<string, unknown> }
      return record.value
    }))
    expect(saved).toEqual(expect.arrayContaining([
      expect.objectContaining({ purpose: 'review', accountKey: 'employee-a', requestId: 'approval-1', objectName: 'forge_sales_contract', recordId: 'contract-1' }),
      expect.objectContaining({ purpose: 'review', accountKey: 'employee-a', requestId: 'approval-2', objectName: 'forge_sales_contract', recordId: 'contract-2' }),
    ]))
    expect(first.context.title).toBe('测试合同')
    expect(second.context.title).toBe('测试合同')
  })
  it('keeps review read-only after follow-up and rejects every enterprise action or other-record read', async () => {
    const f = await fixture()
    await f.openApprovalReview()
    await f.input('补充核对本次审批字段里的缺失信息。', 'review-follow-up')

    for (const method of ['submit', 'revision_submit', 'recover', 'search', 'list_business_objects', 'find_business_record', 'read_business_record']) {
      const result = await f.call(method)
      expect(result.status, `${method} should be rejected`).toBe(409)
      expect(result.body.error).toMatch(/只读|只能使用已固定的审批快照/)
    }
    expect(f.service.submitWork).not.toHaveBeenCalled()
    expect(f.service.submitApprovalRevision).not.toHaveBeenCalled()
    expect(f.service.getApprovalRevisionReceipt).not.toHaveBeenCalled()
    expect(f.service.getBusinessObjectDirectory).not.toHaveBeenCalled()
    expect(f.service.findBusinessRecords).not.toHaveBeenCalled()
    expect(f.service.readBusinessRecord).not.toHaveBeenCalled()
  })
  it('executes only a Forge-described current item action after a later employee turn', async () => {
    const f = await fixture('forge_custom_record')
    const original = f.contexts.get('approval-1')!
    const { returnVersion: _returnVersion, returnReason: _returnReason, ...pendingBase } = original
    const pending: EnterpriseApprovalContext = {
      ...pendingBase, status: 'pending', viewer: 'current_approver', sourceMaterialVersion: digest('pending-source-version'),
    }
    const action: EnterpriseApprovalAction = {
      semantic: 'server-description-only', label: 'Forge 返回的可办理事项', description: '按当前事项办理并附上员工意见。',
      execution: {
        tool: 'run_action', requiresConfirmation: false, actionName: 'server_defined_action_47', objectName: 'forge_custom_record', recordId: 'contract-1',
        params: { approvalRequestId: 'approval-1', itemVersion: 'native-item-round-47', sourceMaterialVersion: pending.sourceMaterialVersion },
      },
      inputs: [{ name: 'comment', type: 'string', label: '办理意见', required: true }],
    }
    pending.availableActions = [action]
    f.contexts.set('approval-1', pending)
    await f.openApprovalReview('approval-1')

    const openingDirectory = await f.call('list_current_item_actions')
    expect(openingDirectory.status).toBe(200)
    expect(openingDirectory.body.result.actions).toMatchObject([{ label: action.label, description: action.description }])
    expect(JSON.stringify(openingDirectory.body.result.actions)).not.toContain('server_defined_action_47')
    const openingAction = (openingDirectory.body.result.actions as Array<{ action_ref: string }>)[0]!
    await expect(f.call('run_current_item_action', { action_ref: openingAction.action_ref, comment: '先只读核对' }))
      .resolves.toMatchObject({ status: 409, body: { error: expect.stringContaining('只授权只读') } })

    const employeeComment = '按当前业务材料确认办理。'
    await f.input(`请办理当前事项，意见是：${employeeComment}`, 'employee-current-approval-opinion')
    const directory = await f.call('list_current_item_actions')
    const presented = directory.body.result.actions as Array<{ action_ref: string; label: string }>
    expect(presented).toHaveLength(1)
    const receipt = {
      decision: 'approve', status: 'pending', requestId: 'approval-1', recordId: 'contract-1',
      itemVersion: 'native-item-round-47', sourceMaterialVersion: pending.sourceMaterialVersion,
      resumed: false, autoRejected: false, alreadyApplied: false,
    }
    f.service.runNativeMcpAction.mockResolvedValueOnce({ status: 'returned', result: receipt })

    const result = await f.call('run_current_item_action', { action_ref: presented[0]!.action_ref, comment: employeeComment })
    expect(result).toMatchObject({ status: 200, body: { result: {
      outcome: 'returned', decision: 'approve', status: 'pending', resumed: false, autoRejected: false, alreadyApplied: false,
    } } })
    expect(JSON.stringify(result.body.result)).not.toContain('approval-1')
    expect(JSON.stringify(result.body.result)).not.toContain('contract-1')
    expect(JSON.stringify(result.body.result)).not.toContain('native-item-round-47')
    expect(f.service.runNativeMcpAction).toHaveBeenCalledOnce()
    expect(f.service.runNativeMcpAction.mock.calls[0]?.[0]).toEqual({
      actionName: 'server_defined_action_47', objectName: 'forge_custom_record', recordId: 'contract-1',
      params: { approvalRequestId: 'approval-1', itemVersion: 'native-item-round-47', sourceMaterialVersion: pending.sourceMaterialVersion, comment: employeeComment },
    })
    await expect(f.call('run_current_item_action', { action_ref: presented[0]!.action_ref, comment: '另一个不同意见' }))
      .resolves.toMatchObject({ status: 409, body: { error: expect.stringContaining('本轮员工意见已用于另一项办理请求') } })
    const token = f.environment.GOOEYPI_ENTERPRISE_TOKEN!
    const turns = (f.bridge as unknown as { turns: Map<string, { enterpriseReadOnly?: boolean }> }).turns
    expect(turns.get(token)?.enterpriseReadOnly).toBe(true)
    expect(f.service.submitWork).not.toHaveBeenCalled()
    expect(f.service.submitApprovalRevision).not.toHaveBeenCalled()
  })
  it('checks native approval history after an unknown action result and never retries the same turn blindly', async () => {
    const f = await fixture()
    const original = f.contexts.get('approval-1')!
    const { returnVersion: _returnVersion, returnReason: _returnReason, ...pendingBase } = original
    const pending: EnterpriseApprovalContext = { ...pendingBase, status: 'pending', viewer: 'current_approver' }
    pending.availableActions = [{
      semantic: 'uninterpreted', label: '当前可办事项', description: 'Forge 提供的当前动作说明。',
      execution: {
        tool: 'run_action', requiresConfirmation: false, actionName: 'descriptor_action_alpha', objectName: 'forge_sales_contract', recordId: 'contract-1',
        params: { approvalRequestId: 'approval-1', itemVersion: 'item-round-1', sourceMaterialVersion: pending.sourceMaterialVersion },
      },
      inputs: [{ name: 'comment', type: 'string', label: '办理意见', required: true }],
    }]
    f.contexts.set('approval-1', pending)
    await f.openApprovalReview()
    await f.input('请按当前事项办理，意见：同意进入下一步。', 'employee-approval-opinion-unknown')
    const directory = await f.call('list_current_item_actions')
    const actionRef = (directory.body.result.actions as Array<{ action_ref: string }>)[0]!.action_ref
    const comment = '同意进入下一步。'
    f.service.runNativeMcpAction.mockImplementationOnce(async (_args, assertCurrent) => {
      await assertCurrent()
      f.approvalActions.push({ id: 'native-action-1', request_id: 'approval-1', action: 'approve', actor_id: 'employee-a', comment, created_at: '2026-09-30T08:00:00Z' })
      return { status: 'unknown', code: 'APPROVAL_ACTION_IN_DOUBT', message: 'MCP回执丢失' }
    })

    const first = await f.call('run_current_item_action', { action_ref: actionRef, comment })
    expect(first).toMatchObject({ status: 200, body: { result: { outcome: 'unknown', nativeStatus: 'history_observed', decision: 'unknown', nativeAction: 'approve', currentItemStatus: 'pending' } } })
    const repeated = await f.call('run_current_item_action', { action_ref: actionRef, comment })
    expect(repeated.body.result).toMatchObject({ outcome: 'unknown', nativeStatus: 'history_observed', decision: 'unknown' })
    expect(f.service.runNativeMcpAction).toHaveBeenCalledOnce()
    expect(f.service.getApprovalActionHistory).toHaveBeenCalled()
  })
  it('returns unknown after reading unchanged native context and history without repeating the action', async () => {
    const f = await fixture()
    const original = f.contexts.get('approval-1')!
    const { returnVersion: _returnVersion, returnReason: _returnReason, ...pendingBase } = original
    const pending: EnterpriseApprovalContext = { ...pendingBase, status: 'pending', viewer: 'current_approver' }
    pending.availableActions = [{
      label: 'Forge当前动作', description: '目录提供的动作说明。',
      execution: {
        tool: 'run_action', requiresConfirmation: false, actionName: 'descriptor_action_beta', objectName: 'forge_sales_contract', recordId: 'contract-1',
        params: { approvalRequestId: 'approval-1', itemVersion: 'item-round-2', sourceMaterialVersion: pending.sourceMaterialVersion },
      },
      inputs: [{ name: 'comment', type: 'string', label: '办理意见', required: true }],
    }]
    f.contexts.set('approval-1', pending)
    await f.openApprovalReview()
    await f.input('按当前事项办理，意见：已核对。', 'employee-approval-opinion-unresolved')
    const directory = await f.call('list_current_item_actions')
    const actionRef = (directory.body.result.actions as Array<{ action_ref: string }>)[0]!.action_ref
    f.service.runNativeMcpAction.mockResolvedValueOnce({ status: 'returned', result: {
      decision: 'unknown', status: 'history_observed', observedStatus: 'pending', requestId: 'approval-1', recordId: 'contract-1',
      itemVersion: 'item-round-2', sourceMaterialVersion: pending.sourceMaterialVersion,
      history: [{ action: 'revise', actorId: 'employee-a', comment: '已核对。' }],
    } })

    const first = await f.call('run_current_item_action', { action_ref: actionRef, comment: '已核对。' })
    expect(first.body.result).toMatchObject({ outcome: 'unknown', nativeStatus: 'history_observed', decision: 'unknown', nativeAction: 'revise', currentItemVersionMatches: true })
    const repeated = await f.call('run_current_item_action', { action_ref: actionRef, comment: '已核对。' })
    expect(repeated.body.result).toMatchObject({ outcome: 'unknown' })
    expect(f.service.runNativeMcpAction).toHaveBeenCalledOnce()
    expect(f.approvalActions).toEqual([])
  })
  it('does not execute a stale action reference or cross an employee account change', async () => {
    const f = await fixture()
    const original = f.contexts.get('approval-1')!
    const { returnVersion: _returnVersion, returnReason: _returnReason, ...pendingBase } = original
    const firstSourceVersion = digest('approval-source-before')
    const first: EnterpriseApprovalContext = { ...pendingBase, status: 'pending', viewer: 'current_approver', sourceMaterialVersion: firstSourceVersion }
    const action = (sourceMaterialVersion: string, itemVersion: string): EnterpriseApprovalAction => ({
      label: '当前可办理事项', description: 'Forge 返回的动态动作描述。',
      execution: { tool: 'run_action', actionName: 'metadata_action', objectName: 'forge_sales_contract', recordId: 'contract-1', params: { approvalRequestId: 'approval-1', itemVersion, sourceMaterialVersion } },
      inputs: [{ name: 'comment', type: 'string', label: '办理意见', required: true }],
    })
    first.availableActions = [action(firstSourceVersion, 'item-round-1')]
    f.contexts.set('approval-1', first)
    await f.openApprovalReview()
    await f.input('办理当前事项，意见：核对通过。', 'employee-opinion-before-stale')
    const directory = await f.call('list_current_item_actions')
    const actionRef = (directory.body.result.actions as Array<{ action_ref: string }>)[0]!.action_ref

    const changedSourceVersion = digest('approval-source-after')
    f.contexts.set('approval-1', { ...first, sourceMaterialVersion: changedSourceVersion, availableActions: [action(changedSourceVersion, 'item-round-2')] })
    const stale = await f.call('run_current_item_action', { action_ref: actionRef, comment: '核对通过。' })
    expect(stale).toMatchObject({ status: 200, body: { result: { outcome: 'unknown' } } })
    expect(f.service.runNativeMcpAction).not.toHaveBeenCalled()

    const g = await fixture()
    const current = g.contexts.get('approval-1')!
    const { returnVersion: _returnVersion2, returnReason: _returnReason2, ...currentBase } = current
    const currentSource = digest('approval-source-account')
    const accountAction: EnterpriseApprovalAction = {
      label: '账户隔离动作', description: '当前账户事项动作。',
      execution: { tool: 'run_action', actionName: 'account_bound_action', objectName: 'forge_sales_contract', recordId: 'contract-1', params: { approvalRequestId: 'approval-1', itemVersion: 'item-account-round', sourceMaterialVersion: currentSource } },
      inputs: [{ name: 'comment', type: 'string', label: '办理意见', required: true }],
    }
    g.contexts.set('approval-1', { ...currentBase, status: 'pending', viewer: 'current_approver', sourceMaterialVersion: currentSource, availableActions: [accountAction] })
    await g.openApprovalReview()
    await g.input('办理当前事项，意见：核对通过。', 'employee-opinion-account-change')
    const accountDirectory = await g.call('list_current_item_actions')
    const accountActionRef = (accountDirectory.body.result.actions as Array<{ action_ref: string }>)[0]!.action_ref
    g.service.accountKey.mockResolvedValue('employee-b')
    g.service.getSession.mockResolvedValue(forgeSession('employee-b'))
    const crossAccount = await g.call('run_current_item_action', { action_ref: accountActionRef, comment: '核对通过。' })
    expect(crossAccount).toMatchObject({ status: 409, body: { error: expect.stringContaining('员工轮次或账号') } })
    expect(g.service.runNativeMcpAction).not.toHaveBeenCalled()
  })
  it('requires reopening review when its source account or current approval round changes', async () => {
    const f = await fixture()
    await f.openApprovalReview()
    f.service.accountKey.mockResolvedValue('employee-b')
    await expect(f.bridge.employeeCommand(f.runtimeId, { type: 'prompt', message: '继续核对当前审批' }))
      .rejects.toThrow('与当前账号或事项不匹配')
    f.service.accountKey.mockResolvedValue('employee-a')

    const changed = f.contexts.get('approval-1')!
    f.contexts.set('approval-1', { ...changed, title: '更新后的审批事项', returnVersion: 'revise-2', sourceMaterialVersion: digest('round-2') })
    await expect(f.bridge.employeeCommand(f.runtimeId, { type: 'prompt', message: '继续核对当前审批' }))
      .rejects.toThrow('审批事项或材料快照已变化')
    const reopened = await f.openApprovalReview('approval-1')
    expect(reopened.context.title).toBe('更新后的审批事项')
    expect(f.service.submitApprovalRevision).not.toHaveBeenCalled()
  })
  it('accepts more than eleven individually verified returned approval files', async () => {
    const f = await fixture()
    const current = f.contexts.get('approval-1')!
    const files = Array.from({ length: 12 }, (_, index) => {
      const content = `第 ${index + 1} 份已提交材料\n`
      return { fileId: `approval-file-${index + 1}`, name: `材料${index + 1}.txt`, mediaType: 'text/plain; charset=utf-8' as const,
        bytes: Buffer.byteLength(content), sha256: digest(content), content, verified: true }
    })
    f.contexts.set('approval-1', { ...current, files })

    const opened = await f.openReturned('approval-1')
    expect(opened.context.files).toHaveLength(12)
    expect(opened.context.files[11]?.content).toBe('第 12 份已提交材料\n')
  })
  it('restores persisted review mode after runtime restart and fails closed when its binding is missing', async () => {
    const f = await fixture()
    const opened = await f.openApprovalReview()
    const restarted = new AgentEnterpriseBridge({
      service: f.service,
      sessions: { prime: f.sessions, pi: f.sessions, loom: f.sessions },
      extensionPath: '/extensions/enterprise.ts',
      storage: { directory: f.storageDirectory },
    })
    await restarted.start()
    bridges.push(restarted)
    let environment = restarted.environmentFor({ cwd: f.cwd, sessionPath: opened.path, harness: 'pi' })
    restarted.bindSession(environment.GOOEYPI_ENTERPRISE_TOKEN, opened.path, 'runtime-review-restarted')
    const resumedPrompt = '继续核对这次审批的已固定材料。'
    await restarted.employeeCommand('runtime-review-restarted', { type: 'prompt', message: resumedPrompt })
    const resumed = await fetch(environment.GOOEYPI_ENTERPRISE_URL!, {
      method: 'POST', headers: { Authorization: `Bearer ${environment.GOOEYPI_ENTERPRISE_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'activate', params: { prompt: resumedPrompt } }),
    })
    const resumedBody = await resumed.json() as { result: { turn_key: string } }
    const blocked = await fetch(environment.GOOEYPI_ENTERPRISE_URL!, {
      method: 'POST', headers: { Authorization: `Bearer ${environment.GOOEYPI_ENTERPRISE_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'submit', params: { turn_key: resumedBody.result.turn_key } }),
    })
    expect(blocked.status).toBe(409)
    expect((await blocked.json()).error).toContain('只读核对')

    for (const file of await readdir(f.storageDirectory)) await rm(join(f.storageDirectory, file), { force: true })
    const missingBindingBridge = new AgentEnterpriseBridge({
      service: f.service,
      sessions: { prime: f.sessions, pi: f.sessions, loom: f.sessions },
      extensionPath: '/extensions/enterprise.ts',
      storage: { directory: f.storageDirectory },
    })
    await missingBindingBridge.start()
    bridges.push(missingBindingBridge)
    environment = missingBindingBridge.environmentFor({ cwd: f.cwd, sessionPath: opened.path, harness: 'pi' })
    missingBindingBridge.bindSession(environment.GOOEYPI_ENTERPRISE_TOKEN, opened.path, 'runtime-review-missing-binding')
    await expect(missingBindingBridge.employeeCommand('runtime-review-missing-binding', { type: 'prompt', message: '继续核对' }))
      .rejects.toThrow('审批辅助会话绑定已丢失')
  })
  it('does not let delayed review persistence overwrite a newer account session turn', async () => {
    const f = await fixture()
    const binding = await f.bridge.pinApprovalReviewContext('approval-1')
    const oldSession = f.startNewSession('review-delayed-old')
    const oldRuntimeId = oldSession.runtimeId
    const oldPrompt = `请只读复核「${binding.context.title}」\n\n${APPROVAL_REVIEW_SESSION_MARKER}`
    let releasePersistence!: () => void
    let reportPersistenceStarted!: () => void
    const persistenceStarted = new Promise<void>((resolve) => { reportPersistenceStarted = resolve })
    const persistenceGate = new Promise<void>((resolve) => { releasePersistence = resolve })
    const originalCheckpoint = HandoffStore.prototype.checkpoint
    const checkpoint = vi.spyOn(HandoffStore.prototype, 'checkpoint').mockImplementationOnce(async function<T>(this: HandoffStore, key: string, fingerprint: string, value: T) {
      reportPersistenceStarted()
      await persistenceGate
      return originalCheckpoint.call(this, key, fingerprint, value)
    })
    const oldOpen = f.bridge.employeeCommand(oldRuntimeId, { type: 'prompt', message: oldPrompt }, undefined, undefined, binding.handle)
    await persistenceStarted
    await expect(f.bridge.employeeCommand(oldRuntimeId, { type: 'prompt', message: '覆盖旧审批轮次' }))
      .rejects.toThrow('审批事项正在新会话中打开')

    f.bridge.invalidateAccount()
    f.service.accountKey.mockResolvedValue('employee-b')
    const latest = await f.bridge.pinApprovalReviewContext('approval-2')
    f.startNewSession('review-delayed-new')
    const latestPrompt = `请只读复核「${latest.context.title}」\n\n${APPROVAL_REVIEW_SESSION_MARKER}`
    await f.bridge.employeeCommand(f.runtimeId, { type: 'prompt', message: latestPrompt }, undefined, undefined, latest.handle)
    f.transcript.push(user('latest-review-round', latestPrompt))
    const activated = await f.call('activate', { prompt: latestPrompt })
    const latestTurnKey = activated.body.result.turn_key as string

    releasePersistence()
    await expect(oldOpen).rejects.toThrow('员工账号或轮次已变化')
    const stillReadOnly = await f.callWithTurn('submit', {}, latestTurnKey)
    expect(stillReadOnly.status).toBe(409)
    expect(stillReadOnly.body.error).toContain('只读核对')
    expect(checkpoint).toHaveBeenCalledTimes(2)
    expect(f.service.submitWork).not.toHaveBeenCalled()
    checkpoint.mockRestore()
  })
  it('recognizes the opened returned item as a revision without exposing reviewer actions or authorizing submission', async () => {
    const f = await fixture()
    await f.openReturned()
    const directory = await f.call('list_current_item_actions')
    expect(directory).toMatchObject({ status: 200, body: { result: {
      actions: [], revision_submission: { tool: 'gooeypi_approval_revision_submit', requires_employee_request: true },
    } } })
    expect(JSON.stringify(directory.body.result)).not.toContain('approval-1')
    expect(JSON.stringify(directory.body.result)).not.toContain('contract-1')
    const reviewerAction = await f.call('run_current_item_action', { action_ref: '1', comment: '同意' })
    expect(reviewerAction.status).toBe(409)
    expect(reviewerAction.body.error).toContain('不能执行审批复核动作')
    const openingSubmit = await f.call('revision_submit', { employee_request: '打开退回审批 approval-1', body: '未被员工要求递交的材料', materials: [] })
    expect(openingSubmit.status).toBe(409)
    expect(openingSubmit.body.error).toContain('打开退回事项只授权查看')
    expect(f.service.runNativeMcpAction).not.toHaveBeenCalled()
    expect(f.service.submitApprovalRevision).not.toHaveBeenCalled()
    expect(f.service.stageWorkMaterials).not.toHaveBeenCalled()
  })
  it('does not infer a returned approval binding from an ordinary conversation or reuse it after an account change', async () => {
    const f = await fixture()
    await f.input('我从我的工作打开了退回事项，请读取动作目录', 'ordinary-approval-claim')
    expect((await f.call('list_current_item_actions')).status).toBe(409)
    await f.openReturned()
    f.service.accountKey.mockResolvedValue('different-employee')
    expect((await f.call('list_current_item_actions')).status).toBe(409)
    expect(f.service.runNativeMcpAction).not.toHaveBeenCalled()
    expect(f.service.submitApprovalRevision).not.toHaveBeenCalled()
  })
  it('freezes a returned approval revision package for the opened account, request, and employee round', async () => {
    const f = await fixture()
    const opened = await f.openReturned()
    const employeeRequest = '按退回意见补全验收要求，帮我递交这版修订材料'
    await f.input(employeeRequest, 'employee-revision-1')
    const body = '修订后的合同正文：验收包含现场联调和连续运行三天。'
    const result = await f.call('revision_submit', { employee_request: employeeRequest, body, materials: f.materials })

    expect(opened.context).toMatchObject({ title: '测试合同', step: '销售修改', returnReason: '请补齐验收要求' })
    expect(opened.context).not.toHaveProperty('requestId')
    expect(opened.context).not.toHaveProperty('businessObject')
    expect(opened.context).not.toHaveProperty('returnVersion')
    expect(opened.context).not.toHaveProperty('sourceMaterialVersion')
    expect(opened.context.files[0]).not.toHaveProperty('fileId')
    expect(opened.context.files[0]).not.toHaveProperty('sha256')
    expect(result.body.result).toMatchObject({ status: 'resumed', submitted: true, materials: [{ name: '修订正文.md' }, { name: '合同.md' }] })
    expect(result.body.result.message).toContain('已进入下一轮')
    expect(f.service.submitWork).not.toHaveBeenCalled()
    expect(f.service.stageWorkMaterials.mock.calls[0]![0]).toMatchObject([
      { name: '修订正文.md', extraction: { content: body }, bytes: Buffer.byteLength(body), sha256: digest(body) },
      { name: '合同.md', extraction: { content: f.content }, bytes: Buffer.byteLength(f.content), sha256: digest(f.content) },
    ])
    const sent = f.service.submitApprovalRevision.mock.calls[0]!
    expect(sent[0]).toBe('approval-1')
    expect(sent[1]).toMatchObject({
      returnVersion: 'revise-1', sourceMaterialVersion: f.contexts.get('approval-1')!.sourceMaterialVersion,
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
      primary: { fileId: 'file-1', name: '修订正文.md', sha256: digest(body) },
      attachments: [{ fileId: 'file-2', name: '合同.md', sha256: digest(f.content) }],
    })

    const files = await readdir(f.storageDirectory)
    const saved = await Promise.all(files.map(async (file) => JSON.parse((await readFile(join(f.storageDirectory, file))).toString('utf8')) as { value: Record<string, unknown> }))
    const stored = saved.find((entry) => entry.value.requestId === 'approval-1') as { value: {
      requestId: string; returnVersion: string; sourceMaterialVersion: string; businessObject: { objectName: string; recordId: string };
      employeeMessageId: string; employeeRoundId: string; employeeRequest: string; body: { content: string; bytesBase64: string; sha256: string };
      idempotencyKey: string;
      sourceMessages: Array<{ messageId: string; eventSeq: number; sha256: string }>;
      sourceFiles: Array<{ fileId: string; bytesBase64: string }>; materials: Array<{ name: string; bytesBase64: string; sha256: string }>
    } }
    expect(stored.value).toMatchObject({
      requestId: 'approval-1', returnVersion: 'revise-1', sourceMaterialVersion: f.contexts.get('approval-1')!.sourceMaterialVersion,
      businessObject: { objectName: 'forge_sales_contract', recordId: 'contract-1' }, employeeRequest,
      body: { name: '修订正文.md', content: body, bytesBase64: Buffer.from(body).toString('base64'), sha256: digest(body) },
      sourceFiles: [{ fileId: 'source-file-approval-1', bytesBase64: Buffer.from('# 原提交合同\n客户：测试客户\n').toString('base64') }],
      materials: [{ name: '合同.md', bytesBase64: Buffer.from(f.content).toString('base64'), sha256: digest(f.content) }],
    })
    expect(stored.value.employeeMessageId).toBe('employee-revision-1')
    expect(stored.value.employeeRoundId).toMatch(/^[0-9a-f]{64}$/)
    expect(stored.value.idempotencyKey).toBe(submissionUUID(stored.value.employeeRoundId))
    expect(stored.value.sourceMessages.find((message) => message.messageId === 'employee-revision-1')?.sha256).toBe(digest(employeeRequest))
  })

  it('keeps full decorated session evidence even when a captured original employee request matches', async () => {
    const f = await fixture()
    await f.openReturned()
    const text = '明确要求递交本轮修订附件'
    const material: import('../../src/types/api').WorkspaceMaterialReference = { projectId: 'project-test', harness: 'pi', workspacePath: f.cwd, name: '合同.md', path: '材料/附件/合同.md', sha256: digest(f.content), bytes: Buffer.byteLength(f.content), mimeType: 'text/markdown' }
    const full = appendWorkspaceMaterialContext(text, [material])
    await f.input(full, 'employee-full-evidence', { text, materials: [material] })
    f.transcript.at(-1)!.parts = [{ type: 'text', text }]
    const result = await f.call('revision_submit', { employee_request: text, body: '修订测试正文', materials: f.materials })
    expect(result.status).toBe(409)
    expect(result.body.error).toContain('员工输入尚未进入原会话')
    expect(f.service.stageWorkMaterials).not.toHaveBeenCalled()
    expect(f.service.submitApprovalRevision).not.toHaveBeenCalled()
  })
  it('rejects selected file metadata whose captured length differs from the frozen bytes before upload', async () => {
    const f = await fixture()
    await f.openReturned()
    const text = '请递交本轮选定材料'
    const material: import('../../src/types/api').WorkspaceMaterialReference = { projectId: 'project-test', harness: 'pi', workspacePath: f.cwd, name: '合同.md', path: '材料/附件/合同.md', sha256: digest(f.content), bytes: Buffer.byteLength(f.content) + 1, mimeType: 'text/markdown' }
    await f.input(appendWorkspaceMaterialContext(text, [material]), 'employee-length-mismatch', { text, materials: [material] })
    const result = await f.call('revision_submit', { employee_request: text, body: '修订测试正文', materials: f.materials })
    expect(result.status).toBe(409)
    expect(JSON.stringify(result.body)).toContain('字节长度或文件类型')
    expect(f.service.stageWorkMaterials).not.toHaveBeenCalled()
    expect(f.service.submitApprovalRevision).not.toHaveBeenCalled()
  })
  it('submits an exact DOCX primary and PDF attachment without replacing the original bytes with markdown', async () => {
    const f = await fixture()
    await f.openReturned()
    const primaryPath = '材料/附件/合同修订原件.docx'
    const attachmentPath = '材料/附件/技术协议修订原件.pdf'
    const primaryBytes = await readFile(new URL('../fixtures/materials/合同样例.docx', import.meta.url))
    const attachmentBytes = await readFile(new URL('../fixtures/materials/技术协议样例.pdf', import.meta.url))
    await writeFile(join(f.cwd, primaryPath), primaryBytes)
    await writeFile(join(f.cwd, attachmentPath), attachmentBytes)
    const employeeRequest = '按退回意见递交这份 DOCX 主件和 PDF 技术附件，继续原审批'
    const attachments: import('../../src/types/api').WorkspaceMaterialReference[] = [
      { projectId: 'project-test', harness: 'pi', workspacePath: f.cwd, name: '合同修订原件.docx', path: primaryPath, sha256: digest(primaryBytes), bytes: primaryBytes.length, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      { projectId: 'project-test', harness: 'pi', workspacePath: f.cwd, name: '技术协议修订原件.pdf', path: attachmentPath, sha256: digest(attachmentBytes), bytes: attachmentBytes.length, mimeType: 'application/pdf' },
    ]
    const runtimePrompt = appendWorkspaceMaterialContext(employeeRequest, attachments)
    await f.input(runtimePrompt, 'employee-office-revision', { text: employeeRequest, materials: attachments })
    const primary = { path: primaryPath, sha256: digest(primaryBytes) }
    const materials = [{ path: attachmentPath, sha256: digest(attachmentBytes) }]
    const unselectedPath = '材料/附件/未选第三份材料.md', unselectedContent = '第三份真实存在的测试文件，不属于本轮选件'
    await writeFile(join(f.cwd, unselectedPath), unselectedContent)
    const extraFile = await f.call('revision_submit', { employee_request: employeeRequest, primary_material: primary, materials: [...materials, { path: unselectedPath, sha256: digest(unselectedContent) }] })
    expect(extraFile.status).toBe(409)
    expect(extraFile.body.error).toContain('本轮由员工实际选定')
    const wrongHash = await f.call('revision_submit', { employee_request: employeeRequest, primary_material: { ...primary, sha256: digest('另一个版本') }, materials })
    expect(wrongHash.status).toBe(409)
    expect(f.service.stageWorkMaterials).not.toHaveBeenCalled()
    expect(f.service.submitApprovalRevision).not.toHaveBeenCalled()
    const wrongRequest = await f.call('revision_submit', { employee_request: `${employeeRequest}（另一条要求）`, primary_material: primary, materials })
    expect(wrongRequest.status).toBe(409)
    const decoratedRequest = await f.call('revision_submit', { employee_request: runtimePrompt, primary_material: primary, materials })
    expect(decoratedRequest.status).toBe(409)
    expect(f.service.stageWorkMaterials).not.toHaveBeenCalled()
    const conflict = await f.call('revision_submit', { employee_request: employeeRequest, body: '另一份正文', primary_material: primary, materials })
    expect(conflict.status).toBe(409)
    expect(f.service.stageWorkMaterials).not.toHaveBeenCalled()
    const result = await f.call('revision_submit', { employee_request: employeeRequest, primary_material: primary, materials })
    expect(result.body.result).toMatchObject({ status: 'resumed', submitted: true })
    const repeated = await f.call('revision_submit', { employee_request: employeeRequest, primary_material: primary, materials })
    expect(repeated.body.result).toMatchObject({ status: 'resumed', submitted: true })
    const intents = await Promise.all((await readdir(f.storageDirectory)).map(async (file) => JSON.parse(await readFile(join(f.storageDirectory, file), 'utf8')) as { value: Record<string, unknown> }))
    expect(intents.find((entry) => entry.value.employeeRequest === employeeRequest)?.value).toMatchObject({
      sourceMessages: expect.arrayContaining([expect.objectContaining({ messageId: 'employee-office-revision', sha256: digest(runtimePrompt) })]),
    })
    expect(f.service.stageWorkMaterials).toHaveBeenCalledOnce()
    const uploaded = f.service.stageWorkMaterials.mock.calls[0]?.[0]
    expect(uploaded).toHaveLength(2)
    expect(uploaded?.map((file) => file.name)).toEqual(['合同修订原件.docx', '技术协议修订原件.pdf'])
    expect(Buffer.from(uploaded![0]!.bytesBase64, 'base64')).toEqual(primaryBytes)
    expect(Buffer.from(uploaded![1]!.bytesBase64, 'base64')).toEqual(attachmentBytes)
    const submitted = f.service.submitApprovalRevision.mock.calls[0]?.[1]
    expect(submitted).toMatchObject({
      primary: { name: '合同修订原件.docx', sha256: digest(primaryBytes), bytes: primaryBytes.length,
        mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      attachments: [{ name: '技术协议修订原件.pdf', sha256: digest(attachmentBytes), bytes: attachmentBytes.length, mediaType: 'application/pdf' }],
    })
    expect(JSON.stringify(submitted)).not.toContain('修订正文.md')
  })
  it('freezes approval PDF source identity with its exact bytes in the same returned revision intent', async () => {
    const f = await fixture()
    const source = await readFile(new URL('../fixtures/materials/sample-two-page.pdf', import.meta.url))
    const original = await freezeApprovalOriginalMaterial({
      sourceKind: 'approval', requestId: 'approval-1', fileId: 'approval-pdf-1', name: '验收附件.pdf',
      mediaType: 'application/pdf', bytes: source.length, sha256: digest(source),
    }, source, 700_000)
    const context = f.contexts.get('approval-1')!
    f.contexts.set('approval-1', { ...context, originalFiles: [original] })

    const opened = await f.openReturned()
    expect(opened.context.originalFiles).toMatchObject([{ name: '验收附件.pdf', bytes: source.length, verified: true }])
    expect(opened.context.originalFiles?.[0]).not.toHaveProperty('fileId')
    expect(opened.context.originalFiles?.[0]).not.toHaveProperty('requestId')
    expect(opened.context.originalFiles?.[0]).not.toHaveProperty('bytesBase64')
    expect(opened.context.originalFiles?.[0]).not.toHaveProperty('sha256')

    const employeeRequest = '按退回意见整理原审批附件并准备修订。'
    await f.input(employeeRequest, 'employee-approval-pdf-revision')
    await f.call('revision_submit', { employee_request: employeeRequest, body: '修订正文', materials: [] })

    const files = await readdir(f.storageDirectory)
    const saved = await Promise.all(files.map(async (file) => JSON.parse((await readFile(join(f.storageDirectory, file))).toString('utf8')) as { value: Record<string, unknown> }))
    const stored = saved.find((entry) => entry.value.requestId === 'approval-1')!.value
    expect(stored.sourceFiles).toMatchObject([{
      fileId: 'source-file-approval-1', name: '原合同.md', mediaType: 'text/plain; charset=utf-8',
      bytes: Buffer.byteLength('# 原提交合同\n客户：测试客户\n'), sha256: digest('# 原提交合同\n客户：测试客户\n'),
    }, {
      sourceKind: 'approval', requestId: 'approval-1', fileId: 'approval-pdf-1', name: '验收附件.pdf',
      mediaType: 'application/pdf', bytes: source.length, sha256: digest(source), bytesBase64: source.toString('base64'),
    }])
    expect(f.service.submitApprovalRevision).toHaveBeenCalledOnce()
  })
  it('rejects a pinned context if the account or return version changes before the Pi prompt starts', async () => {
    const f = await fixture()
    const opened = f.contexts.get('approval-1')!
    const binding = await f.bridge.pinReturnedApprovalContext('approval-1')
    f.startNewSession('return-version-change')
    f.contexts.set('approval-1', { ...opened, returnVersion: 'revise-2' })
    await expect(f.bridge.employeeCommand(f.runtimeId, { type: 'prompt', message: '打开退回审批 approval-1' }, binding.handle))
      .rejects.toThrow('退回意见或材料版本已变化')

    const other = await fixture()
    const otherBinding = await other.bridge.pinReturnedApprovalContext('approval-1')
    other.startNewSession('return-account-change')
    other.service.accountKey.mockResolvedValue('employee-b')
    await expect(other.bridge.employeeCommand(other.runtimeId, { type: 'prompt', message: '打开退回审批 approval-1' }, otherBinding.handle))
      .rejects.toThrow('当前账号已变化')
  })
  it('retries an identical frozen revision package without rereading changed local bytes and rejects changed material', async () => {
    const f = await fixture()
    await f.openReturned()
    const employeeRequest = '请把当前修订版递交上去'
    await f.input(employeeRequest, 'employee-revision-retry')
    const params = { employee_request: employeeRequest, body: '当前最终正文', materials: f.materials }
    const first = await f.call('revision_submit', params)
    expect(first.body.result.status).toBe('resumed')
    await writeFile(join(f.cwd, '材料', '附件', '合同.md'), '被修改的本地草稿')

    const retry = await f.call('revision_submit', params)
    expect(retry.body.result).toEqual(first.body.result)
    expect(f.service.stageWorkMaterials).toHaveBeenCalledOnce()
    expect(f.service.submitApprovalRevision).toHaveBeenCalledOnce()
    expect(f.service.getApprovalRevisionReceipt).toHaveBeenCalledOnce()
    const changedBody = await f.call('revision_submit', { ...params, body: '新的正文' })
    expect(changedBody.status).toBe(409)
    expect(changedBody.body.error).toContain('本轮修订材料已固定')
    const changedMaterial = await f.call('revision_submit', { ...params, materials: [{ path: '材料/附件/合同.md', sha256: digest('被修改的本地草稿') }] })
    expect(changedMaterial.status).toBe(409)
    expect(changedMaterial.body.error).toContain('本轮修订材料已固定')
  })
  it('queries the same receipt after a lost POST response and never reuploads or reposts', async () => {
    const f = await fixture()
    await f.openReturned()
    const employeeRequest = '请递交这版修订材料'
    await f.input(employeeRequest, 'employee-revision-lost-response')
    const params = { employee_request: employeeRequest, body: '修订正文', materials: f.materials }
    const receipt = {
      requestId: 'approval-1', bindingId: '550e8400-e29b-41d4-a716-446655440000',
      newVersionDigest: digest('new-revision-v1'), state: 'resume_unknown', repeated: true,
    }
    f.service.submitApprovalRevision.mockImplementationOnce(async (_requestId: string, _body: unknown, assertCurrent: () => Promise<void>) => {
      await assertCurrent()
      throw new Error('connection dropped after request')
    })
    f.service.getApprovalRevisionReceipt.mockImplementationOnce(async (_requestId: string, _key: string, assertCurrent: () => Promise<void>) => {
      await assertCurrent()
      return { status: 200, body: { data: receipt } }
    })

    const first = await f.call('revision_submit', params)
    expect(first.body.result).toMatchObject({ status: 'resume_unknown', submitted: false })
    const retry = await f.call('revision_submit', params)
    expect(retry.body.result.status).toBe('resume_unknown')
    expect(f.service.stageWorkMaterials).toHaveBeenCalledOnce()
    expect(f.service.submitApprovalRevision).toHaveBeenCalledOnce()
    expect(f.service.getApprovalRevisionReceipt).toHaveBeenCalledTimes(2)
  })
  it('resumes an interrupted file upload from its per-file receipts and then submits once', async () => {
    const f = await fixture()
    await f.openReturned()
    const employeeRequest = '请递交这版正文和附件'
    await f.input(employeeRequest, 'employee-revision-upload-interrupted')
    f.service.stageWorkMaterials.mockRejectedValueOnce(new Error('upload connection interrupted'))
    const params = { employee_request: employeeRequest, body: '正文', materials: f.materials }

    const first = await f.call('revision_submit', params)
    expect(first.body.result).toMatchObject({ status: 'upload_unknown', submitted: false })
    const retry = await f.call('revision_submit', params)
    expect(retry.body.result).toMatchObject({ status: 'resumed', submitted: true })
    expect(f.service.stageWorkMaterials).toHaveBeenCalledTimes(2)
    // Both attempts share one receipt store, so files committed the first time are reused.
    const progress = (f.service.stageWorkMaterials.mock.calls as unknown[][]).map((call) => call[2])
    expect(progress[0]).toBeDefined()
    expect(progress[1]).toBeDefined()
    expect(f.service.submitApprovalRevision).toHaveBeenCalledOnce()
  })
  it('reports a Forge prepared receipt without claiming that the next approval round resumed', async () => {
    const f = await fixture()
    await f.openReturned()
    const employeeRequest = '帮我递交这版正文'
    await f.input(employeeRequest, 'employee-revision-prepared')
    f.service.submitApprovalRevision.mockImplementationOnce(async (_requestId: string, body: { idempotencyKey: string }, assertCurrent: () => Promise<void>) => {
      await assertCurrent()
      const receipt = {
        requestId: 'approval-1', bindingId: '550e8400-e29b-41d4-a716-446655440000',
        newVersionDigest: digest('new-revision-v1'), state: 'prepared', repeated: true,
      }
      f.revisionReceipts.set(body.idempotencyKey, receipt)
      return { status: 200, body: { data: receipt } }
    })
    const result = await f.call('revision_submit', { employee_request: employeeRequest, body: '修订正文', materials: [] })
    expect(result.body.result).toMatchObject({ status: 'prepared', submitted: false, receiptConfirmed: true })
    expect(result.body.result.message).toContain('尚未确认')
  })
  it('fails closed on a 404 Forge service and does not fall back to native resubmit', async () => {
    const f = await fixture()
    await f.openReturned()
    const employeeRequest = '请提交修改后的合同'
    await f.input(employeeRequest, 'employee-revision-old-server')
    f.service.submitApprovalRevision.mockImplementationOnce(async () => ({ status: 404, body: { message: 'not found' } as unknown as { data: { requestId: string; bindingId: string; newVersionDigest: string; state: string; repeated: boolean } } }))
    const params = { employee_request: employeeRequest, body: '修订正文', materials: f.materials }

    const first = await f.call('revision_submit', params)
    expect(first.body.result).toMatchObject({ status: 'unavailable', submitted: false, receiptConfirmed: false })
    expect(first.body.result.message).toContain('没有退回材料修订接口')
    const retry = await f.call('revision_submit', params)
    expect(retry.body.result).toEqual(first.body.result)
    expect(f.service.submitApprovalRevision).toHaveBeenCalledOnce()
    expect(f.service.getApprovalRevisionReceipt).not.toHaveBeenCalled()
    expect(f.service.stageWorkMaterials).toHaveBeenCalledOnce()
    expect(f.service.submitWork).not.toHaveBeenCalled()
  })
  it('blocks an old returned revision when the account, approval, or employee round changes', async () => {
    const f = await fixture()
    await f.openReturned()
    const employeeRequest = '确认把这一版修订材料递交'
    const oldTurnKey = await f.input(employeeRequest, 'employee-revision-old')
    const params = { employee_request: employeeRequest, body: '修订正文', materials: f.materials }

    await f.input('先等等，重新核对一下', 'employee-revision-new-round')
    const oldRound = await f.callWithTurn('revision_submit', params, oldTurnKey)
    expect(oldRound.status).toBe(409)
    expect(oldRound.body.error).toContain('员工要求已变化')

    await f.openReturned('approval-2')
    const secondPrompt = '打开退回审批 approval-2'
    const secondTurnKey = f.getTurnKey()
    const changedApproval = await f.callWithTurn('revision_submit', params, secondTurnKey)
    expect(changedApproval.status).toBe(409)
    expect(changedApproval.body.error).toContain('员工本轮要求已变化')

    f.service.accountKey.mockResolvedValue('employee-b')
    const changedAccount = await f.callWithTurn('revision_submit', { ...params, employee_request: secondPrompt }, secondTurnKey)
    expect(changedAccount.status).toBe(409)
    expect(changedAccount.body.error).toContain('账号已变化')
    expect(f.service.submitWork).not.toHaveBeenCalled()
    expect(f.service.stageWorkMaterials).not.toHaveBeenCalled()
    expect(f.service.submitApprovalRevision).not.toHaveBeenCalled()
    expect(f.service.getApprovalRevisionReceipt).not.toHaveBeenCalled()
  })
  it('stops when the latest return version or business object changed after opening', async () => {
    const f = await fixture()
    await f.openReturned()
    const employeeRequest = '请递交刚改好的材料'
    await f.input(employeeRequest, 'employee-revision-stale-context')
    const context = f.contexts.get('approval-1')!
    f.contexts.set('approval-1', { ...context, returnVersion: 'revise-2', businessObject: { ...context.businessObject, recordId: 'contract-2' } })
    const result = await f.call('revision_submit', { employee_request: employeeRequest, body: '正文', materials: [] })
    expect(result.status).toBe(409)
    expect(result.body.error).toContain('退回意见、业务对象或原材料版本已变化')
    await expect(readdir(f.storageDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('rejects a business action that was not returned for this team view', async () => {
    const f = await fixture(), params = await f.discover()
    expect((await f.call('submit', { ...params, business_actions: ['invented-action'] })).status).toBe(409)
    expect(f.service.submitWork).not.toHaveBeenCalled()
  })
  it('invalidates the old turn before a later employee steer is written to the transcript', async () => {
    const f = await fixture(), params = await f.discover()
    await f.bridge.employeeCommand(f.runtimeId, { type: 'steer', message: '先等等' })
    expect((await f.call('submit', params)).status).toBe(409)
    expect(f.service.submitWork).not.toHaveBeenCalled()
  })
  it('revokes a renderer-queued employee change before the runtime sees it', async () => {
    const f = await fixture(), params = await f.discover()
    f.bridge.invalidateHandoff('runtime')
    expect((await f.call('submit', params)).status).toBe(409)
    expect(f.service.submitWork).not.toHaveBeenCalled()
  })
  it('does not replace authorization with the last user message', async () => {
    const f = await fixture(), params = await f.discover()
    f.transcript.push(user('employee-later', '先别发'))
    expect((await f.call('submit', params)).status).toBe(409)
    expect(f.service.submitWork).not.toHaveBeenCalled()
  })
  it('rejects another account and revokes runtime credentials when the account session changes', async () => {
    const f = await fixture(), params = await f.discover()
    f.service.accountKey.mockResolvedValue('employee-b')
    const wrongAccount = await f.call('submit', params)
    expect(wrongAccount.status).toBe(409)
    expect(wrongAccount.body.error).toContain('账号已变化')
    expect(wrongAccount.body.error).not.toContain('没有绑定原工作')
    f.service.accountKey.mockResolvedValue('employee-a')
    f.bridge.invalidateAccount()
    expect((await f.call('submit', params)).status).toBe(401)
    expect(f.service.submitWork).not.toHaveBeenCalled()
  })
  it('rejects missing materials, changed versions and paths outside the working directory', async () => {
    const f = await fixture(), params = await f.discover()
    expect((await f.call('submit', { ...params, materials: [] })).status).toBe(409)
    expect((await f.call('submit', { ...params, materials: [{ path: 'absent.md', sha256: digest('x') }] })).status).toBe(409)
    await writeFile(join(f.cwd, '材料', '附件', '合同.md'), 'changed')
    expect((await f.call('submit', params)).body.error).toContain('版本已变化')
    expect(f.service.submitWork).not.toHaveBeenCalled()
  })
  it('rejects an account-workspace file that was never attached or explicitly reused in this employee turn', async () => {
    const f = await fixture()
    const oldPath = '材料/附件/青峦工业合同.md'
    const oldContent = '# 青峦工业合同\n'
    await writeFile(join(f.cwd, oldPath), oldContent)
    await f.input('请分析北辰装备线索。', 'employee-lead-turn')
    const nextTurn = await f.discover()
    const result = await f.call('submit', { ...nextTurn, materials: [{ path: oldPath, sha256: digest(oldContent) }] })
    expect(result.status).toBe(409)
    expect(result.body.error).toContain('只能交接本轮消息中实际附加的材料')
    expect(f.service.stageWorkMaterials).not.toHaveBeenCalled()
    expect(f.service.submitWork).not.toHaveBeenCalled()
  })
  it('requires an earlier same-session attachment to be reattached in the current employee turn', async () => {
    const f = await fixture()
    await f.input('请继续检查上一轮附加的合同.md。', 'employee-explicit-reuse')
    const namedOnly = await f.discover()
    const denied = await f.call('submit', namedOnly)
    expect(denied.status).toBe(409)
    expect(denied.body.error).toContain('本轮重新附加')
    expect(f.service.stageWorkMaterials).not.toHaveBeenCalled()

    const reference = {
      projectId: 'project-test', harness: 'pi' as const, workspacePath: f.cwd,
      name: '合同.md', path: '材料/附件/合同.md', sha256: digest(f.content),
      bytes: Buffer.byteLength(f.content), mimeType: 'text/markdown' as const,
    }
    await f.input(appendWorkspaceMaterialContext('这轮我重新附加合同.md，请继续检查。', [reference]), 'employee-explicit-reattach')
    const reattached = await f.discover()
    const result = await f.call('submit', reattached)
    expect(result.status).toBe(200)
    expect(result.body.result.status).toBe('accepted')
    expect(f.service.stageWorkMaterials).toHaveBeenCalledOnce()
    expect(f.service.stageWorkMaterials.mock.calls[0]?.[0][0]?.extraction.content).toBe(f.content)
  })
  it('retries an identical package after failure without rereading a changed file or conversation', async () => {
    const f = await fixture(), params = await f.discover()
    f.service.submitWork.mockRejectedValueOnce(new Error('connection lost'))
    expect((await f.call('submit', params)).body.result.status).toBe('unknown')
    await writeFile(join(f.cwd, '材料', '附件', '合同.md'), 'later draft')
    f.transcript.push({ id: 'assistant-later', role: 'assistant', parts: [{ type: 'text', text: '稍后重试' }] })
    expect((await f.call('submit', params)).status).toBe(200)
    expect(f.service.submitWork.mock.calls[0][1]).toBe(f.service.submitWork.mock.calls[1][1])
    const first = f.service.submitWork.mock.calls[0][2] as unknown as { sourceMessages: unknown }
    const second = f.service.submitWork.mock.calls[1][2] as unknown as { sourceMessages: unknown }
    expect(first.sourceMessages).toEqual(second.sourceMessages)
    expect((await f.call('submit', { ...params, goal: '修改目标' })).body.error).toContain('已冻结')
  })
  it('persists a current employee intent as local JSON before material upload and team dispatch', async () => {
    const f = await fixture(), params = await f.discover()
    expect(await f.service.accountKey()).toBe('employee-a')

    const submitted = await f.call('submit', params)
    expect(submitted.body.result.status).toBe('accepted')
    expect(f.service.stageWorkMaterials).toHaveBeenCalledOnce()
    expect(f.service.submitWork).toHaveBeenCalledOnce()
    const files = await readdir(f.storageDirectory)
    expect(files.length).toBeGreaterThan(0)
    expect(files.every((file) => /^[0-9a-f]{64}\.json$/.test(file))).toBe(true)
    const saved = await Promise.all(files.map(async (file) => JSON.parse(await readFile(join(f.storageDirectory, file), 'utf8')) as { fingerprint: string; value: unknown }))
    expect(saved.every((record) => typeof record.fingerprint === 'string' && 'value' in record)).toBe(true)
  })

  it('requires a configured persistence directory before fixing a returned revision package', async () => {
    const f = await fixture('forge_sales_contract', false)
    await f.openReturned()
    const employeeRequest = '按退回意见补全验收要求，帮我递交这版修订材料'
    await f.input(employeeRequest, 'employee-revision-no-storage-directory')

    const result = await f.call('revision_submit', { employee_request: employeeRequest, body: '修订正文', materials: f.materials })
    expect(result.body.error).toContain('本地交接存储目录未配置')
    expect(result.body.error).not.toContain('安全存储')
    expect(f.service.stageWorkMaterials).not.toHaveBeenCalled()
    expect(f.service.submitApprovalRevision).not.toHaveBeenCalled()
  })
  it('reports a definite Weave registration rejection without telling Pi to recover an accepted run', async () => {
    const f = await fixture(), params = await f.discover()
    f.service.submitWork.mockRejectedValueOnce(new WorkRegistrationRejectedError('原工作输入版本已变化'))
    const rejected = await f.call('submit', params)
    expect(rejected.body.result).toMatchObject({ status: 'rejected', submitted: false, receiptConfirmed: false })
    expect(rejected.body.result).not.toHaveProperty('recovery_key')
    expect(rejected.body.result.next_step).toContain('未创建团队运行')
  })
  it('freezes material before upload and resumes an upload failure with the original bytes', async () => {
    const f = await fixture(), params = await f.discover()
    f.service.stageWorkMaterials.mockRejectedValueOnce(new Error('upload interrupted'))
    const first = await f.call('submit', params)
    expect(first.body.result).toMatchObject({ status: 'unknown' })
    await writeFile(join(f.cwd, '材料', '附件', '合同.md'), 'later draft')
    expect((await f.call('recover', { recovery_key: first.body.result.recovery_key })).body.result.status).toBe('accepted')
    const retriedMaterials = f.service.stageWorkMaterials.mock.calls[1][0]
    expect(retriedMaterials[0].extraction.content).toBe(f.content)
  })
  it('rejects an old turn key after the employee cancels a pending handoff', async () => {
    const f = await fixture(), params = await f.discover()
    f.service.stageWorkMaterials.mockRejectedValueOnce(new Error('upload interrupted'))
    const first = await f.call('submit', params)
    const recoveryKey = first.body.result.recovery_key as string
    const oldTurnKey = f.getTurnKey()
    await f.input('先等等，暂时不要继续', 'employee-turn-2')
    const recovered = await f.callWithTurn('recover', { recovery_key: recoveryKey }, oldTurnKey)
    expect(recovered.status).toBe(409)
    expect(recovered.body.error).toContain('旧交接不能继续')
    expect(f.service.stageWorkMaterials).toHaveBeenCalledOnce()
    expect(f.service.submitWork).not.toHaveBeenCalled()
  })
  it('recovers the original request within its authorized employee turn and rejects a different account', async () => {
    const f = await fixture(), params = await f.discover()
    const first = await f.call('submit', params)
    const recoveryKey = first.body.result.recovery_key
    expect((await f.call('recover', { recovery_key: recoveryKey })).body.result.status).toBe('accepted')
    expect(f.service.submitWork.mock.calls[0][1]).toBe(f.service.submitWork.mock.calls[1][1])
    f.service.accountKey.mockResolvedValue('employee-b')
    await f.input('恢复原交接', 'other-account-turn')
    expect((await f.call('recover', { recovery_key: recoveryKey })).body.error).toContain('不属于当前员工')
    expect(f.service.submitWork).toHaveBeenCalledTimes(2)
  })
  it('resumes the same frozen request after re-login without attachments or re-uploading saved resources', async () => {
    const f = await fixture(), params = await f.discover()
    f.service.submitWork.mockRejectedValueOnce(new Error('connection lost'))
    const first = await f.call('submit', params)
    expect(first.body.result.status).toBe('unknown')
    const recoveryKey = first.body.result.recovery_key as string
    await writeFile(join(f.cwd, '材料', '附件', '合同.md'), 'later draft')

    await f.relogin()
    await f.input('继续核对同一冻结合同只读请求', 'employee-relogin-round-2')
    const resumed = await f.call('recover', { recovery_key: recoveryKey })
    expect(resumed.body.result.status).toBe('accepted')
    expect(f.service.stageWorkMaterials).toHaveBeenCalledOnce()
    expect(f.service.stageWorkMaterials.mock.calls[0]?.[0][0]?.extraction.content).toBe(f.content)
    expect(f.service.submitWork).toHaveBeenCalledTimes(2)
    const firstSubmission = f.service.submitWork.mock.calls[0]!
    const resumedSubmission = f.service.submitWork.mock.calls[1]!
    expect(resumedSubmission[1]).toBe(firstSubmission[1])
    expect(resumedSubmission[2]?.idempotencySeed).toBe(firstSubmission[2]?.idempotencySeed)
    expect(resumedSubmission[2]?.resources).toEqual(firstSubmission[2]?.resources)
    expect(resumedSubmission[2]).toMatchObject({
      idempotencySeed: `${digest('/sessions/current.jsonl').slice(0, 24)}:employee-turn-1:${params.handoff_key}`,
      authorizedBusinessCapabilityIds: [],
    })
  })
  it('rejects cross-turn recovery when the original employee message hash changes', async () => {
    const f = await fixture(), params = await f.discover()
    f.service.stageWorkMaterials.mockRejectedValueOnce(new Error('upload interrupted'))
    const first = await f.call('submit', params)
    const recoveryKey = first.body.result.recovery_key as string
    await f.relogin()
    await f.input('继续核对原请求', 'employee-recovery-round-2')
    f.transcript[0] = user('employee-turn-1', '改过的原始请求')

    const recovered = await f.call('recover', { recovery_key: recoveryKey })
    expect(recovered.status).toBe(409)
    expect(recovered.body.error).toContain('原员工消息已修改或不存在')
    expect(f.service.stageWorkMaterials).toHaveBeenCalledOnce()
    expect(f.service.submitWork).not.toHaveBeenCalled()
  })
  it('rejects re-authorizing a frozen handoff under a different session or account', async () => {
    const f = await fixture(), params = await f.discover()
    f.service.stageWorkMaterials.mockRejectedValueOnce(new Error('upload interrupted'))
    const first = await f.call('submit', params)
    const recoveryKey = first.body.result.recovery_key as string

    await f.relogin({ sessionPath: '/sessions/other.jsonl' })
    await f.input('继续检查原冻结请求', 'employee-other-session')
    const otherSession = await f.call('recover', { recovery_key: recoveryKey })
    expect(otherSession.status).toBe(409)
    expect(otherSession.body.error).toContain('不属于当前员工与会话')

    await f.relogin({ accountKey: 'employee-b', sessionPath: '/sessions/current.jsonl' })
    await f.input('继续检查原冻结请求', 'employee-other-account')
    const otherAccount = await f.call('recover', { recovery_key: recoveryKey })
    expect(otherAccount.status).toBe(409)
    expect(otherAccount.body.error).toContain('不属于当前员工与会话')
    expect(f.service.stageWorkMaterials).toHaveBeenCalledOnce()
    expect(f.service.submitWork).not.toHaveBeenCalled()
  })

  it('coalesces concurrent identical submissions', async () => {
    const f = await fixture(), params = await f.discover()
    let release!: () => void
    const barrier = new Promise<void>((resolve) => { release = resolve })
    f.service.submitWork.mockImplementation(async () => { await barrier; return { workId: 'work', runId: 'run', taskId: 'task', workflowId: 'workflow-review', workflowVersion: 3, repeated: false } })
    const first = f.call('submit', params), second = f.call('submit', params)
    await vi.waitFor(() => expect(f.service.submitWork).toHaveBeenCalledOnce())
    release()
    expect((await Promise.all([first, second])).map((result) => result.status)).toEqual([200, 200])
    expect(f.service.submitWork).toHaveBeenCalledOnce()
  })
  it('rejects a removed published version before preparing material delivery', async () => {
    const f = await fixture(), params = await f.discover()
    f.service.getTeamChoices.mockResolvedValue([])
    expect((await f.call('submit', params)).body.error).toContain('版本已经变化')
    expect(f.service.submitWork).not.toHaveBeenCalled()
  })
  it('requires the declared business record for a non-contract action as well', async () => {
    const f = await fixture('forge_quote'), params = await f.discover()
    const business_actions = [params.available_actions[0].action_key]
    expect((await f.call('submit', { ...params, business_actions })).body.error).toContain('绑定该动作所需的业务记录')
    expect(f.service.stageWorkMaterials).not.toHaveBeenCalled()
    const { recordKey } = await f.findRecord('TEST-100')
    expect((await f.call('submit', { ...params, materials: [], business_actions, business_record_key: recordKey })).body.result.status).toBe('accepted')
    expect(f.service.submitWork.mock.calls[0][2]).toMatchObject({ businessContext: { objectName: 'forge_quote', recordId: 'contract-1', recordVersion: 'v7' } })
    expect(JSON.parse(f.service.submitWork.mock.calls[0][1]).businessSnapshot).toEqual(f.businessSnapshot)
    expect(f.service.stageWorkMaterials).not.toHaveBeenCalled()
  })
  it('rejects a late capability response after the employee changes the request', async () => {
    const f = await fixture()
    const search = await f.call('search', { work_summary: '合同' })
    const teamKey = (search.body.result.teams as Array<{ team_key: string }>)[0].team_key
    const result = await f.service.getBusinessCapabilities()
    let release!: (value: typeof result) => void
    f.service.getBusinessCapabilities.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const pending = f.call('describe', { team_key: teamKey })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    f.bridge.invalidateAccount()
    release(result)
    expect((await pending).status).toBe(409)
    expect(f.service.submitWork).not.toHaveBeenCalled()
  })

})


it('creates from a current object reference without fake record identity and reads the returned record for continuation', async () => {
  const f = await fixture('forge_sales_lead')
  const created = (await f.service.readBusinessRecord()).candidate
  const createContext: EmployeeBusinessContext = { version: '1', contextId: '10000000-0000-4000-8000-000000000001', contextVersion: 'a'.repeat(64), expiresAt: new Date(Date.now() + 60000).toISOString(), readOnly: true,
    objectName: 'forge_sales_lead', objectLabel: '销售线索', source: { kind: 'creation' }, actions: [{ action_ref: 1, capabilityId: 'forge:action:forge_sales_lead.sales_lead_create', declarationVersion: 'b'.repeat(64), label: '创建线索', description: '本人创建', effect: 'write', executionMode: 'employee_only', requiresRecord: false,
      parameters: [{ name: 'name', label: '名称', type: 'string', required: true }] }] }
  f.service.getEmployeeBusinessContext.mockImplementation(async selection => 'objectName' in selection ? createContext : { version: '1', contextId: createContext.contextId, contextVersion: 'c'.repeat(64), expiresAt: createContext.expiresAt, readOnly: true, record: selection.record, source: selection.source, recordVersion: 'created-record-version', actions: [] })
  f.service.executeEmployeeBusinessAction.mockImplementation(async request => ({ version: '1', operationId: request.opKey, contextId: request.contextId, requestDigest: employeeBusinessRequestDigest(request), status: 'succeeded', repeated: false, updatedAt: new Date().toISOString(), recordReferences: [{ objectName: created.objectName, recordId: created.recordId, label: created.name }] }))
  await f.input('线索名称项目甲', 'draft-lead-turn', { text: '线索名称项目甲', materials: [] })
  await f.input('按刚才的内容建吧', 'create-lead-turn', { text: '按刚才的内容建吧', materials: [] })
  const objects = await f.call('list_business_objects')
  const objectRef = (objects.body.result.objects as Array<{ object_ref: string }>)[0].object_ref
  const listed = await f.call('list_current_item_actions', { object_ref: objectRef })
  expect(listed.status).toBe(200)
  expect(f.service.getEmployeeBusinessContext).toHaveBeenLastCalledWith({ objectName: 'forge_sales_lead', source: { kind: 'creation' } })
  const inputSource = (listed.body.result.input_sources as Array<{ source_ref: string; text: string }>).find(source => source.text === '线索名称项目甲')!
  expect(inputSource).toBeDefined()
  const made = await f.call('run_current_item_action', { action_ref: 1, values: { name: '项目甲' }, input_sources: { 'values.name': inputSource.source_ref } })
  expect(made.body.result.status).toBe('succeeded')
  const key = (made.body.result.records as Array<{ record_key: string }>)[0].record_key
  expect(key).toMatch(/^[0-9a-f]{32}$/)
  expect(JSON.stringify(made.body.result)).not.toContain(created.recordId)
  expect((await f.call('read_business_record', { record_key: key })).status).toBe(200)
  await f.call('list_current_item_actions')
  expect(f.service.getEmployeeBusinessContext).toHaveBeenLastCalledWith(expect.objectContaining({ record: expect.objectContaining({ recordId: created.recordId }) }))
  await f.input('只查看需要的字段', 'next-read-turn')
  expect((await f.call('list_current_item_actions', { object_ref: objectRef })).status).toBe(409)
})

describe('own client sessions', () => {
  it('lists only numbered references and revokes one after the person confirms at the window', async () => {
    const f = await fixture()
    const sessions = [
      { id: '7f1c2d3e-0000-4000-8000-000000000001', client: 'Claude Desktop', createdAt: '2026-10-12T09:00:00Z', lastUsedAt: '2026-10-13T08:00:00Z', expiresAt: '2026-10-26T09:00:00Z' },
      { id: '7f1c2d3e-0000-4000-8000-000000000002', client: 'Cursor', createdAt: '2026-10-13T10:00:00Z', expiresAt: '2026-10-27T10:00:00Z' },
    ]
    const service = f.service as typeof f.service & { listOwnClientSessions: ReturnType<typeof vi.fn>; revokeOwnClientSession: ReturnType<typeof vi.fn> }
    service.listOwnClientSessions = vi.fn(async () => structuredClone(sessions))
    service.revokeOwnClientSession = vi.fn(async () => undefined)
    const confirm = vi.fn(async () => false)
    ;(f.bridge as unknown as { options: { confirmOperation?: typeof confirm } }).options.confirmOperation = confirm

    const unlisted = await f.call('client_session_revoke', { session_ref: '1' })
    expect(unlisted.body.ok).toBe(false)
    const listed = await f.call('client_sessions')
    expect(listed.body.result.sessions).toEqual([
      { session_ref: '1', client: 'Claude Desktop', signed_in_at: '2026-10-12T09:00:00Z', last_used_at: '2026-10-13T08:00:00Z', expires_at: '2026-10-26T09:00:00Z' },
      { session_ref: '2', client: 'Cursor', signed_in_at: '2026-10-13T10:00:00Z', expires_at: '2026-10-27T10:00:00Z' },
    ])
    expect(JSON.stringify(listed.body)).not.toContain(sessions[0].id)

    const declined = await f.call('client_session_revoke', { session_ref: '2' })
    expect(declined.body.result.status).toBe('declined')
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: '收回客户端会话', subject: expect.stringContaining('Cursor') }))
    expect(service.revokeOwnClientSession).not.toHaveBeenCalled()

    confirm.mockResolvedValueOnce(true)
    const revoked = await f.call('client_session_revoke', { session_ref: '2' })
    expect(revoked.body.result.status).toBe('done')
    expect(service.revokeOwnClientSession).toHaveBeenCalledWith(sessions[1].id)
  })
})

describe('native initialization bridge boundaries', () => {
  async function initializationFixture() {
    const f = await fixture()
    const params = [{ name: 'fields_json', label: '资料', type: 'string', required: true }, { name: 'operation_key', label: '原操作', type: 'string', required: true }]
    const actions: InitializationAction[] = ['units', 'positions'].map(domain => ({ name: `initialization_${domain}`, objectName: 'forge_business_setting_option',
      label: domain === 'units' ? '初始化计量单位' : '初始化岗位', description: '原生声明', effect: 'write', requiresRecord: false, requiresConfirmation: domain === 'positions', params }))
    const native = Object.assign(f.service, {
      listInitializationActions: vi.fn(async () => structuredClone(actions)),
      runNativeInitializationAction: vi.fn<InitializationScope['run']>(async (_args, assertCurrent, _confirm, before) => {
        await before(); await assertCurrent()
        return { status: 'returned', result: { version: '1', status: 'succeeded', summary: '资料已保存' } }
      }),
    })
    const employeePrompt = '请创建单位台并创建岗位'
    await f.input(employeePrompt, 'initialization-employee-message')
    const runParams = (name: string) => ({ object_name: 'forge_business_setting_option', action_name: `initialization_${name}`, inputs_json: '{"fields_json":"{\\"name\\":\\"台\\"}"}', employee_request: employeePrompt })
    return { ...f, native, runParams }
  }

  it('allows several native initialization actions and fences other employee writes in that turn', async () => {
    const f = await initializationFixture()
    expect((await f.call('initialization_list')).status).toBe(200)
    expect((await f.call('initialization_run', f.runParams('units'))).body.result.status).toBe('succeeded')
    expect((await f.call('initialization_run', f.runParams('positions'))).body.result.status).toBe('succeeded')
    expect(f.native.runNativeInitializationAction).toHaveBeenCalledTimes(2)
    const other = await f.call('run_current_item_action', { action_ref: 1, values: {} })
    expect(other.body.error).toContain('初始化')
    expect(f.service.executeEmployeeBusinessAction).not.toHaveBeenCalled()
  })

  it('does not let initialization bypass a previously reserved employee action', async () => {
    const f = await initializationFixture()
    await f.call('run_current_item_action', { action_ref: 1, values: {} })
    const initialization = await f.call('initialization_run', f.runParams('units'))
    expect(initialization.body.error).toContain('本轮已办理其他业务动作')
    expect(f.native.runNativeInitializationAction).not.toHaveBeenCalled()
  })

  it('rejects stale employee turns and old plan endpoints without calling Forge', async () => {
    const f = await initializationFixture(), previous = f.getTurnKey()
    await f.input('只核对，不办理', 'new-initialization-request')
    expect((await f.callWithTurn('initialization_run', f.runParams('units'), previous)).body.error).toContain('员工要求已变化')
    expect((await f.call('initialization_apply', { plan_key: 'a'.repeat(64), employee_request: '只核对，不办理' })).body.ok).toBe(false)
    expect(f.native.runNativeInitializationAction).not.toHaveBeenCalled()
  })
})


it.each(['pi', 'loom'] as const)('reads only %s employee-selected originals and keeps partial PDF coverage', async (harness) => {
  const f = await fixture('forge_sales_contract', true, harness)
  const bytes = await readFile(new URL('../fixtures/materials/sample-two-page.pdf', import.meta.url))
  const path = '材料/附件/合同 样例.pdf'
  await writeFile(join(f.cwd, path), bytes)
  const reference = { projectId: 'project-test', harness, workspacePath: f.cwd, name: '合同 样例.pdf', path,
    sha256: digest(bytes), bytes: bytes.length, mimeType: 'application/pdf' as const }
  const text = '请只读查看本轮原件'
  const prompt = appendWorkspaceMaterialContext(text, [reference])
  const turn = await f.input(prompt, 'selected-pdf', { text, materials: [reference] })
  const read = await f.call('read_selected_material', { path, sha256: reference.sha256 })
  expect(read.status).toBe(200)
  expect(read.body.result).toMatchObject({ name: reference.name, sha256: reference.sha256, bytes: bytes.length,
    extraction: { status: 'partial', sourceSha256: reference.sha256, coverage: { pdfPagesWithoutText: [2] } } })
  expect(read.body.result).not.toHaveProperty('bytesBase64')
  expect(f.service.stageWorkMaterials).not.toHaveBeenCalled()
  expect(f.service.submitWork).not.toHaveBeenCalled()
  expect((await f.call('read_selected_material', { path: '材料/附件/未选定.pdf', sha256: reference.sha256 })).status).toBe(409)
  await writeFile(join(f.cwd, path), Buffer.concat([bytes, Buffer.from('changed')]))
  expect((await f.call('read_selected_material', { path, sha256: reference.sha256 })).body.error).toContain('材料版本已变化')
  await f.input('下一轮不再选择文件', 'next-turn')
  expect((await f.callWithTurn('read_selected_material', { path, sha256: reference.sha256 }, turn)).status).toBe(409)
  expect((await f.call('read_selected_material', { path, sha256: reference.sha256 })).body.error).toContain('未由本轮员工选定')
  f.service.accountKey.mockResolvedValue('employee-b')
  expect((await f.call('read_selected_material', { path, sha256: reference.sha256 })).body.error).toContain('账号已变化')
})
