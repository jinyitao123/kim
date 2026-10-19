import type { EnterpriseBusinessCapability } from '../types/api'

export interface TrialToolEvidence {
  status?: string
  completed_at?: string
  input?: string
  output?: string
  input_state?: 'recorded' | 'missing' | 'truncated'
  output_state?: 'recorded' | 'missing' | 'truncated'
  input_bytes?: number
  output_bytes?: number
}

export interface TrialActivityEvidence {
  completeness?: { member_tool_activity?: string; member_tool_payloads?: string }
  members?: Array<{ stages?: Array<{ status?: string; tool_calls?: number; tools?: TrialToolEvidence[] | null }> }>
}

export function trialToolStatus(tool: TrialToolEvidence): string {
  if (tool.status === 'tool_completed') return '工具调用完成'
  if (tool.status === 'tool_failed') return '工具调用失败'
  if (tool.completed_at && tool.status === 'ok') return '工具调用完成'
  if (tool.completed_at && tool.status === 'error') return '工具调用失败'
  if (['running', 'tool_started', 'ok', 'error'].includes(tool.status ?? '') && !tool.completed_at) return '工具调用中'
  return '等待更新'
}

function payloadState(tool: TrialToolEvidence, field: 'input' | 'output'): 'recorded' | 'missing' | 'truncated' {
  const state = tool[`${field}_state`]
  if (state === 'truncated' || state === 'missing') return state
  if (state === 'recorded') return typeof tool[field] === 'string' ? 'recorded' : 'missing'
  if (state !== undefined) return 'missing'
  return tool[field]?.trim() ? 'recorded' : 'missing'
}

export function trialToolPayload(tool: TrialToolEvidence, field: 'input' | 'output'): string | undefined {
  return payloadState(tool, field) === 'missing' ? undefined : tool[field]
}

/** Display names come from recorded action identity and catalog metadata, never a generated tool key. */
export function trialToolDisplayName(tool: TrialToolEvidence, capabilities: readonly EnterpriseBusinessCapability[] = []): string {
  if (payloadState(tool, 'output') === 'recorded') {
    try {
      const receipt = JSON.parse(tool.output!) as unknown
      if (receipt && typeof receipt === 'object' && !Array.isArray(receipt)) {
        const identity = receipt as { actionName?: unknown; objectName?: unknown }
        if (typeof identity.actionName === 'string' && typeof identity.objectName === 'string') {
          const matches = capabilities.filter((action) => action.actionName === identity.actionName && action.objectName === identity.objectName)
          if (matches.length === 1 && matches[0]!.name.trim()) return matches[0]!.name.trim()
        }
      }
    } catch { /* Missing or non-JSON receipts cannot identify an action. */ }
  }
  return '工具调用'
}

export function trialToolMissingDetails(tool: TrialToolEvidence): string {
  const inputState = payloadState(tool, 'input'), outputState = payloadState(tool, 'output')
  const truncated = [inputState === 'truncated' ? '调用参数' : '', outputState === 'truncated' ? '模拟回执' : ''].filter(Boolean)
  if (truncated.length) {
    const missing = [inputState === 'missing' ? '调用参数' : '', outputState === 'missing' ? '模拟回执' : ''].filter(Boolean)
    return `此调试记录的${truncated.join('和')}已截断${missing.length ? `；未保存${missing.join('和')}` : ''}`
  }
  const input = inputState === 'recorded', output = outputState === 'recorded'
  return !input && !output ? '此调试记录未保存调用参数和模拟回执' : !input ? '此调试记录未保存调用参数' : !output ? '此调试记录未保存模拟回执' : ''
}

export function toolActivityEvidence(activity?: TrialActivityEvidence): 'incomplete' | 'empty' | 'recorded' {
  if (activity?.completeness?.member_tool_activity !== 'complete' || !Array.isArray(activity.members) || activity.members.length === 0) return 'incomplete'
  const stages = activity.members.flatMap((member) => Array.isArray(member.stages) ? member.stages : [])
  if (!stages.length) return 'incomplete'
  let hasCalls = false
  for (const stage of stages) {
    if (stage.tools !== null && !Array.isArray(stage.tools)) return 'incomplete'
    if (stage.tool_calls !== undefined && (!Number.isInteger(stage.tool_calls) || stage.tool_calls < 0)) return 'incomplete'
    const tools = stage.tools ?? []
    const completed = tools.filter((tool) => ['工具调用完成', '工具调用失败'].includes(trialToolStatus(tool))).length
    if (tools.length === 0 && (stage.tool_calls ?? 0) > 0
      || ['completed', 'failed'].includes(stage.status ?? '') && (stage.tool_calls ?? 0) !== completed) return 'incomplete'
    if (tools.length > 0 || (stage.tool_calls ?? 0) > 0) hasCalls = true
  }
  return hasCalls ? 'recorded' : 'empty'
}

export function trialToolPayloadCompleteness(activity?: TrialActivityEvidence): 'complete' | 'partial' | 'unavailable' | 'not_applicable' {
  const calls = toolActivityEvidence(activity)
  if (calls === 'empty') return 'not_applicable'
  const tools = activity?.members?.flatMap((member) => member.stages?.flatMap((stage) => stage.tools ?? []) ?? []) ?? []
  if (!tools.length || tools.every((tool) => payloadState(tool, 'input') === 'missing' && payloadState(tool, 'output') === 'missing')) return 'unavailable'
  const serverComplete = activity?.completeness?.member_tool_payloads === undefined || activity.completeness.member_tool_payloads === 'complete'
  return calls === 'recorded' && serverComplete && tools.every((tool) => !trialToolMissingDetails(tool)) ? 'complete' : 'partial'
}
