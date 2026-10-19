import type { InitializationAction, NativeInitializationActionArguments } from '../../../src/types/enterprise-initialization'
import type { NativeMcpActionAttempt } from '../enterprise'
import { digest, HandoffStore, submissionUUID } from './handoff-store'
import { rejectUnknownKeys, requireString } from '../validation'
import { canonicalInputs, row, validateInitializationInputs } from './initialization-catalog'
import { normalizeInitializationAttempt } from './approval-actions'

type Row = Record<string, unknown>
interface Operation {
  identity: string; slot: string; action: InitializationAction; operationKey: string
  attempt: NativeMcpActionAttempt
}
interface Receipts { accountKey: string; session: string; operations: Operation[] }
const RECEIPT_READ_LIMIT = 20
function unsettled(operation: Operation): boolean {
  return normalizeInitializationAttempt(operation.attempt).status === 'unknown' || operation.attempt.status === 'returned'
    && ['unknown', 'in_progress', 'in_doubt', 'uncertain'].includes(String(row(operation.attempt.result)?.status))
}
export interface InitializationScope {
  accountKey: string; sessionPath: string; messageId: string; employeePrompt: string
  list(): Promise<InitializationAction[]>
  run(args: NativeInitializationActionArguments, assertCurrent: () => Promise<void>, requiresConfirmation: boolean,
    assertBeforeDispatch: () => Promise<void>): Promise<NativeMcpActionAttempt>
  store: HandoffStore; assertCurrent(): Promise<void>
  reserveMutation(): void
}

const queues = new WeakMap<HandoffStore, Map<string, Promise<unknown>>>()
async function serialized<T>(scope: InitializationScope, key: string, work: () => Promise<T>): Promise<T> {
  let pending = queues.get(scope.store)
  if (!pending) { pending = new Map(); queues.set(scope.store, pending) }
  const prior = pending.get(key)
  const next = (prior ? prior.catch(() => {}) : Promise.resolve()).then(work)
  pending.set(key, next)
  try { return await next } finally { if (pending.get(key) === next) pending.delete(key) }
}

function view(attempt: NativeMcpActionAttempt, label: string): Row {
  if (attempt.status !== 'returned') return { version: '1', status: attempt.status, actionLabel: label,
    summary: attempt.status === 'rejected' ? attempt.message ?? 'Forge 未接受本次初始化动作。' : '本次结果待核对，请沿原操作查询。' }
  const result = row(attempt.result)
  if (!result) return { version: '1', status: 'unknown', actionLabel: label, summary: '本次结果待核对，请沿原操作查询。' }
  const { operationId: _id, operation_key: _key, nativeRequestDigest: _digest, ...publicResult } = result
  return { ...publicResult, actionLabel: label }
}

function selected(actions: InitializationAction[], objectName: string, name: string): InitializationAction {
  const action = actions.find(entry => entry.objectName === objectName && entry.name === name)
  if (!action) throw new Error('该动作不在本人当前 Forge 初始化目录中')
  return action
}

async function invoke(scope: InitializationScope, action: InitializationAction, params: Row, recordId?: string): Promise<NativeMcpActionAttempt> {
  return scope.run({ actionName: action.name, objectName: action.objectName, ...(recordId ? { recordId } : {}), params },
    scope.assertCurrent, action.requiresConfirmation, async () => {
      await scope.assertCurrent()
      const current = selected(await scope.list(), action.objectName, action.name)
      if (canonicalInputs(current) !== canonicalInputs(action)) throw new Error('Forge 动作声明已变化，请重新读取要求')
      validateInitializationInputs(current, params, true)
      await scope.assertCurrent()
    })
}

async function receipt(scope: InitializationScope, actions: InitializationAction[], operation: Operation): Promise<Row> {
  await scope.assertCurrent()
  operation.attempt = normalizeInitializationAttempt(operation.attempt)
  if (operation.attempt.status === 'rejected') return view(operation.attempt, operation.action.label)
  if (!operation.action.params.some(param => param.name === 'operation_key')) return view(operation.attempt, operation.action.label)
  const action = actions.find(entry => entry.objectName === operation.action.objectName && entry.name === 'initialization_operation_result')
    ?? actions.find(entry => entry.name === 'initialization_operation_result')
  if (!action || action.effect !== 'read' || action.requiresRecord) return view({ status: 'unknown' }, operation.action.label)
  try {
    const attempt = await invoke(scope, action, { operation_key: operation.operationKey })
    if (attempt.status === 'returned') operation.attempt = attempt
    return view(attempt, operation.action.label)
  }
  catch { await scope.assertCurrent(); return view({ status: 'unknown' }, operation.action.label) }
}

/** Native actions own validation, transactions and approval. Host only retains original receipts. */
export async function dispatchInitialization(method: string, params: Row, scope: InitializationScope): Promise<Row> {
  if (method === 'initialization_list') {
    rejectUnknownKeys(params, ['turn_key'], 'initialization list')
    const actions = await scope.list()
    await scope.assertCurrent()
    return { version: '1', actions: actions.map(action => ({ ...action, params: action.params.filter(param => param.name !== 'operation_key'),
      ...(action.params.some(param => param.name === 'operation_key') ? { hostManagedOperation: true } : {}) })) }
  }
  if (method !== 'initialization_run') throw new Error('请读取原生初始化目录后调用相应动作')
  rejectUnknownKeys(params, ['turn_key', 'object_name', 'action_name', 'record_id', 'inputs_json', 'employee_request'], 'initialization run')
  const objectName = requireString(params.object_name, 'object_name', { min: 1, max: 160 })
  const actionName = requireString(params.action_name, 'action_name', { min: 1, max: 128 })
  const recordId = params.record_id === undefined ? undefined : requireString(params.record_id, 'record_id', { min: 1, max: 128 })
  let inputs: Row | undefined
  try { inputs = row(JSON.parse(params.inputs_json === undefined ? '{}' : requireString(params.inputs_json, 'inputs_json', { min: 2, max: 500_000 }))) }
  catch { throw new Error('请按原生声明提供 JSON 参数对象') }
  if (!inputs) throw new Error('请按原生声明提供 JSON 参数对象')
  const actions = await scope.list(), action = selected(actions, objectName, actionName)
  await scope.assertCurrent()
  if (action.requiresRecord !== Boolean(recordId)) throw new Error(action.requiresRecord ? '该原生动作需要明确的业务记录' : '该原生动作不接收业务记录编号')
  validateInitializationInputs(action, inputs)
  if (typeof inputs.fields_json === 'string') inputs.fields_json = canonicalInputs(JSON.parse(inputs.fields_json))
  if (action.effect === 'read' && action.name !== 'initialization_operation_result') return view(await invoke(scope, action, inputs, recordId), action.label)
  const session = digest(scope.sessionPath), key = `native-initialization:${scope.accountKey}:${session}`
  const fingerprint = digest(key), fixedInputs = inputs
  return serialized(scope, key, async () => {
    await scope.assertCurrent()
    const saved = await scope.store.inspect<Receipts>(key)
    const receipts = saved?.value ?? { accountKey: scope.accountKey, session, operations: [] }
    if (receipts.accountKey !== scope.accountKey || receipts.session !== session) throw new Error('原操作不属于当前账号和会话')
    const recover = async (operation: Operation) => {
      const result = await receipt(scope, actions, operation)
      await scope.assertCurrent()
      await scope.store.checkpoint(key, fingerprint, receipts)
      return result
    }
    if (action.name === 'initialization_operation_result') {
      const operations: Row[] = []
      for (const operation of receipts.operations.slice(-RECEIPT_READ_LIMIT).reverse()) operations.push(await receipt(scope, actions, operation))
      await scope.assertCurrent()
      if (operations.length) await scope.store.checkpoint(key, fingerprint, receipts)
      return { version: '1', operations, summary: operations.length ? `已核对本会话最近${operations.length}项原初始化操作。` : '本会话尚无初始化操作。' }
    }
    if (params.employee_request !== scope.employeePrompt || !scope.employeePrompt.trim()) throw new Error('请绑定管理员当前消息，不沿用其他轮次授权')
    scope.reserveMutation()
    const slot = canonicalInputs({ objectName, actionName, recordId: recordId ?? '' })
    const messageId = requireString(scope.messageId, 'employee message', { min: 1, max: 1_000 })
    const identity = digest(canonicalInputs({ slot, messageId, inputs: fixedInputs }))
    const prior = receipts.operations.find(entry => entry.identity === identity)
    if (prior) return recover(prior)
    const pendingOriginal = receipts.operations.find(entry => entry.slot === slot && unsettled(entry))
    if (pendingOriginal) return { ...await recover(pendingOriginal), originalOperation: true, submitted: false,
      summary: '已核对原操作；本次变更资料尚未发送，请按原回执继续。' }
    if (receipts.operations.length >= 1_000) throw new Error('本会话初始化操作已达上限，请先核对原结果')
    const operation: Operation = { identity, slot, action, operationKey: submissionUUID(`${key}:${identity}`), attempt: { status: 'unknown' } }
    receipts.operations.push(operation)
    // Persist the original key before any POST. A lost reply never creates a new request.
    await scope.store.checkpoint(key, fingerprint, receipts)
    await scope.assertCurrent()
    const nativeInputs = { ...fixedInputs, ...(action.params.some(param => param.name === 'operation_key') ? { operation_key: operation.operationKey } : {}) }
    try { operation.attempt = await invoke(scope, action, nativeInputs, recordId) }
    catch { operation.attempt = { status: 'unknown' } }
    await scope.assertCurrent()
    await scope.store.checkpoint(key, fingerprint, receipts)
    return view(operation.attempt, action.label)
  })
}
