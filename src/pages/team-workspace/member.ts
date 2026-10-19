import type { TeamDefinition } from '../../types/team-workspace'
type Member = TeamDefinition['members'][number]
export function newMember(model = ''): Member {
  return { id: crypto.randomUUID(), configuration: { displayName: '新成员', role: 'worker', engine: 'loom', runtimeId: '', model, systemPrompt: '', skillNames: [], skills: [], mcpServerIds: [], businessCapabilityIds: [], businessCapabilityBindings: [], permissionAllow: [], permissionAsk: [], permissionDeny: [], memoryEnabled: false, memoryScope: 'tenant', maxTokens: 0, maxOutputTokens: 0, stepBudget: 0, maxCostUsd: 0, toolLoopControl: null, maxToolRepeats: 0, outputSchema: '' }, relationship: { duty: '', whenToUse: '', contextInstruction: '', allowedKinds: ['consult', 'dispatch'], defaultKind: 'consult', resultRequirement: '', enabled: true } }
}

export function isSystemManagedBusinessParameter(name: string): boolean {
  return name === 'idempotency_key' || name === 'idempotencyKey'
}
