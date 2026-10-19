import { randomUUID } from 'node:crypto'
import type { EnterpriseApprovalAction, EnterpriseApprovalContext } from '../../../src/types/api'
import type { NativeMcpActionArguments, NativeMcpActionAttempt } from '../enterprise'
import type { NativeInitializationActionArguments } from '../../../src/types/enterprise-initialization'

const RESERVED_ACTION_INPUTS = new Set(['actionName', 'approvalRequestId', 'itemVersion', 'sourceMaterialVersion', 'actorId', 'objectName', 'recordId', 'confirm', 'requiresConfirmation'])

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function text(value: unknown, maximum: number): string | undefined {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= maximum && !value.includes('\0')
    ? value : undefined
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function parseMcpResponse(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed) throw new Error('Forge 没有返回业务能力')
  if (trimmed.startsWith('{')) return JSON.parse(trimmed)
  const data = trimmed.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).find((line) => line && line !== '[DONE]')
  if (!data) throw new Error('Forge 返回了无法识别的业务能力')
  return JSON.parse(data)
}

interface NativeMcpActionTransport {
  fetch(init: RequestInit): Promise<{ response: Response; snapshot: unknown }>
  assertCurrentAuth(snapshot: unknown): void
  signOutIfCurrent(snapshot: unknown): Promise<void>
  assertAuthGeneration(): void
}

// These Forge errors are raised before any business write. Do not classify
// missing receipts, transport errors or post-write readback failures this way.
const INITIALIZATION_INPUT_REJECTION_CODES = new Set([
  'INITIALIZATION_INPUT_INVALID', 'INITIALIZATION_REQUIRED', 'INITIALIZATION_FIELD_INVALID',
  'INITIALIZATION_REFERENCE_REQUIRED', 'INITIALIZATION_REFERENCE_AMBIGUOUS',
  'INITIALIZATION_IDENTITY_REQUIRED', 'INITIALIZATION_IDENTITY_AMBIGUOUS',
  'INITIALIZATION_DUPLICATE', 'INITIALIZATION_ORGANIZATION_INPUT',
])
export function normalizeInitializationAttempt(attempt: NativeMcpActionAttempt): NativeMcpActionAttempt {
  return attempt.status === 'unknown' && attempt.code && INITIALIZATION_INPUT_REJECTION_CODES.has(attempt.code)
    ? { ...attempt, status: 'rejected', message: 'Forge 已拒绝本次输入；请核对原生字段并补正资料后办理。' }
    : attempt
}
const KNOWN_NATIVE_ACTION_REJECTION_CODES = new Set([
  'UNAUTHENTICATED', 'APPROVAL_CONTEXT_NOT_FOUND', 'APPROVAL_ACTION_BINDING_MISMATCH',
  'APPROVAL_ACTION_INVALID', 'APPROVAL_ACTION_FORBIDDEN', 'APPROVAL_ACTION_STALE', 'APPROVAL_ACTION_UNAVAILABLE',
  ...INITIALIZATION_INPUT_REJECTION_CODES,
])
function nativeActionErrorDetails(value: unknown): { code?: string; rejected: boolean; message?: string } {
  const envelope = record(value), result = record(envelope?.result)
  const structured = record(result?.structuredContent)
  const textValue = Array.isArray(result?.content) ? result.content.map((item) => text(record(item)?.text, 100_000)).find(Boolean) : undefined
  let textPayload: Record<string, unknown> | undefined
  if (textValue) { try { textPayload = record(JSON.parse(textValue)) } catch { /* Non-JSON MCP error text has no stable code. */ } }
  const candidates = [record(envelope?.error), record(result?.error), record(structured?.error), structured,
    record(textPayload?.error), textPayload]
  const error = candidates.find((candidate) => candidate?.code !== undefined)
  const rawCode = error?.code
  const code = typeof rawCode === 'string' ? rawCode : typeof rawCode === 'number' ? String(rawCode) : undefined
  const message = code && INITIALIZATION_INPUT_REJECTION_CODES.has(code) ? text(error?.message, 2_000) : undefined
  return { ...(code ? { code } : {}), rejected: code !== undefined && KNOWN_NATIVE_ACTION_REJECTION_CODES.has(code), ...(message ? { message } : {}) }
}

function nativeActionResult(value: unknown, args: NativeInitializationActionArguments): NativeMcpActionAttempt | undefined {
  const envelope = record(value)
  if (!envelope || !('ok' in envelope || 'action' in envelope || 'objectName' in envelope)) return undefined
  if (envelope.action !== args.actionName || envelope.objectName !== args.objectName
    || (args.recordId === undefined ? envelope.recordId != null : envelope.recordId !== args.recordId)) {
    return { status: 'unknown', message: 'Forge 原生动作回执与本次动作绑定不匹配。' }
  }
  if (envelope.ok !== true) {
    const error = nativeActionErrorDetails(envelope)
    return {
      status: error.rejected ? 'rejected' : 'unknown',
      ...(error.code ? { code: error.code } : {}),
      message: error.message ?? (error.rejected ? 'Forge 原生动作明确拒绝。' : 'Forge 原生动作返回了待核对结果。'),
    }
  }
  const receipt = record(envelope.result)
  return receipt
    ? { status: 'returned', result: receipt }
    : { status: 'unknown', message: 'Forge 原生动作没有返回可核对回执。' }
}

function booleanConfirmationSchema(value: unknown): boolean {
  const schema = record(value), properties = record(schema?.properties)
  if (schema?.type !== 'object' || !properties || schema.$ref !== undefined
    || schema.anyOf !== undefined || schema.oneOf !== undefined || schema.allOf !== undefined) {
    throw new Error('Forge 原生动作工具声明无效')
  }
  const required = schema.required
  if (!Array.isArray(required) || !required.includes('actionName') || required.some((key) => typeof key !== 'string')
    || new Set(required).size !== required.length) throw new Error('Forge 原生动作工具声明无效')
  for (const [name, type] of [['actionName', 'string'], ['objectName', 'string'], ['recordId', 'string'], ['params', 'object']]) {
    const member = record(properties[name])
    if (!member || member.type !== type || member.$ref !== undefined || member.anyOf !== undefined
      || member.oneOf !== undefined || member.allOf !== undefined || member.not !== undefined) {
      throw new Error('Forge 原生业务参数协议无效')
    }
  }
  if (!Object.hasOwn(properties, 'confirm')) {
    if (Array.isArray(required) && required.includes('confirm')) throw new Error('Forge 原生确认声明无效')
    return false
  }
  const confirm = record(properties.confirm)
  if (confirm?.type !== 'boolean' || confirm.$ref !== undefined || confirm.const !== undefined
    || confirm.anyOf !== undefined || confirm.oneOf !== undefined || confirm.allOf !== undefined
    || confirm.not !== undefined || confirm.nullable !== undefined
    || confirm.default !== undefined && typeof confirm.default !== 'boolean'
    || confirm.enum !== undefined && (!Array.isArray(confirm.enum) || confirm.enum.length !== 2
      || !confirm.enum.includes(true) || !confirm.enum.includes(false))) {
    throw new Error('Forge 原生确认字段不是严格布尔协议')
  }
  return true
}

async function readNativeConfirmationProtocol(
  assertCurrent: () => Promise<void>, transport: NativeMcpActionTransport,
): Promise<{ supported: boolean; recordRequired: boolean; snapshot: unknown }> {
  const id = `current-item-tools-${randomUUID()}`
  const { response, snapshot } = await transport.fetch({
    method: 'POST', headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' }),
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  })
  const raw = await response.text()
  transport.assertCurrentAuth(snapshot)
  transport.assertAuthGeneration()
  await assertCurrent()
  if (response.status === 401) {
    await transport.signOutIfCurrent(snapshot)
    throw new Error('Forge 登录已失效')
  }
  if (!response.ok || raw.length > 1_000_000) throw new Error('Forge 原生动作工具协议暂不可核对')
  const envelope = record(parseMcpResponse(raw)), result = record(envelope?.result)
  if (envelope?.jsonrpc !== '2.0' || envelope.id !== id || envelope.error !== undefined
    || !result || result.isError === true || !Array.isArray(result.tools) || result.nextCursor !== undefined) {
    throw new Error('Forge 原生动作工具协议暂不可完整核对')
  }
  const actions = result.tools.filter((tool) => record(tool)?.name === 'run_action')
  if (actions.length !== 1) throw new Error('Forge 原生动作工具必须唯一')
  const schema = record(record(actions[0])?.inputSchema)
  return { supported: booleanConfirmationSchema(schema), recordRequired: Array.isArray(schema?.required) && schema.required.includes('recordId'), snapshot }
}

export async function callNativeMcpRunAction(
  args: NativeMcpActionArguments, assertCurrent: () => Promise<void>, transport: NativeMcpActionTransport,
  requiresConfirmation?: boolean, assertBeforeDispatch?: () => Promise<void>,
): Promise<NativeMcpActionAttempt> {
  return callNativeAction(args, assertCurrent, transport, requiresConfirmation, assertBeforeDispatch, false)
}

/** Only initialization may invoke list_toolbar actions without a record binding. */
export async function callNativeMcpInitializationAction(
  args: NativeInitializationActionArguments, assertCurrent: () => Promise<void>, transport: NativeMcpActionTransport,
  requiresConfirmation: boolean, assertBeforeDispatch: () => Promise<void>,
): Promise<NativeMcpActionAttempt> {
  const { isInitializationAction } = await import('./initialization-catalog')
  if (!isInitializationAction(args.objectName, args.actionName)) return {
    status: 'rejected', message: '该动作不属于原生初始化入口。',
  }
  return callNativeAction(args, assertCurrent, transport, requiresConfirmation, assertBeforeDispatch, true)
}

async function callNativeAction(
  args: NativeInitializationActionArguments, assertCurrent: () => Promise<void>, transport: NativeMcpActionTransport,
  requiresConfirmation: boolean | undefined, assertBeforeDispatch: (() => Promise<void>) | undefined, optionalRecord: boolean,
): Promise<NativeMcpActionAttempt> {
  if (typeof requiresConfirmation !== 'boolean') return {
    status: 'rejected', code: 'APPROVAL_ACTION_CONFIRMATION_UNKNOWN', message: 'Forge 没有提供当前动作的明确确认声明；未发送本次业务动作。',
  }
  if (!assertBeforeDispatch) return {
    status: 'rejected', code: 'APPROVAL_ACTION_BINDING_MISMATCH', message: '本次办理缺少发送前的事项核验；未发送业务动作。',
  }
  if (!record(args) || Object.keys(args).length !== (optionalRecord && args.recordId === undefined ? 3 : 4)
    || !onlyKeys(args as unknown as Record<string, unknown>, ['actionName', 'objectName', 'recordId', 'params'])
    || !text(args.actionName, 128) || !text(args.objectName, 160) || !(optionalRecord && args.recordId === undefined || text(args.recordId, 128))
    || !record(args.params) || Object.hasOwn(args.params, 'confirm')
    || Object.hasOwn(args.params, 'requiresConfirmation')) return {
    status: 'rejected', code: 'APPROVAL_ACTION_INVALID', message: '原生确认字段不能由业务参数提供；未发送本次业务动作。',
  }
  try {
    transport.assertAuthGeneration()
    await assertCurrent()
    const protocol = await readNativeConfirmationProtocol(assertCurrent, transport)
    if (optionalRecord && args.recordId === undefined && protocol.recordRequired) return {
      status: 'rejected', message: 'Forge 原生协议仍要求业务记录，无法调用当前初始化动作。',
    }
    if (requiresConfirmation && !protocol.supported) return {
      status: 'rejected', code: 'APPROVAL_ACTION_CONFIRMATION_UNSUPPORTED', message: 'Forge 原生协议不支持本次必需确认；未发送业务动作。',
    }
    await assertBeforeDispatch()
    // A fresh context read may have yielded to sign-out or account replacement.
    transport.assertCurrentAuth(protocol.snapshot)
    transport.assertAuthGeneration()
  } catch {
    return { status: 'rejected', code: 'APPROVAL_ACTION_PROTOCOL_UNAVAILABLE', message: '发送前无法完整核对原生协议或当前事项；未发送本次业务动作。' }
  }
  const argumentsWithConfirmation = requiresConfirmation ? { ...args, confirm: true } : args
  let response: Response
  let snapshot: unknown
  try {
    ({ response, snapshot } = await transport.fetch({
      method: 'POST', headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: `current-item-action-${randomUUID()}`, method: 'tools/call', params: { name: 'run_action', arguments: argumentsWithConfirmation } }),
      redirect: 'error', signal: AbortSignal.timeout(15_000),
    }))
  } catch {
    try { transport.assertAuthGeneration() } catch { return { status: 'unknown', message: '员工账号变化，Forge动作结果待核对。' } }
    return { status: 'unknown', message: 'Forge 没有返回原生动作回执。' }
  }
  let raw: string
  try { raw = await response.text() }
  catch { return { status: 'unknown', message: 'Forge 原生动作回执无法读取。' } }
  try { transport.assertCurrentAuth(snapshot); await assertCurrent() }
  catch { return { status: 'unknown', message: '员工账号或当前事项在动作期间发生变化，结果待核对。' } }
  let parsed: unknown
  try { parsed = parseMcpResponse(raw) } catch { parsed = undefined }
  const responseError = nativeActionErrorDetails(parsed)
  if (response.status === 401) {
    await transport.signOutIfCurrent(snapshot)
    return { status: 'rejected', code: 'UNAUTHENTICATED', message: 'Forge 登录已失效，本次动作未取得执行回执。' }
  }
  if (response.status === 403) {
    if (!responseError.code || responseError.rejected) return {
      status: 'rejected', code: responseError.code ?? 'APPROVAL_ACTION_FORBIDDEN', message: 'Forge 拒绝了当前员工执行该动作。',
    }
    return { status: 'unknown', code: responseError.code, message: 'Forge 原生动作返回了待核对错误。' }
  }
  if (!response.ok) return {
    status: responseError.rejected ? 'rejected' : 'unknown',
    ...(responseError.code ? { code: responseError.code } : {}),
    message: responseError.message ?? (responseError.rejected ? 'Forge 原生动作明确拒绝。' : `Forge 原生动作服务返回 ${response.status}，结果待核对。`),
  }
  const envelope = record(parsed)
  if (!envelope) return { status: 'unknown', message: 'Forge 原生动作没有返回可核对回执。' }
  if (record(envelope.error)) return {
    status: responseError.rejected ? 'rejected' : 'unknown',
    ...(responseError.code ? { code: responseError.code } : {}),
    message: responseError.message ?? (responseError.rejected ? 'Forge 原生动作明确拒绝。' : 'Forge 原生动作返回了待核对错误。'),
  }
  const result = record(envelope.result)
  if (!result) return { status: 'unknown', message: 'Forge 原生动作没有返回可核对回执。' }
  if (result.isError === true) {
    const actionError = nativeActionErrorDetails({ result })
    return {
      status: actionError.rejected ? 'rejected' : 'unknown',
      ...(actionError.code ? { code: actionError.code } : {}),
      message: actionError.message ?? (actionError.rejected ? 'Forge 原生动作明确拒绝。' : 'Forge 原生动作返回了待核对错误。'),
    }
  }
  if (result.structuredContent !== undefined) {
    return nativeActionResult(result.structuredContent, args) ?? { status: 'returned', result: result.structuredContent }
  }
  const resultText = Array.isArray(result.content) ? result.content.map((item) => text(record(item)?.text, 100_000)).find(Boolean) : undefined
  if (!resultText) return { status: 'unknown', message: 'Forge 原生动作没有返回可核对回执。' }
  try {
    const parsedResult: unknown = JSON.parse(resultText)
    return nativeActionResult(parsedResult, args) ?? { status: 'returned', result: parsedResult }
  }
  catch { return { status: 'unknown', message: 'Forge 原生动作回执格式无法核对。' } }
}

export function parseCurrentApprovalActions(
  value: unknown, context: Pick<EnterpriseApprovalContext, 'requestId' | 'businessObject' | 'sourceMaterialVersion'>,
): EnterpriseApprovalAction[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error('Forge 当前事项动作目录格式无效')
  const seen = new Set<string>()
  return value.map((entry) => {
    const source = record(entry), execution = record(source?.execution), params = record(execution?.params)
    const semantic = source?.semantic === undefined ? undefined : text(source.semantic, 64)
    const label = text(source?.label, 160), description = text(source?.description, 1000)
    const tool = execution?.tool
    const actionName = text(execution?.actionName, 128), objectName = text(execution?.objectName, 160)
    const recordId = text(execution?.recordId, 128)
    const requiresConfirmation = execution?.requiresConfirmation
    const approvalRequestId = text(params?.approvalRequestId, 128)
    const nativeItemVersion = text(params?.itemVersion, 128)
    const sourceMaterialVersion = text(params?.sourceMaterialVersion, 64)
    const rawInputs = source?.inputs
    if (!source || !execution || !params || !label || !description
      || source.semantic !== undefined && !semantic
      || !onlyKeys(source, ['semantic', 'label', 'description', 'execution', 'inputs'])
      || !onlyKeys(execution, ['tool', 'actionName', 'objectName', 'recordId', 'params', 'requiresConfirmation'])
      || requiresConfirmation !== undefined && typeof requiresConfirmation !== 'boolean'
      || !onlyKeys(params, ['approvalRequestId', 'itemVersion', 'sourceMaterialVersion'])
      || tool !== 'run_action' || !actionName || !objectName || !recordId
      || !approvalRequestId || approvalRequestId !== context.requestId
      || nativeItemVersion === undefined || !sourceMaterialVersion || sourceMaterialVersion !== context.sourceMaterialVersion
      || objectName !== context.businessObject.objectName || recordId !== context.businessObject.recordId
      || !Array.isArray(rawInputs) || rawInputs.length !== 1) {
      throw new Error('Forge 当前事项动作与本人打开的事项不匹配，请刷新待办')
    }
    const input = record(rawInputs[0])
    const inputName = text(input?.name, 128), inputLabel = text(input?.label, 160)
    if (!input || !onlyKeys(input, ['name', 'type', 'label', 'required'])
      || !inputName || RESERVED_ACTION_INPUTS.has(inputName) || input.type !== 'string' || !inputLabel || input.required !== true) {
      throw new Error('Forge 当前事项动作输入声明暂不支持')
    }
    const identity = `${actionName}\0${objectName}\0${recordId}\0${approvalRequestId}\0${nativeItemVersion}\0${sourceMaterialVersion}`
    if (seen.has(identity)) throw new Error('Forge 当前事项动作目录包含重复项')
    seen.add(identity)
    return {
      ...(semantic ? { semantic } : {}), label, description,
      execution: {
        tool: 'run_action', actionName, objectName, recordId,
        ...(requiresConfirmation !== undefined ? { requiresConfirmation } : {}),
        params: { approvalRequestId, itemVersion: nativeItemVersion, sourceMaterialVersion },
      },
      inputs: [{ name: inputName, type: 'string', label: inputLabel, required: true }],
    }
  })
}

export interface CurrentItemActionReceipt {
  decision: string
  status: string
  businessStatus?: string
  requestId: string
  recordId: string
  itemVersion: string
  sourceMaterialVersion: string
  resumed: boolean
  autoRejected: boolean
  alreadyApplied: boolean
}

export interface CurrentItemActionObservation {
  status: 'history_observed'
  decision: 'unknown'
  observedStatus: string
  requestId: string
  recordId: string
  itemVersion: string
  sourceMaterialVersion: string
  history: Array<{ action: string; actorId: string; comment: string; createdAt?: string }>
}

export function parseCurrentItemActionObservation(value: unknown, action: EnterpriseApprovalAction): CurrentItemActionObservation | undefined {
  const envelope = record(value), result = record(envelope?.data) ?? envelope
  const decision = text(result?.decision, 128), status = text(result?.status, 128), observedStatus = text(result?.observedStatus, 128)
  const requestId = text(result?.requestId, 128), recordId = text(result?.recordId, 128)
  const nativeItemVersion = text(result?.itemVersion, 128), sourceMaterialVersion = text(result?.sourceMaterialVersion, 64)
  if (!result || status !== 'history_observed' || decision !== 'unknown' || !observedStatus
    || requestId !== action.execution.params.approvalRequestId || recordId !== action.execution.recordId
    || nativeItemVersion !== action.execution.params.itemVersion
    || sourceMaterialVersion !== action.execution.params.sourceMaterialVersion || !Array.isArray(result.history)) return undefined
  const history = result.history.map((entry) => {
    const row = record(entry), actionName = text(row?.action, 128), actorId = text(row?.actorId, 128)
    const comment = typeof row?.comment === 'string' ? row.comment : undefined
    const createdAt = row?.createdAt === undefined ? undefined : text(row.createdAt, 128)
    if (!row || !onlyKeys(row, ['action', 'actorId', 'comment', 'createdAt']) || !actionName || !actorId
      || comment === undefined || row.createdAt !== undefined && !createdAt) return undefined
    return { action: actionName, actorId, comment, ...(createdAt ? { createdAt } : {}) }
  })
  if (history.some((row) => row === undefined)) return undefined
  return {
    status: 'history_observed', decision: 'unknown', observedStatus, requestId, recordId,
    itemVersion: nativeItemVersion!, sourceMaterialVersion, history: history as CurrentItemActionObservation['history'],
  }
}

export function parseCurrentItemActionReceipt(value: unknown, action: EnterpriseApprovalAction): CurrentItemActionReceipt | undefined {
  const envelope = record(value), result = record(envelope?.data) ?? envelope
  const decision = text(result?.decision, 128), status = text(result?.status, 128)
  const businessStatus = text(result?.businessStatus, 128)
  const requestId = text(result?.requestId, 128), recordId = text(result?.recordId, 128)
  const nativeItemVersion = text(result?.itemVersion, 128), sourceMaterialVersion = text(result?.sourceMaterialVersion, 64)
  const isRecall = action.semantic === 'recall'
  const isSalesOrder = action.execution.objectName === 'forge_sales_order'
  if (!result || !decision || decision !== 'approve' && decision !== 'revise' && decision !== 'reject' && decision !== 'recall'
    || status === 'history_observed' || !status || requestId !== action.execution.params.approvalRequestId
    || recordId !== action.execution.recordId || nativeItemVersion !== action.execution.params.itemVersion
    || sourceMaterialVersion !== action.execution.params.sourceMaterialVersion
    || isSalesOrder && !businessStatus
    || isSalesOrder && action.semantic === 'approve' && decision !== 'approve'
    || isSalesOrder && action.semantic === 'reject' && decision !== 'reject'
    || isSalesOrder && decision === 'approve' && (status !== 'approved' || businessStatus !== 'active')
    || isSalesOrder && decision === 'reject' && (status !== 'rejected' || businessStatus !== 'cancelled')
    || isRecall && (decision !== 'recall' || status !== 'recalled' || businessStatus !== 'cancelled' || action.execution.actionName !== 'order_approval_mcp_recall' || action.execution.objectName !== 'forge_sales_order')
    || !isRecall && decision === 'recall'
    || typeof result.resumed !== 'boolean' || typeof result.autoRejected !== 'boolean' || typeof result.alreadyApplied !== 'boolean') {
    return undefined
  }
  return {
    decision, status, ...(isSalesOrder ? { businessStatus } : {}), requestId, recordId, itemVersion: nativeItemVersion!, sourceMaterialVersion,
    resumed: result.resumed, autoRejected: result.autoRejected, alreadyApplied: result.alreadyApplied,
  }
}
