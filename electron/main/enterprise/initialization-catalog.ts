import type { InitializationAction, InitializationParameter } from '../../../src/types/enterprise-initialization'

type Row = Record<string, unknown>
export const row = (value: unknown): Row | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_]{0,159}$/.test(value)
const forbidden = /^(?:confirm|requires_?confirmation|actor_?id|organization_?id|tenant_?id|session|session_?id|identity|authorization|token|password|operation_?key|opkey|idempotency_?key)$/i

export function isInitializationAction(objectName: string, name: string): boolean {
  return name.startsWith('initialization_') || objectName === 'forge_opening_inbound' && name.startsWith('opening_')
}

/** list_actions is the authority for visibility, parameter types and confirmation. */
export function parseInitializationCatalog(value: unknown): InitializationAction[] {
  const envelope = row(value)
  if (!Array.isArray(envelope?.actions) || envelope.actions.length > 10_000 || envelope.hasMore === true || envelope.nextCursor) throw new Error('Forge 初始化动作目录无法完整核对')
  const seen = new Set<string>(), actions: InitializationAction[] = []
  for (const raw of envelope.actions) {
    const action = row(raw)
    if (!action || !identifier(action.name) || !identifier(action.objectName)) throw new Error('Forge 动作目录包含无效声明')
    if (!isInitializationAction(action.objectName, action.name)) continue
    const key = `${action.objectName}.${action.name}`
    if (seen.has(key)) throw new Error('Forge 初始化动作目录包含重复项')
    seen.add(key)
    if (typeof action.requiresConfirmation !== 'boolean' || typeof action.requiresRecord !== 'boolean'
      || action.params !== undefined && !Array.isArray(action.params)) throw new Error('Forge 初始化动作缺少明确调用声明')
    const names = new Set<string>()
    const params: InitializationParameter[] = (action.params as unknown[] ?? []).map(rawParam => {
      const param = row(rawParam)
      if (!param || !identifier(param.name) || typeof param.type !== 'string' || names.has(param.name)
        || param.required !== undefined && typeof param.required !== 'boolean') throw new Error('Forge 初始化参数声明无效')
      names.add(param.name)
      const options = param.options === undefined ? undefined : Array.isArray(param.options) ? param.options.map(rawOption => {
        const option = row(rawOption)
        if (!option || !['string', 'number', 'boolean'].includes(typeof option.value)) throw new Error('Forge 初始化选项声明无效')
        return { value: option.value as string | number | boolean, label: typeof option.label === 'string' ? option.label : String(option.value) }
      }) : undefined
      if (param.options !== undefined && !options) throw new Error('Forge 初始化选项声明无效')
      return { name: param.name, label: typeof param.label === 'string' ? param.label : param.name, type: param.type, required: param.required === true, ...(options ? { options } : {}) }
    })
    // Existing native readers predate an effect field in list_actions.
    const knownRead = ['initialization_readiness', 'initialization_operation_result', 'initialization_read_organization', 'initialization_organization_read'].includes(action.name)
      || action.objectName === 'forge_opening_inbound' && ['opening_inbound_read', 'opening_inbound_state'].includes(action.name)
    if (action.effect !== undefined && action.effect !== 'read' && action.effect !== 'write'
      || action.readOnly !== undefined && typeof action.readOnly !== 'boolean'
      || action.effect === 'write' && (action.readOnly === true || knownRead)
      || action.effect === 'read' && action.readOnly === false) throw new Error('Forge 初始化动作读写声明冲突')
    const effect = action.effect === 'read' || action.readOnly === true || knownRead ? 'read' : 'write'
    actions.push({ name: action.name, objectName: action.objectName, label: typeof action.label === 'string' ? action.label : action.name,
      description: typeof action.description === 'string' ? action.description : '', effect,
      requiresRecord: action.requiresRecord, requiresConfirmation: action.requiresConfirmation, params })
  }
  return actions
}

function rejectHostInputs(value: unknown): void {
  if (Array.isArray(value)) { for (const member of value) rejectHostInputs(member); return }
  const object = row(value)
  if (!object) return
  for (const [key, member] of Object.entries(object)) {
    if (forbidden.test(key)) throw new Error('操作键、确认和调用身份由桌面管理')
    rejectHostInputs(member)
  }
}

export function validateInitializationInputs(action: InitializationAction, inputs: Row, hostInputs = false): void {
  if (!hostInputs) rejectHostInputs(inputs)
  for (const key of Object.keys(inputs)) if (!action.params.some(param => param.name === key)) throw new Error('参数不在当前 Forge 动作声明中')
  for (const param of action.params) {
    if (param.name === 'operation_key' && !hostInputs) continue
    const value = inputs[param.name]
    if (value === undefined) {
      if (param.required) throw new Error(`请补充${param.label}`)
      continue
    }
    const valid = ['string', 'text', 'textarea', 'date', 'datetime', 'select', 'lookup', 'reference', 'user', 'email', 'url'].includes(param.type) ? typeof value === 'string'
      : ['number', 'integer', 'currency', 'percent'].includes(param.type) ? typeof value === 'number' && Number.isFinite(value) && (param.type !== 'integer' || Number.isInteger(value))
      : ['boolean', 'checkbox', 'toggle'].includes(param.type) ? typeof value === 'boolean'
      : ['object', 'json'].includes(param.type) ? row(value) !== undefined
      : ['array', 'multiselect'].includes(param.type) ? Array.isArray(value) : false
    if (!valid || param.options && !param.options.some(option => option.value === value)) throw new Error(`请按 Forge 声明提供${param.label}`)
    if (param.name === 'fields_json') {
      let fields: unknown
      try { fields = JSON.parse(String(value)) } catch { throw new Error('初始化资料必须是单条 JSON 对象') }
      if (!row(fields)) throw new Error('初始化资料必须是单条 JSON 对象')
      rejectHostInputs(fields)
    }
  }
}

export function canonicalInputs(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalInputs).join(',')}]`
  const object = row(value)
  if (object) return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalInputs(object[key])}`).join(',')}}`
  return JSON.stringify(value)
}
