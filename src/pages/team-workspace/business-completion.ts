import type { EnterpriseBusinessCapabilityCatalog } from '../../types/api'
import type { TeamDefinition } from '../../types/team-workspace'
import { validateWorkflowResultProtocol, WORKBENCH_RESULT_PROTOCOL } from './graph'

type Workflow = TeamDefinition['workflows'][number]
const VERIFIER = 'weave.business-action-receipts'
const CHECK_ID = 'business-action-receipts'
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
function stableJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(',')}]`
  const object = record(value)
  return object ? `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJSON(object[key])}`).join(',')}}` : JSON.stringify(value) ?? 'undefined'
}

function flowMembers(document: TeamDefinition, flow: Workflow): TeamDefinition['members'] {
  return document.members.filter((member) => member.relationship.enabled === true && flow.graph_definition.nodes.some((node) => (
    node.type === 'lead' && member.configuration.role === 'avatar'
    || node.type === 'worker' && member.configuration.role === 'worker' && node.config?.agent_id === member.id
  )))
}

/** Weave refuses to publish or authorize a flow whose members can act without this check. */
export function requireDeclaredBusinessCompletion(document: TeamDefinition): void {
  for (const flow of document.workflows) {
    if (flowMembers(document, flow).some((member) => member.configuration.businessCapabilityIds.length > 0) && !businessCompletionRequirement(flow)) {
      throw new Error(`流程“${flow.name || '未命名流程'}”的成员绑定了业务动作，须先声明“已授权业务动作具备成功回执”完成检查，才能更新团队`)
    }
  }
}

export function requireBusinessCompletionBindings(document: TeamDefinition, flow: Workflow, raw: unknown, catalog: EnterpriseBusinessCapabilityCatalog): string[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 16 || raw.some((id) => typeof id !== 'string' || !id.trim()) || new Set(raw).size !== raw.length) {
    throw new Error('完成检查须指定 1 至 16 个不重复的业务动作')
  }
  const enabled = flowMembers(document, flow)
  for (const id of raw as string[]) {
    const actions = catalog.capabilities.filter((item) => item.id === id)
    if (actions.length !== 1 || actions[0].status !== 'available') throw new Error('完成检查引用了当前目录中不存在或不可用的业务动作')
    if (!enabled.some((member) => member.configuration.businessCapabilityIds.includes(id))) throw new Error(`业务动作“${actions[0].name}”尚未绑定到该流程的已启用成员；请先绑定并保存，本操作不会授予业务动作`)
  }
  return raw as string[]
}

export function businessCompletionRequirement(flow: Workflow): { capabilities: string[]; allowNeedsInput: boolean } | undefined {
  const contract = record(flow.graph_definition.delivery_contract)
  const checks = Array.isArray(contract?.required_checks) ? contract.required_checks : []
  const matching = checks.map(record).filter((item) => item?.verifier_id === VERIFIER)
  if (!matching.length) return undefined
  const check = matching[0]
  const params = record(check?.parameters)
  if (matching.length !== 1 || check?.verifier_version !== 'v1' || typeof check.id !== 'string' || !check.id.trim()
    || contract?.external_effects_check_id !== check.id || !params
    || Object.keys(params).some((key) => !['required_capability_ids', 'when_authorized', 'allow_needs_input'].includes(key))
    || params.when_authorized !== true || typeof params.allow_needs_input !== 'boolean' || !Array.isArray(params.required_capability_ids)
    || params.required_capability_ids.length < 1 || params.required_capability_ids.length > 16
    || params.required_capability_ids.some((id) => typeof id !== 'string' || !id.trim())
    || new Set(params.required_capability_ids).size !== params.required_capability_ids.length) throw new Error('已有业务动作回执检查参数或引用无效，请先核对原配置')
  return { capabilities: params.required_capability_ids as string[], allowNeedsInput: params.allow_needs_input }
}

export function requireBusinessCompletionOutput(flow: Workflow): Record<string, unknown> {
  if (flow.graph_definition.result_protocol !== WORKBENCH_RESULT_PROTOCOL) throw new Error('业务动作回执完成检查须先启用“可要求补充材料”的结果分类')
  const issue = validateWorkflowResultProtocol(flow)
  if (issue) throw new Error(`业务动作回执完成检查需要合法的结果分类：${issue}`)
  const existing = record(flow.graph_definition.delivery_contract)
  const output = record(flow.graph_definition.output_contract)!
  if (existing?.output !== undefined && stableJSON(existing.output) !== stableJSON(output)) throw new Error('既有交付要求与流程输出格式不一致，请先核对；不能覆盖原输出要求')
  return output
}

export function configureBusinessCompletion(document: TeamDefinition, flow: Workflow, raw: unknown, allowNeedsInput: unknown, catalog: EnterpriseBusinessCapabilityCatalog): Workflow['graph_definition'] {
  const capabilities = requireBusinessCompletionBindings(document, flow, raw, catalog)
  if (typeof allowNeedsInput !== 'boolean') throw new Error('完成检查须明确是否允许缺件结果交还员工')
  const graph = flow.graph_definition
  const existing = record(graph.delivery_contract)
  if (graph.delivery_contract !== undefined && !existing) throw new Error('现有交付要求格式无法识别，不能覆盖')
  if (existing && existing.version !== 1) throw new Error('现有交付要求版本无法识别，不能覆盖')
  if (existing?.required_checks !== undefined && !Array.isArray(existing.required_checks)) throw new Error('现有交付检查格式无法识别，不能覆盖')
  const checks = (existing?.required_checks ?? []) as unknown[]
  if (checks.some((check) => !record(check))) throw new Error('现有交付检查格式无法识别，不能覆盖')
  const owned = checks.map(record).filter((check) => check?.verifier_id === VERIFIER)
  if (owned.length > 1 || owned.some((check) => check?.verifier_version !== 'v1')) throw new Error('已有业务回执检查存在重复或版本冲突，请先核对原配置')
  const prior = owned[0]
  if (prior) businessCompletionRequirement(flow)
  const id = prior?.id ?? CHECK_ID
  if (typeof id !== 'string' || !id.trim()) throw new Error('已有业务回执检查缺少有效引用，不能覆盖')
  if (existing?.external_effects_check_id !== undefined && existing.external_effects_check_id !== '' && (!prior || existing.external_effects_check_id !== id)) {
    throw new Error('流程已有另一项外部业务效果检查，不能覆盖；请先核对现有交付要求')
  }
  const artifacts = Array.isArray(existing?.required_artifacts) ? existing.required_artifacts : []
  if (checks.some((check) => record(check)?.id === id && check !== prior) || artifacts.some((item) => record(item)?.id === id)) throw new Error('业务回执检查名称已被其他交付要求占用，不能覆盖')
  if (!prior && checks.length >= 128) throw new Error('现有交付检查已达上限，不能追加')
  const output = requireBusinessCompletionOutput(flow)
  const check = { ...prior, id, title: prior?.title ?? '已授权业务动作具备成功回执', verifier_id: VERIFIER, verifier_version: 'v1', parameters: {
    required_capability_ids: [...capabilities], when_authorized: true, allow_needs_input: allowNeedsInput,
  } }
  return { ...graph, delivery_contract: {
    ...(existing ?? { version: 1, coverage: 'explicit', output: structuredClone(output) }),
    ...(existing && existing.output === undefined ? { output: structuredClone(output) } : {}),
    required_checks: prior ? checks.map((item) => item === prior ? check : item) : [...checks, check],
    external_effects: 'required', external_effects_check_id: id,
  } }
}
