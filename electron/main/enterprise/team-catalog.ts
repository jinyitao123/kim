import type { EnterpriseWorkChoice } from '../../../src/types/api'
export interface TeamSummary { id: string; name: string; objective?: string }
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {} }
export function teamCatalog(value: unknown): TeamSummary[] {
  if (!Array.isArray(value)) throw new Error('Weave 返回了无法识别的团队列表')
  return value.flatMap((item) => {
    const team = record(item), name = team.display_name || team.name
    return typeof team.id === 'string' && typeof name === 'string' ? [{ id: team.id, name, ...(typeof team.objective === 'string' ? { objective: team.objective } : {}) }] : []
  })
}
export function teamChoices(team: TeamSummary, value: unknown): EnterpriseWorkChoice[] {
  const workflows = record(value).workflows
  return (Array.isArray(workflows) ? workflows : []).flatMap((item) => {
    const flow = record(item)
    return typeof flow.id === 'string' && typeof flow.name === 'string' && Number.isInteger(flow.published_version) && Number(flow.published_version) > 0
      ? [{
          teamId: team.id, teamName: team.name, teamObjective: team.objective, workflowId: flow.id, workflowName: flow.name,
          businessCapabilityIds: Array.isArray(flow.business_capability_ids) ? flow.business_capability_ids.filter((value): value is string => typeof value === 'string') : [],
          version: Number(flow.published_version), ...(typeof flow.description === 'string' ? { workflowDescription: flow.description } : {}),
        }] : []
  })
}
function terms(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fff]+/g) ?? []
  return new Set(words.flatMap((word) => /[\u4e00-\u9fff]/.test(word) && word.length > 1 ? Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2)) : [word]))
}
export function searchTeams(teams: TeamSummary[], summary: string): TeamSummary[] {
  const query = terms(summary)
  return teams.map((team) => ({ team, score: [...terms(`${team.name} ${team.objective ?? ''}`)].filter((term) => query.has(term)).length }))
    .filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.team.name.localeCompare(b.team.name)).slice(0, 8).map((item) => item.team)
}
