import type { EnterpriseTaskScopeDisplay, EnterpriseWorkChoice } from '../../../src/types/api'

/** Product copy comes from the frozen Host request and Forge catalog labels. */
export function taskScopeDisplay(input: {
  choice: EnterpriseWorkChoice
  authorizedBusinessCapabilityIds: string[]
  businessContext?: { name: string }
  materials: Array<{ name: string }>
  reusedMaterials?: Array<{ name: string }>
}, runReference: string, actionLabels: Map<string, string>): EnterpriseTaskScopeDisplay {
  const readable = (value: string | undefined, fallback: string) => value?.trim() && !/[0-9a-f]{8}-[0-9a-f-]{27,}|^forge:action:/i.test(value) ? value.trim() : fallback
  return {
    version: '1', source: 'workbench-host', runReference,
    team: readable(input.choice.teamName, '本次选定团队'), workflow: readable(input.choice.workflowName, '本次团队工作'),
    reads: ['本次员工工作内容', ...(input.businessContext ? [readable(input.businessContext.name, '本次选定业务记录')] : []),
      ...[...(input.reusedMaterials ?? []), ...input.materials].map((material) => readable(material.name, '本次工作材料'))],
    writes: input.authorizedBusinessCapabilityIds.map((id) => readable(actionLabels.get(id), '本次选定业务动作')),
  }
}
