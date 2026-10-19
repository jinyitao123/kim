import type { EnterpriseBusinessCapability, EnterpriseBusinessCapabilityCatalog } from '../../types/api'
import type { TeamDefinition, TeamPublicationReadiness, TeamWorkspace, DevelopmentTrialAction } from '../../types/team-workspace'
import { businessCompletionRequirement } from './business-completion'

type Workflow = TeamDefinition['workflows'][number]

export interface DevelopmentTrialSimulationChoice {
  selector: string
  action: EnterpriseBusinessCapability
}

/** The candidate members are the actual executors referenced by one workflow. */
export function workflowCandidateMemberIds(document: TeamDefinition, workflow: Workflow): string[] {
  const selected = new Set<string>()
  for (const node of workflow.graph_definition.nodes ?? []) {
    if (node.type === 'lead') {
      for (const member of document.members) if (member.configuration.role === 'avatar') selected.add(member.id)
    }
    if (node.type === 'worker' && typeof node.config?.agent_id === 'string') {
      const worker = document.members.find((member) => member.id === node.config?.agent_id && member.configuration.role === 'worker')
      if (worker) selected.add(worker.id)
    }
  }
  return document.members.filter((member) => member.relationship.enabled === true && selected.has(member.id)).map((member) => member.id)
}

/** Only Forge capabilities bound to the selected workflow candidate enter its frozen simulation scope. */
export function workflowCandidateCapabilityIds(document: TeamDefinition, workflow: Workflow): string[] {
  const memberIds = new Set(workflowCandidateMemberIds(document, workflow))
  const ids = new Set<string>()
  for (const member of document.members) {
    if (!memberIds.has(member.id)) continue
    for (const id of member.configuration.businessCapabilityIds) ids.add(id)
  }
  return [...ids]
}

function selectorForAction(action: EnterpriseBusinessCapability, actions: EnterpriseBusinessCapability[]): string {
  const sameName = actions.filter((candidate) => candidate.name === action.name)
  if (sameName.length === 1) return action.name
  const described = `${action.name}（${action.description}）`
  const sameDescription = sameName.filter((candidate) => candidate.description === action.description)
  if (sameDescription.length === 1) return described
  return `${described}（第${sameDescription.indexOf(action) + 1}项）`
}

/** Human-readable Pi selectors do not expose internal capability identifiers. */
export function workflowSimulationChoices(actions: EnterpriseBusinessCapability[]): DevelopmentTrialSimulationChoice[] {
  return actions.map((action) => ({ selector: selectorForAction(action, actions), action }))
}

export function freezeDevelopmentTrialActions(
  choices: DevelopmentTrialSimulationChoice[],
  selectedSelectors: string[],
): DevelopmentTrialAction[] {
  if (selectedSelectors.length > 32 || selectedSelectors.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new Error('本次模拟动作选择无效')
  }
  const selected = new Set(selectedSelectors)
  if (selected.size !== selectedSelectors.length) throw new Error('本次模拟动作不能重复选择')
  const allowed = new Set(choices.map((choice) => choice.selector))
  if ([...selected].some((selector) => !allowed.has(selector))) throw new Error('本次试跑选择的模拟动作不属于当前流程候选范围')
  return choices.map(({ action, selector }) => ({ ...action, simulationAuthorized: selected.has(selector) }))
}

function readableCapabilityName(id: string, catalog: EnterpriseBusinessCapabilityCatalog | undefined): string {
  return catalog?.capabilities.find((capability) => capability.id === id)?.name ?? '未识别的业务动作'
}

function hasWorkflowWriteAction(document: TeamDefinition, workflow: Workflow, catalog: EnterpriseBusinessCapabilityCatalog | undefined): boolean {
  return workflowCandidateCapabilityIds(document, workflow).some((id) => {
    const capability = catalog?.capabilities.find((item) => item.id === id)
    // Unknown candidate capabilities fail closed just like an unavailable catalog entry.
    return !capability || capability.effect === 'write'
  })
}

export function workflowTrialBlocker(workspace: TeamWorkspace): string {
  const missing = workspace.document.workflows.find((workflow) => !workspace.trials.some((trial) => trial.workflow_id === workflow.id && trial.revision === workspace.revision && trial.status === 'succeeded'))
  return missing ? `流程“${missing.name}”还需通过当前草稿的试跑。` : ''
}

function validReadiness(value: unknown): value is TeamPublicationReadiness {
  if (!value || typeof value !== 'object') return false
  const readiness = value as Partial<TeamPublicationReadiness>
  const validIds = (ids: unknown) => Array.isArray(ids) && ids.every((id) => typeof id === 'string' && id.trim().length > 0) && new Set(ids).size === ids.length
  return typeof readiness.ready === 'boolean' && Array.isArray(readiness.workflows) && readiness.workflows.every((item) => Boolean(item)
    && typeof item.workflow_id === 'string'
    && typeof item.passed === 'boolean'
    && validIds(item.required_capability_ids)
    && validIds(item.covered_capability_ids)
    && validIds(item.missing_capability_ids))
    && new Set(readiness.workflows.map((item) => item.workflow_id)).size === readiness.workflows.length
}

function sameNonEmptyIdSet(actual: string[], expected: string[]): boolean {
  const actualIds = new Set(actual), expectedIds = new Set(expected)
  return expected.length > 0 && actual.length === expected.length
    && actualIds.size === actual.length && expectedIds.size === expected.length
    && [...expectedIds].every((id) => actualIds.has(id))
}

/** Older responses remain usable for read-only flows, but never authorize a write-action publish. */
export function publicationReadinessBlocker(workspace: TeamWorkspace, catalog?: EnterpriseBusinessCapabilityCatalog): string {
  const writeWorkflows = workspace.document.workflows.filter((workflow) => hasWorkflowWriteAction(workspace.document, workflow, catalog))
  const raw = workspace.publication_readiness as unknown
  if (raw === undefined) return writeWorkflows.length ? '无法确认当前草稿的模拟回执覆盖，请刷新团队后再更新。' : ''
  if (!validReadiness(raw)) {
    return '当前草稿的服务端模拟覆盖结果无法读取，请刷新团队后再更新。'
  }
  const readiness = raw
  const expectedWorkflowIds = new Set(workspace.document.workflows.map((workflow) => workflow.id))
  if (expectedWorkflowIds.size !== workspace.document.workflows.length
    || readiness.workflows.length !== workspace.document.workflows.length
    || readiness.workflows.some((item) => !expectedWorkflowIds.has(item.workflow_id))) {
    return '服务端模拟覆盖对应的流程与当前草稿不一致，请刷新团队后再更新。'
  }
  const resultByWorkflow = new Map(readiness.workflows.map((item) => [item.workflow_id, item]))
  for (const workflow of writeWorkflows) {
    const result = resultByWorkflow.get(workflow.id)!
    let requirement: ReturnType<typeof businessCompletionRequirement>
    try {
      requirement = businessCompletionRequirement(workflow)
    } catch {
      return `流程“${workflow.name}”的当前回执要求无法核验。`
    }
    if (!requirement?.capabilities.length) return `流程“${workflow.name}”未声明必办业务动作回执。`
    if (!sameNonEmptyIdSet(result.required_capability_ids, requirement.capabilities)) {
      return `流程“${workflow.name}”的当前回执要求与服务端模拟覆盖不一致。`
    }
  }
  if (!readiness.ready) {
    for (const workflow of writeWorkflows) {
      const result = resultByWorkflow.get(workflow.id)!
      const uncovered = [...new Set([
        ...result.missing_capability_ids,
        ...result.required_capability_ids.filter((id) => !result.covered_capability_ids.includes(id)),
      ])]
      if (uncovered.length) {
        const names = uncovered.map((id) => readableCapabilityName(id, catalog))
        return `流程“${workflow.name}”尚未覆盖必办模拟回执：${names.join('、')}`
      }
      if (!result.passed) return `流程“${workflow.name}”的必办模拟回执尚未通过。`
    }
    return '服务端尚未确认当前草稿达到发布条件。'
  }
  for (const workflow of workspace.document.workflows) {
    const result = resultByWorkflow.get(workflow.id)!
    if (writeWorkflows.some((item) => item.id === workflow.id)
      && (result.required_capability_ids.some((id) => !result.covered_capability_ids.includes(id)) || result.missing_capability_ids.length)) {
      const missing = [...new Set([
        ...result.missing_capability_ids,
        ...result.required_capability_ids.filter((id) => !result.covered_capability_ids.includes(id)),
      ])].map((id) => readableCapabilityName(id, catalog))
      return `流程“${workflow.name}”尚未覆盖必办模拟回执：${missing.join('、')}`
    }
    if (!result.passed) return `流程“${workflow.name}”尚未通过服务端模拟覆盖。`
  }
  return ''
}
