import type { EnterpriseBusinessCapability } from '../../src/types/api'

// One wire fixture is consumed by both the Pi bridge and the visible trial panel.
interface WireTool {
  status: string; completed_at?: string; input?: string; output?: string
  input_state?: string; output_state?: string
  input_bytes?: number; output_bytes?: number
  server_payloads?: string
}
export const trialToolAction: EnterpriseBusinessCapability = { id: 'forge:action:forge_quotation.quotation_adjust_line_price', name: '调整报价明细', description: '调整指定报价明细价格', effect: 'write', resourceType: 'forge_quotation', requiresEmployeeIntent: true, status: 'available', actionName: 'quotation_adjust_line_price', objectName: 'forge_quotation' }
export const trialWireCases: Array<WireTool & { name: string; label: string; completeness: string; hiddenInput?: boolean; hiddenOutput?: boolean; displayName?: string }> = [
  { name: 'running', status: 'running', label: '工具调用中', completeness: '不可用' },
  { name: 'completed with missing payload', status: 'ok', completed_at: '2026-10-05T02:40:30Z', label: '工具调用完成', completeness: '不可用' },
  { name: 'failed with missing payload', status: 'error', completed_at: '2026-10-05T02:40:30Z', label: '工具调用失败', completeness: '不可用' },
  { name: 'legacy completed', status: 'tool_completed', label: '工具调用完成', completeness: '不可用' },
  { name: 'legacy failed', status: 'tool_failed', label: '工具调用失败', completeness: '不可用' },
  { name: 'ok without completion phase', status: 'ok', label: '工具调用中', completeness: '不可用' },
  { name: 'saved payload', status: 'ok', completed_at: '2026-10-05T02:40:30Z', input: '{"amount":2300}', output: '{"simulated":true}', label: '工具调用完成', completeness: '完整' },
  { name: 'missing receipt', status: 'ok', completed_at: '2026-10-05T02:40:30Z', input: '{"amount":2300}', label: '工具调用完成', completeness: '部分' },
  { name: 'missing arguments', status: 'ok', completed_at: '2026-10-05T02:40:30Z', output: '{"simulated":true}', label: '工具调用完成', completeness: '部分' },
  { name: 'recorded empty contents', status: 'ok', completed_at: '2026-10-05T02:40:30Z', input: '', output: '', input_state: 'recorded', output_state: 'recorded', input_bytes: 0, output_bytes: 0, label: '工具调用完成', completeness: '完整' },
  { name: 'truncated arguments', status: 'ok', completed_at: '2026-10-05T02:40:30Z', input: '{"amount', output: '{"simulated":true}', input_state: 'truncated', output_state: 'recorded', input_bytes: 10000, output_bytes: 18, label: '工具调用完成', completeness: '部分' },
  { name: 'explicit missing with stale payload', status: 'ok', completed_at: '2026-10-05T02:40:30Z', input: '{"stale":true}', output: '{"simulated":true}', input_state: 'missing', output_state: 'recorded', hiddenInput: true, label: '工具调用完成', completeness: '部分' },
  { name: 'unknown payload state', status: 'ok', completed_at: '2026-10-05T02:40:30Z', input: '{"stale":true}', output: '{"simulated":true}', input_state: 'future-state', output_state: 'future-state', hiddenInput: true, hiddenOutput: true, label: '工具调用完成', completeness: '不可用' },
  { name: 'server partial despite visible fields', status: 'ok', completed_at: '2026-10-05T02:40:30Z', input: '{}', output: '{"simulated":true}', input_state: 'recorded', output_state: 'recorded', server_payloads: 'partial', label: '工具调用完成', completeness: '部分' },
  { name: 'server unavailable despite visible fields', status: 'ok', completed_at: '2026-10-05T02:40:30Z', input: '{}', output: '{"simulated":true}', input_state: 'recorded', output_state: 'recorded', server_payloads: 'unavailable', label: '工具调用完成', completeness: '部分' },
  { name: 'recorded action identity', status: 'ok', completed_at: '2026-10-05T02:40:30Z', input: '{"params":{"unit_price":2100}}', output: '{"actionName":"quotation_adjust_line_price","objectName":"forge_quotation","simulated":true}', input_state: 'recorded', output_state: 'recorded', label: '工具调用完成', completeness: '完整', displayName: '调整报价明细' },
]

export function trialWireActivity(tool: WireTool) {
  const terminal = tool.status === 'tool_completed' || tool.status === 'tool_failed' || Boolean(tool.completed_at)
  const stageStatus = terminal ? 'completed' : 'running'
  return {
    status: terminal ? 'succeeded' : 'running',
    completeness: { stages: 'complete', member_inputs: 'complete', member_outputs: 'complete', member_tool_activity: 'complete', member_tool_payloads: tool.server_payloads, deliverables: 'complete' },
    members: [{ name: '团队负责人', status: stageStatus, stages: [
      { name: '理解任务', node_id: 'private-node-read', status: 'completed', inputs: [], tools: [], tool_calls: 0 },
      { name: '授权转化线索', node_id: 'private-node-write', status: stageStatus, inputs: [], tools: [{ name: 'forge_forge_quotation_quotation_adjust_line_price_e602a6e1', call_id: 'private-call', status: tool.status, completed_at: tool.completed_at, input: tool.input, output: tool.output, input_state: tool.input_state, output_state: tool.output_state, input_bytes: tool.input_bytes, output_bytes: tool.output_bytes }], tool_calls: terminal ? 1 : 0 },
    ] }],
    outputs: [],
  }
}
