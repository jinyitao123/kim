import type { TeamDefinition, TeamWorkspaceCommand } from '../../../src/types/team-workspace'

// Only configuration keys are translated. Graph bindings and schema keys belong
// to Weave and must survive editing without desktop reinterpretation.
function keys(value: unknown, convert: (key: string) => string): unknown {
  if (Array.isArray(value)) return value.map((item) => keys(item, convert))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [convert(key), key === 'output_schema' || key === 'outputSchema' ? item : keys(item, convert)]))
}
function documentToWire(doc: TeamDefinition) {
  return { ...doc, members: doc.members.map((member) => {
    const { businessCapabilityBindings, ...configuration } = member.configuration
    return { ...member,
      configuration: keys({ ...configuration,
        ...(businessCapabilityBindings.length ? { businessCapabilityBindings } : {}),
        outputSchema: member.configuration.outputSchema.trim() ? JSON.parse(member.configuration.outputSchema) : null,
      }, (key) => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)),
      relationship: keys(member.relationship, (key) => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)),
    }
  }) }
}
export async function teamWorkspaceRequest(command: TeamWorkspaceCommand, read: (path: string) => Promise<unknown>, write: (path: string, method: 'POST' | 'PUT' | 'DELETE', body?: unknown) => Promise<{ body: unknown }>, forgeSession?: () => string | undefined) {
  if (command?.action === 'guide') return read(command.topic ? `/v1/development/operations/${encodeURIComponent(command.topic)}` : '/v1/development/operations')
  if (command?.action === 'create') return (await write('/v1/development/teams', 'POST', { request_id: command.requestId, name: command.name, objective: command.objective, kind: command.kind ?? 'business' })).body
  if (command?.action === 'model-providers') return read('/v1/development/model-providers')
  if (command?.action === 'import') return (await write('/v1/development/teams/import', 'POST', { request_id: command.requestId, package: command.package })).body
  // What these operations are, who may do them and what they need is Weave's to say.
  if (command?.action === 'workspace-guide') return read(command.topic ? `/v1/development/workspace-operations/${encodeURIComponent(command.topic)}` : '/v1/development/workspace-operations')
  if (command?.action === 'workspace-apply') {
    return (await write('/v1/development/workspace-operations', 'POST', {
      operation: command.operation, confirmed: command.confirmed === true, interactive: true,
      ...(command.secrets && Object.keys(command.secrets).length ? { secrets: command.secrets } : {}),
      ...(command.forgeSession ? { forge_token: forgeSession?.() } : {}),
    })).body
  }
  if (command?.action === 'configure-model-provider') {
    return (await write(`/v1/development/model-providers/${encodeURIComponent(command.provider)}`, 'PUT', {
      name: command.name, base_url: command.baseUrl, models: command.models, ...(command.apiKey ? { api_key: command.apiKey } : {}),
    })).body
  }
  if (!command || typeof command.teamId !== 'string' || !command.teamId.trim()) throw new Error('请选择团队')
  const base = `/v1/teams/${encodeURIComponent(command.teamId)}/development`
  let result: unknown
  switch (command.action) {
    case 'get': result = await read(base); break
    case 'save': result = (await write(base, 'PUT', { expected_revision: command.revision, document: documentToWire(command.document) })).body; break
    case 'publish': result = (await write(`${base}/publish`, 'POST', { revision: command.revision })).body; break
    // Weave resolves the names in these edits and validates the result itself.
    case 'operations': return (await write(`${base}/operations`, 'POST', { expected_revision: command.revision, request_id: command.requestId, dry_run: command.dryRun, operations: command.operations })).body
    case 'trial': return (await write(`${base}/trials`, 'POST', {
      revision: command.revision, workflow_id: command.workflowId, request_id: command.requestId, input: command.input,
      business_actions: command.businessActions.map((action) => ({
        capability_id: action.id, name: action.actionName, object_name: action.objectName, label: action.name,
        description: action.description, requires_record: action.requiresRecord === true,
        requires_confirmation: action.requiresConfirmation === true, params: action.params ?? [],
        simulation_authorized: action.simulationAuthorized === true,
      })),
    })).body
    case 'input': return read(`${base}/trials/${encodeURIComponent(command.requestId)}/input`)
    case 'export': return read(`${base}/export`)
    case 'activity': {
      const activity = await read(`/v1/runs/${encodeURIComponent(command.runId)}/activity`) as { deliverables?: Array<{ id: string }> }
      const outputs = await Promise.all((activity.deliverables ?? []).map((item) => read(`/v1/deliverables/${encodeURIComponent(item.id)}`)))
      return { ...activity, outputs }
    }
    // Every trial output is kept whole; the activity carries the first page as previews.
    case 'trial-outputs': return read(`/v1/runs/${encodeURIComponent(command.runId)}/trial-outputs?offset=${command.offset}`)
    case 'trial-output': return read(`/v1/runs/${encodeURIComponent(command.runId)}/trial-outputs/${encodeURIComponent(command.outputId)}`)
    case 'delete': return (await write(`${base}/team`, 'DELETE')).body
    default: throw new Error('无法识别的团队操作')
  }
  type WireDocument = { members?: Array<{ configuration: Record<string, unknown>; relationship: unknown }> }
  const response = result as { document?: WireDocument; published_document?: WireDocument }
  if (!response?.document?.members) throw new Error('Weave 返回的团队草稿不完整')
  const decode = (doc: WireDocument) => ({ ...doc, members: (doc.members ?? []).map((member) => {
    const schema = member.configuration.output_schema
    const configuration = keys(member.configuration, (key) => key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())) as Record<string, unknown>
    for (const field of ['skillNames', 'skills', 'mcpServerIds', 'businessCapabilityIds', 'businessCapabilityBindings', 'permissionAllow', 'permissionAsk', 'permissionDeny']) if (!Array.isArray(configuration[field])) configuration[field] = []
    return { ...member,
      configuration: { ...configuration, outputSchema: schema == null ? '' : JSON.stringify(schema, null, 2) },
      relationship: keys(member.relationship, (key) => key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())),
    }
  }) })
  return { ...response, document: decode(response.document), ...(response.published_document ? { published_document: decode(response.published_document) } : {}) }
}
