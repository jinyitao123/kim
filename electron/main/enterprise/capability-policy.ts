import type { EnterpriseBusinessCapabilityCatalog } from '../../../src/types/api'
import { rejectUnknownKeys, requireRecord, requireString } from '../validation'

/** The Forge canonical policy projection, never inferred from labels or MCP descriptions. */
export function parseCapabilityPolicy(value: unknown): EnterpriseBusinessCapabilityCatalog {
  const catalog = requireRecord(value, '业务能力目录')
  rejectUnknownKeys(catalog, ['version', 'provider', 'capabilities', 'refreshedAt'], '业务能力目录')
  if (catalog.version !== '1' || !Array.isArray(catalog.capabilities) || typeof catalog.refreshedAt !== 'string' || !Number.isFinite(Date.parse(catalog.refreshedAt))) throw new Error('业务能力目录无效')
  const provider = requireRecord(catalog.provider, 'provider')
  rejectUnknownKeys(provider, ['id', 'name', 'status'], 'provider')
  if (!provider.id || !provider.name || !['available', 'unavailable'].includes(String(provider.status))) throw new Error('业务能力来源无效')
  const ids = new Set<string>()
  for (const value of catalog.capabilities) {
    const item = requireRecord(value, 'capability')
    rejectUnknownKeys(item, ['id', 'name', 'description', 'effect', 'executionMode', 'resourceType', 'requiresEmployeeIntent', 'status', 'unavailableReason', 'actionName', 'objectName', 'requiresRecord', 'requiresConfirmation', 'params'], 'capability')
    const id = requireString(item.id, 'capability.id', { min: 1, max: 160 })
    if (ids.has(id) || !item.name || !item.description || !item.resourceType || !['read', 'write'].includes(String(item.effect))
      || !['available', 'unavailable'].includes(String(item.status)) || item.executionMode !== undefined && !['employee_only', 'team_delegable'].includes(String(item.executionMode))) throw new Error('业务能力执行范围无效')
    ids.add(id)
    for (const key of ['requiresEmployeeIntent', 'requiresRecord', 'requiresConfirmation']) if (item[key] !== undefined && typeof item[key] !== 'boolean') throw new Error('业务能力声明无效')
    if (item.params !== undefined) {
      if (!Array.isArray(item.params)) throw new Error('业务能力参数无效')
      const names = new Set<string>()
      for (const value of item.params) {
        const parameter = requireRecord(value, 'parameter')
        rejectUnknownKeys(parameter, ['name', 'label', 'type', 'multiple', 'required', 'description', 'enum'], 'parameter')
        const name = requireString(parameter.name, 'parameter.name', { min: 1, max: 128 })
        if (names.has(name) || parameter.type !== undefined && !['string', 'number', 'boolean', 'array', 'file'].includes(String(parameter.type))) throw new Error('业务能力参数类型无效')
        names.add(name)
        for (const key of ['multiple', 'required']) if (parameter[key] !== undefined && typeof parameter[key] !== 'boolean') throw new Error('业务能力参数声明无效')
        if (parameter.enum !== undefined && (!Array.isArray(parameter.enum) || parameter.enum.length > 100 || parameter.enum.some((v) => typeof v !== 'string'))) throw new Error('业务能力参数枚举无效')
      }
    }
  }
  return catalog as unknown as EnterpriseBusinessCapabilityCatalog
}
