import { expect, it } from 'vitest'
import { newMember } from '../../src/pages/team-workspace/member'
import { configureWorkflowResultProtocol, initialGraph, validateWorkflowResultProtocol, WORKBENCH_RESULT_PROTOCOL } from '../../src/pages/team-workspace/graph'

const member = newMember('organization-model')
member.configuration.displayName = '问题分类员'
member.relationship.resultRequirement = '按产品模块分类并标明依据'
it('configures the optional result protocol only on a final direct member and restores its text contract', () => {
  const graph = initialGraph(member)
  const flow = { id: 'flow', name: '检查', description: '', trigger_config: {}, graph_definition: graph }
  const configured = configureWorkflowResultProtocol(flow, true)
  expect(configured.graph_definition.result_protocol).toBe(WORKBENCH_RESULT_PROTOCOL)
  expect(configured.graph_definition.output_contract).toMatchObject({ type: 'json', schema: { required: ['disposition', 'summary', 'missing_items'] } })
  expect(configured.graph_definition.nodes.find((node) => node.id === 'work')?.output).toMatchObject({ type: 'json', schema: { properties: { disposition: { enum: ['complete', 'needs_input'] } } } })
  expect(validateWorkflowResultProtocol(configured)).toBeUndefined()
  expect(configureWorkflowResultProtocol(configured, false).graph_definition).toMatchObject({ output_contract: { type: 'text' } })
  expect(configureWorkflowResultProtocol(configured, false).graph_definition.result_protocol).toBeUndefined()
  expect(configured.graph_definition.result_protocol).toBe(WORKBENCH_RESULT_PROTOCOL)

  expect(() => configureWorkflowResultProtocol(flow, true, 'lead')).toThrow('直接连接交付步骤')
  // A join gathers branch results; it cannot itself state the result classification.
  const fromJoin = { ...flow, graph_definition: { ...graph,
    nodes: [...graph.nodes.filter((node) => node.type !== 'deliver'), { id: 'join', type: 'join', label: '汇总分支', config: { policy: 'all_success' } },
      { id: 'deliver', type: 'deliver', label: '交付结果', config: { result: { source: 'node_output', node_id: 'join', path: '' } } }],
    edges: [{ id: 'a', from_node_id: 'lead', to_node_id: 'work', route: 'success' }, { id: 'b', from_node_id: 'work', to_node_id: 'join', route: 'join' }, { id: 'c', from_node_id: 'join', to_node_id: 'deliver', route: 'success' }] } }
  expect(() => configureWorkflowResultProtocol(fromJoin, true)).toThrow('并行汇合后添加负责人或成员汇总步骤')

  const custom = { ...flow, graph_definition: { ...graph, output_contract: { type: 'json', schema: { type: 'object' } } } }
  expect(() => configureWorkflowResultProtocol(custom, true)).toThrow('桌面不会覆盖它')
  const changedContract = { ...configured, graph_definition: { ...configured.graph_definition, output_contract: { type: 'json', schema: { type: 'object' } } } }
  expect(() => configureWorkflowResultProtocol(changedContract, false)).toThrow('保留现有格式')
  expect(changedContract.graph_definition.output_contract).toEqual({ type: 'json', schema: { type: 'object' } })
})
