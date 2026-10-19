import type { EnterpriseWorkflowGraphDefinition as Graph } from '../../types/api'
import type { TeamDefinition } from '../../types/team-workspace'
export type Step = Graph['nodes'][number]
export type Binding = { value: { source: string; node_id?: string; path: string }; expected_type: string }

export const WORKBENCH_RESULT_PROTOCOL = 'workbench_result_v1' as const
export const WORKBENCH_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['disposition', 'summary', 'missing_items'],
  properties: {
    disposition: { type: 'string', enum: ['complete', 'needs_input'] },
    summary: { type: 'string' },
    missing_items: { type: 'array', items: { type: 'string' } },
  },
} as const

type Workflow = TeamDefinition['workflows'][number]

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function stableJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(',')}]`
  const item = record(value)
  if (item) return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${stableJSON(item[key])}`).join(',')}}`
  return JSON.stringify(value) ?? 'undefined'
}

function protocolOutput(type: unknown, schema: unknown): boolean {
  return type === 'json' && stableJSON(schema) === stableJSON(WORKBENCH_RESULT_SCHEMA)
}

function isPlainTextOutput(value: unknown): boolean {
  const output = record(value)
  return output?.type === 'text' && output.schema === undefined
}

export function validateWorkflowResultProtocol(flow: Workflow): string | undefined {
  const graph = flow.graph_definition
  if (graph.result_protocol === undefined) return undefined
  if (graph.result_protocol !== WORKBENCH_RESULT_PROTOCOL) return '流程使用了桌面暂不支持的结果分类协议。'
  const outputContract = record(graph.output_contract)
  if (!protocolOutput(outputContract?.type, outputContract?.schema)) return '结果分类与流程输出格式不一致，请重新选择结果分类。'
  const delivery = graph.nodes.find((node) => node.type === 'deliver')
  if (!delivery) return '流程缺少交付步骤。'
  const sourceId = String((delivery?.config?.result as { node_id?: unknown } | undefined)?.node_id ?? '')
  const source = graph.nodes.find((node) => node.id === sourceId)
  if (!source || !['lead', 'worker'].includes(source.type)) {
    return '当前交付来源不能生成结果分类。请在并行汇合后添加负责人或成员汇总步骤，并选择该步骤作为交付来源。'
  }
  const deliveryEdges = graph.edges.filter((edge) => edge.from_node_id === sourceId)
  if (deliveryEdges.length !== 1 || deliveryEdges[0]?.to_node_id !== delivery.id) {
    return '结果分类只能由直接连接交付步骤的负责人或成员生成。请把最终汇总成员设为交付来源；中间步骤仍需保持原有输出格式。'
  }
  const output = record(source.output)
  if (!protocolOutput(output?.type, output?.schema)) return '最终交付成员的输出格式与结果分类不一致，请重新选择结果分类。'
  return undefined
}

/** Applies the optional result protocol and delivery-source selection to one workflow draft. */
export function configureWorkflowResultProtocol(
  flow: Workflow,
  enabled: boolean,
  deliverySourceId?: string,
  previousDeliverySourceId?: string,
): Workflow {
  const graph = structuredClone(flow.graph_definition)
  if (graph.result_protocol !== undefined && graph.result_protocol !== WORKBENCH_RESULT_PROTOCOL) {
    throw new Error('流程使用了桌面暂不支持的结果分类协议。')
  }
  const wasEnabled = graph.result_protocol === WORKBENCH_RESULT_PROTOCOL
  const delivery = graph.nodes.find((node) => node.type === 'deliver')
  if (!delivery) throw new Error('流程缺少交付步骤。')
  const currentSourceId = String((delivery.config?.result as { node_id?: unknown } | undefined)?.node_id ?? '')
  const previousSourceId = previousDeliverySourceId ?? currentSourceId
  const nextSourceId = deliverySourceId ?? currentSourceId
  const nextSource = graph.nodes.find((node) => node.id === nextSourceId)
  if (!nextSource || !predecessors(graph, delivery.id).some((node) => node.id === nextSourceId)) {
    throw new Error('交付来源必须是当前流程的前序步骤。')
  }

  if (wasEnabled && (deliverySourceId && deliverySourceId !== currentSourceId || previousDeliverySourceId && previousDeliverySourceId !== currentSourceId)) {
    const outputContract = record(graph.output_contract)
    if (!protocolOutput(outputContract?.type, outputContract?.schema)) throw new Error('当前结果分类格式已被其他配置修改，桌面保留现有格式并停止切换。')
    const previous = graph.nodes.find((node) => node.id === previousSourceId)
    if (previous && ['lead', 'worker'].includes(previous.type)) {
      const previousOutput = record(previous.output)
      if (protocolOutput(previousOutput?.type, previousOutput?.schema)) {
        graph.nodes = graph.nodes.map((node) => node.id === previous.id ? { ...node, output: { type: 'text' } } : node)
      }
    }
  }

  graph.nodes = graph.nodes.map((node) => node.type === 'deliver' ? {
    ...node,
    config: { ...node.config, result: { source: 'node_output', node_id: nextSourceId, path: '' } },
  } : node)

  if (enabled) {
    if (!['lead', 'worker'].includes(nextSource.type)) {
      throw new Error('当前交付来源不能生成结果分类。请在并行汇合后添加负责人或成员汇总步骤，并选择该步骤作为交付来源。')
    }
    const outputContract = record(graph.output_contract)
    if (!wasEnabled && !isPlainTextOutput(graph.output_contract)) {
      throw new Error('当前流程已有其他输出格式，桌面不会覆盖它；请先恢复普通文本输出再启用结果分类。')
    }
    const sourceOutput = nextSource.output
    const sourceOutputIsProtocol = protocolOutput(record(sourceOutput)?.type, record(sourceOutput)?.schema)
    if (!wasEnabled && sourceOutput !== undefined && !isPlainTextOutput(sourceOutput)
      || wasEnabled && nextSourceId !== previousSourceId && sourceOutputIsProtocol
      || wasEnabled && nextSourceId === previousSourceId && sourceOutput !== undefined && !isPlainTextOutput(sourceOutput) && !sourceOutputIsProtocol) {
      throw new Error('当前交付成员已有其他输出格式，桌面不会覆盖它；请先恢复普通文本输出再启用结果分类。')
    }
    if (wasEnabled && outputContract && !protocolOutput(outputContract.type, outputContract.schema)) {
      throw new Error('结果分类与流程输出格式不一致，请重新选择结果分类。')
    }
    graph.result_protocol = WORKBENCH_RESULT_PROTOCOL
    graph.output_contract = { type: 'json', schema: WORKBENCH_RESULT_SCHEMA }
    graph.nodes = graph.nodes.map((node) => {
      if (node.id === nextSourceId) return { ...node, output: { type: 'json', schema: WORKBENCH_RESULT_SCHEMA } }
      if (wasEnabled && record(node.output) && protocolOutput(record(node.output)?.type, record(node.output)?.schema)) return { ...node, output: { type: 'text' } }
      return node
    })
    const nextFlow = { ...flow, graph_definition: graph }
    const issue = validateWorkflowResultProtocol(nextFlow)
    if (issue) throw new Error(issue)
    return nextFlow
  }

  if (wasEnabled) {
    const outputContract = record(graph.output_contract)
    if (!protocolOutput(outputContract?.type, outputContract?.schema)) {
      throw new Error('当前结果分类格式已被其他配置修改，桌面保留现有格式并停止切换。')
    }
    const source = graph.nodes.find((node) => node.id === currentSourceId)
    if (source && ['lead', 'worker'].includes(source.type) && source.output !== undefined
      && !isPlainTextOutput(source.output) && !protocolOutput(record(source.output)?.type, record(source.output)?.schema)) {
      throw new Error('当前交付成员已有其他输出格式，桌面保留现有格式并停止切换。')
    }
    delete graph.result_protocol
    graph.output_contract = { type: 'text' }
    const sourceOutput = record(source?.output)
    if (source && ['lead', 'worker'].includes(source.type) && protocolOutput(sourceOutput?.type, sourceOutput?.schema)) {
      graph.nodes = graph.nodes.map((node) => node.id === source.id ? { ...node, output: { type: 'text' } } : node)
    }
  }
  return { ...flow, graph_definition: graph }
}

export function bindings(step: Step): Record<string, Binding> { return (step.inputs ?? {}) as Record<string, Binding> }
export function originalBinding(): Binding { return { value: { source: 'run_input', path: '' }, expected_type: 'text' } }
export function predecessors(graph: Graph, id: string): Step[] {
  const found = new Set<string>()
  const visit = (to: string) => { for (const edge of graph.edges.filter((e) => e.to_node_id === to)) { if (!found.has(edge.from_node_id)) { found.add(edge.from_node_id); visit(edge.from_node_id) } } }
  visit(id)
  return graph.nodes.filter((n) => found.has(n.id) && ['lead', 'worker', 'join'].includes(n.type))
}
export function initialGraph(member: TeamDefinition['members'][number]): Graph {
  return { schema_version: 1, entry_node_id: 'lead', input_contract: { type: 'text' }, output_contract: { type: 'text' }, nodes: [
    { id: 'lead', type: 'lead', label: '理解任务', config: { instruction: '理解任务输入与团队目标，明确分工和输出要求。' }, inputs: { original: originalBinding() }, output: { type: 'text' } },
    { id: 'work', type: 'worker', label: member.configuration.displayName, config: { kind: 'consult', agent_id: member.id, agent_version: 1, result_requirement: member.relationship.resultRequirement || '按照成员职责处理任务输入，返回结果和依据。' }, inputs: { original: originalBinding(), brief: { value: { source: 'node_output', node_id: 'lead', path: '' }, expected_type: 'text' } }, output: { type: 'text' } },
    { id: 'deliver', type: 'deliver', label: '交付结果', config: { result: { source: 'node_output', node_id: 'work', path: '' } } },
  ], edges: [{ id: 'a', from_node_id: 'lead', to_node_id: 'work', route: 'success' }, { id: 'b', from_node_id: 'work', to_node_id: 'deliver', route: 'success' }] }
}
