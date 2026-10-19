import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EmployeeBusinessActions, type EmployeeBusinessTurn } from '../../electron/main/enterprise/employee-business-actions'
import { EmployeeBusinessReadAPI } from '../../electron/main/enterprise/employee-business-read-api'
import { creationSelection } from '../../electron/main/enterprise/employee-business-creation'
import { canonicalBusinessJSON, employeeBusinessRequestDigest, parseEmployeeBusinessContext, validateEmployeeBusinessLineItems } from '../../electron/main/enterprise/employee-business-contract'
import { HandoffStore, digest } from '../../electron/main/enterprise/handoff-store'
import type { EmployeeBusinessContext, EmployeeBusinessOperation, EmployeeBusinessRequest } from '../../src/types/employee-business'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
function creation(): Extract<EmployeeBusinessContext, { objectName: unknown }> {
  return { version: '1', contextId: '10000000-0000-4000-8000-000000000001', contextVersion: 'a'.repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString(), readOnly: true,
    source: { kind: 'creation' }, objectName: 'forge_quotation', objectLabel: '报价',
    actions: [{ action_ref: 1, capabilityId: 'forge:action:forge_quotation.sales_quotation_draft_create', declarationVersion: 'b'.repeat(64), label: '创建报价', description: '创建本人报价草稿', effect: 'write', executionMode: 'employee_only', requiresRecord: false,
      parameters: [{ name: 'name', label: '报价名称', type: 'string', required: true }, { name: 'customer_id', label: '客户', type: 'string', required: true, enum: ['customer-a'], enumLabels: [{ value: 'customer-a', label: '客户甲' }] }],
      lineItems: { minItems: 1, maxItems: 100, fields: [
        { name: 'line_type', label: '行类型', type: 'string', required: true, enum: ['service', 'material'], enumLabels: [{ value: 'service', label: '服务' }, { value: 'material', label: '物料' }] },
        { name: 'name', label: '名称', type: 'string', required: true }, { name: 'sku_id', label: 'SKU', type: 'string', required: false },
        { name: 'quantity', label: '数量', type: 'number', required: true, minimum: 0.001 }, { name: 'taxed_unit_price', label: '含税单价', type: 'number', required: true, minimum: 0 },
        { name: 'tax_rate', label: '税率', type: 'number', required: true, minimum: 0, maximum: 100 }, { name: 'discount_rate', label: '折扣', type: 'number', required: true, minimum: 0, maximum: 100 },
      ] },
    }] }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'employee-create-')); directories.push(directory)
  const context = creation(); let sent: EmployeeBusinessRequest | undefined
  const service = {
    getEmployeeBusinessContext: vi.fn(async () => structuredClone(context)),
    executeEmployeeBusinessAction: vi.fn(async (request: EmployeeBusinessRequest): Promise<EmployeeBusinessOperation> => {
      sent = request; return { version: '1', operationId: request.opKey, contextId: request.contextId, requestDigest: employeeBusinessRequestDigest(request), status: 'succeeded', repeated: false, updatedAt: new Date().toISOString(),
        recordReferences: [{ objectName: 'forge_quotation', recordId: 'real-new-quotation', label: 'QT-001 报价甲' }] }
    }),
    getEmployeeBusinessOperation: vi.fn(async (): Promise<EmployeeBusinessOperation> => { throw new Error('unavailable') }),
    stageWorkMaterials: vi.fn(async () => []),
  }
  const bridge = new EmployeeBusinessActions(service, new HandoffStore({ directory }))
  const turn: EmployeeBusinessTurn = { accountKey: 'actor-a', sessionPath: '/actor-a/session', messageId: 'new-message', cwd: directory, employeePrompt: '请创建报价甲，客户甲，实施服务2项，含税单价100，税率0，折扣100。', materials: [], readOnly: false, assertCurrent: vi.fn(async () => undefined), presentRecord: r => ({ name: r.label, record_key: 'r'.repeat(32) }) }
  const selection = { objectName: 'forge_quotation' as const, source: { kind: 'creation' as const }, referenceIds: { customer_id: ['customer-a'] } }
  await bridge.selectCreation(turn, selection);await bridge.list(turn)
  const input = { action_ref: 1, values: { name: '报价甲', customer_id: 'customer-a' }, lineItems: [{ line_type: 'service', name: '实施服务', quantity: 2, taxed_unit_price: 100, tax_rate: 0, discount_rate: 100 }] }
  return { directory, context, service, bridge, turn, selection, input, sent: () => sent }
}

it('reads creation without fake record identity and projects only declared structured line fields', async () => {
  const context = creation();expect(parseEmployeeBusinessContext(context)).not.toHaveProperty('record')
  expect(() => parseEmployeeBusinessContext({ ...context, recordVersion: 'fake', record: { objectName: 'forge_quotation', recordId: 'create', label: 'fake' } })).toThrow()
  const read = vi.fn(async (_path: string, _label: string) => context)
  await new EmployeeBusinessReadAPI(read).context({ objectName: 'forge_quotation', source: { kind: 'creation' }, referenceIds: { customer_id: ['customer-a'] } })
  const query = new URL('http://example.invalid' + read.mock.calls[0][0]).searchParams
  expect(query.get('recordId')).toBeNull();expect(query.get('sourceRef')).toBeNull();expect(JSON.parse(query.get('referenceIds')!)).toEqual({ customer_id: ['customer-a'] })
  expect(() => validateEmployeeBusinessLineItems(context.actions[0], [{ line_type: 'service', name: '实施服务', quantity: 2, taxed_unit_price: 100, tax_rate: 0, discount_rate: 100, owner_id: 'other' }])).toThrow()
})

it('creates with faithful values, no fabricated SKU and a reusable opaque created-record reference', async () => {
  const f = await fixture();const result = await f.bridge.run(f.turn, f.input)
  expect(result).toMatchObject({ status: 'succeeded', records: [{ name: 'QT-001 报价甲', record_key: 'r'.repeat(32) }] })
  expect(JSON.stringify(result)).not.toContain('real-new-quotation')
  const request = f.sent()!;expect(request).not.toHaveProperty('recordId');expect(request.lineItems![0]).not.toHaveProperty('sku_id')
  expect(request.values).not.toHaveProperty('code');expect(request.employeeMessage.messageId).toBe('new-message')
  await f.bridge.run(f.turn, f.input);expect(f.service.executeEmployeeBusinessAction).toHaveBeenCalledTimes(1)
  await expect(f.bridge.run(f.turn, { ...f.input, lineItems: [{ ...f.input.lineItems[0], quantity: 3 }] })).rejects.toThrow('不能替换')
})

it('keeps unknown creation fenced across Host restart and new employee messages', async () => {
  const f = await fixture();f.service.executeEmployeeBusinessAction.mockRejectedValueOnce(new Error('response lost'))
  await f.bridge.run(f.turn, f.input)
  const sent = f.service.executeEmployeeBusinessAction.mock.calls[0][0]
  f.service.getEmployeeBusinessOperation.mockResolvedValue({ version: '1', operationId: sent.opKey, contextId: sent.contextId, requestDigest: employeeBusinessRequestDigest(sent), status: 'unknown', repeated: true, updatedAt: new Date().toISOString() })
  const restarted = new EmployeeBusinessActions(f.service, new HandoffStore({ directory: f.directory }))
  const turn = { ...f.turn, messageId: 'later-message' }
  expect(await restarted.list(turn)).toMatchObject({ actions: [], operation: { status: 'unknown' } })
  expect(await restarted.run(turn, f.input)).toMatchObject({ status: 'unknown' })
  expect(f.service.executeEmployeeBusinessAction).toHaveBeenCalledTimes(1)
  expect(await restarted.selection('actor-b', turn.sessionPath)).toBeUndefined()
})

it('does not turn a read question, missing value or guessed number into creation', async () => {
  const f = await fixture()
  for (const prompt of ['请只查看创建报价甲需要什么？', '不要创建报价甲', '我不创建报价甲']) {
    await expect(f.bridge.run({ ...f.turn, employeePrompt: prompt }, f.input)).rejects.toThrow()
  }
  await expect(f.bridge.run(f.turn, { ...f.input, values: { customer_id: 'customer-a' } })).rejects.toThrow()
  await expect(f.bridge.run(f.turn, { ...f.input, lineItems: [{ ...f.input.lineItems[0], taxed_unit_price: 999 }] })).rejects.toThrow('必须来自')
  expect(f.service.executeEmployeeBusinessAction).not.toHaveBeenCalled()
})

it('maps only current employee verified opaque refs and preserves the old digest when lineItems is absent', () => {
  const key = 'k'.repeat(32), objectRef = 'o'.repeat(32)
  const objects = new Map([[objectRef, { objectName: 'forge_quotation', accountKey: 'actor', turnKey: 'turn' }]])
  const refs = new Map([[key, { objectName: 'forge_customer', recordId: 'private-customer', accountKey: 'actor', turnKey: 'turn' }]])
  expect(creationSelection(objectRef, { customer_id: [key] }, undefined, objects, refs, 'actor', 'turn')).toEqual({ objectName: 'forge_quotation', source: { kind: 'creation' }, referenceIds: { customer_id: ['private-customer'] } })
  for (const raw of [{ customer_id: ['private-customer'] }, { sku_id: [key] }, { customer_id: [key, key] }, { owner_id: [key] }]) expect(() => creationSelection(objectRef, raw, undefined, objects, refs, 'actor', 'turn')).toThrow()
  expect(() => creationSelection(objectRef, { customer_id: [key] }, undefined, objects, refs, 'actor-b', 'turn')).toThrow()
  expect(() => creationSelection(objectRef, { customer_id: [key] }, undefined, objects, refs, 'actor', 'stale')).toThrow()
  const request: EmployeeBusinessRequest = { version: '1', contextId: 'context', contextVersion: 'version', opKey: 'operation', employeeMessage: { sessionId: 'session', messageId: 'message', sha256: 'hash' }, action_ref: 1, values: { payment_term: '到货付款' } }
  expect(employeeBusinessRequestDigest(request)).toBe(digest(canonicalBusinessJSON({ ...request, file: null })))
})

function employeeSource(text: string, messageId: string, eventSeq: number) {
  return { source_ref: digest(messageId).slice(0, 32), messageId, eventSeq, text, sha256: digest(text), transcriptSha256: digest(text) }
}
it('uses bound prior employee values with a new short authorization, deterministic quantity and private provenance', async () => {
  const f = await fixture()
  const old = employeeSource('报价甲，客户甲，实施服务一项500，税率0，折扣100。', 'draft-message', 1)
  const now = employeeSource('按刚才的内容建吧', 'create-message', 3)
  const turn = { ...f.turn, employeePrompt: now.text, messageId: now.messageId, inputSources: vi.fn(async () => [old, now]) }
  await f.bridge.list(turn)
  for (const employeePrompt of ['不要建吧', '如果资料齐了就建吧', '我倾向按刚才的内容建吧']) await expect(f.bridge.run({ ...turn, employeePrompt }, f.input)).rejects.toThrow()
  const line = { ...f.input.lineItems[0], quantity: 1, taxed_unit_price: 500 }
  const input_sources = Object.fromEntries(['values.name', 'values.customer_id', ...Object.keys(line).map(key => `lineItems.0.${key}`)].map(path => [path, old.source_ref]))
  expect(await f.bridge.run(turn, { ...f.input, lineItems: [line], input_sources })).toMatchObject({ status: 'succeeded' })
  expect(f.sent()!.employeeMessage.messageId).toBe(now.messageId)
  expect(f.sent()).not.toHaveProperty('input_sources')
  const store = new HandoffStore({ directory: f.directory })
  const saved = await store.inspect<{ inputEvidence: Record<string, { source?: typeof old }> }>(`employee-business-intent:${turn.accountKey}:${digest(turn.sessionPath)}:${turn.messageId}`)
  expect(saved!.value.inputEvidence['lineItems.0.taxed_unit_price'].source).toMatchObject({ messageId: old.messageId, sha256: old.sha256, eventSeq: 1 })
})
it('rejects wrong source paths, historical price conflicts and sources changed before send', async () => {
  const f = await fixture()
  const old = employeeSource(f.turn.employeePrompt, 'draft', 1), changed = employeeSource('实施服务2项，单价900。', 'correction', 2)
  const now = employeeSource('按刚才的内容建吧', 'go', 3)
  const turn = { ...f.turn, employeePrompt: now.text, messageId: now.messageId, inputSources: vi.fn(async () => [old, changed, now]) }
  await f.bridge.list(turn)
  await expect(f.bridge.run(turn, { ...f.input, input_sources: { 'lineItems.100.quantity': old.source_ref } })).rejects.toThrow('路径')
  const input_sources = Object.fromEntries(['values.name', 'values.customer_id', ...Object.keys(f.input.lineItems[0]).map(key => `lineItems.0.${key}`)].map(path => [path, old.source_ref]))
  await expect(f.bridge.run(turn, { ...f.input, input_sources })).rejects.toThrow('后续不同表述')
  turn.inputSources.mockResolvedValue([old, now]);await f.bridge.list(turn)
  turn.inputSources.mockResolvedValue([now])
  await expect(f.bridge.run(turn, { ...f.input, input_sources })).rejects.toThrow('来源已变化')
  expect(f.service.executeEmployeeBusinessAction).not.toHaveBeenCalled()
})
it('keeps Host-observed input sources account/session-bound and removes edited transcript evidence', async () => {
  const f = await fixture()
  const { EmployeeBusinessInputs } = await import('../../electron/main/enterprise/employee-business-inputs')
  const inputs = new EmployeeBusinessInputs(new HandoffStore({ directory: f.directory }))
  const entry = { id: 'user-message', role: 'user', text: '实施服务一项500' }
  await inputs.remember('actor', 'session', entry.text, 0, entry)
  await inputs.remember('actor', 'session', '伪造助手意见', 1, { id: 'assistant', role: 'assistant', text: '伪造助手意见' })
  expect(await inputs.read('actor', 'session', [entry])).toHaveLength(1)
  expect(await inputs.read('other', 'session', [entry])).toEqual([])
  expect(await inputs.read('actor', 'other', [entry])).toEqual([])
  await expect(inputs.read('actor', 'session', [{ ...entry, text: '已修改' }])).rejects.toThrow('旧草稿来源已失效')
})

it('anchors a material row without name to its bound native SKU and rejects a model display-name shortcut', async () => {
  const f = await fixture()
  const fields = f.context.actions[0].lineItems!.fields
  fields.find(field => field.name === 'name')!.required = false
  Object.assign(fields.find(field => field.name === 'sku_id')!, { enum: ['sku-a'], enumLabels: [{ value: 'sku-a', label: '设备甲 · 标准配置（SKU-A）' }] })
  const input = employeeSource('创建报价甲，客户甲，设备甲一套1600，税率0，折扣100。', 'material-input', 1)
  const turn = { ...f.turn, messageId: input.messageId, employeePrompt: input.text, inputSources: async () => [input] }
  await f.bridge.selectCreation(turn, { ...f.selection, referenceIds: { ...f.selection.referenceIds, sku_id: ['sku-a'] }, skuNames: { 'sku-a': { name: '标准配置', materialName: '设备甲', code: 'SKU-A' } }, referenceFacts: { sku_id: { 'sku-a': { name: '标准配置', code: 'SKU-A', uniqueQuery: '设备甲' } } } })
  await f.bridge.list(turn)
  const line = { line_type: 'material', sku_id: 'sku-a', quantity: 1, taxed_unit_price: 1600, tax_rate: 0, discount_rate: 100 }
  await expect(f.bridge.run(turn, { ...f.input, lineItems: [{ ...line, name: '伪造锚点' }] })).rejects.toThrow('来源')
  expect(await f.bridge.run(turn, { ...f.input, lineItems: [line] })).toMatchObject({ status: 'succeeded' })
  expect(f.sent()!.lineItems![0]).not.toHaveProperty('name')
  expect(f.sent()!.lineItems![0].sku_id).toBe('sku-a')
})
it('accepts arbitrary service names only with explicit service selection and keeps ambiguous kinds blocked', async () => {
  for (const name of ['咨询支持', '调试费']) {
    const f = await fixture()
    const source = employeeSource(`创建报价甲，客户甲，服务行${name}2项，含税单价100，税率0，折扣100。`, name, 1)
    const turn = { ...f.turn, employeePrompt: source.text, messageId: source.messageId, inputSources: async () => [source] }
    await f.bridge.list(turn)
    expect(await f.bridge.run(turn, { ...f.input, lineItems: [{ ...f.input.lineItems[0], name }] })).toMatchObject({ status: 'succeeded' })
  }
  const f = await fixture(), source = employeeSource('创建报价甲，客户甲，咨询支持2项，含税单价100，税率0，折扣100。', 'ambiguous', 1)
  const turn = { ...f.turn, employeePrompt: source.text, messageId: source.messageId, inputSources: async () => [source] }
  await f.bridge.list(turn)
  await expect(f.bridge.run(turn, { ...f.input, lineItems: [{ ...f.input.lineItems[0], name: '咨询支持' }] })).rejects.toThrow('来源')
  expect(f.service.executeEmployeeBusinessAction).not.toHaveBeenCalled()
})
it('allows an explicit internal lead estimate without treating uncertain quotation prices as facts', async () => {
  const { proveDraftInputs } = await import('../../electron/main/enterprise/employee-business-provenance')
  const context = creation(), action = { ...context.actions[0], capabilityId: 'forge:action:forge_sales_lead.sales_lead_create', lineItems: undefined,
    parameters: [{ name: 'estimated_amount', label: '内部估算', type: 'number' as const, required: false }] }
  const source = employeeSource('请创建线索，内部估计2300', 'estimate', 1)
  expect(proveDraftInputs({ context, action, selection: { objectName: 'forge_sales_lead', source: { kind: 'creation' } }, values: { estimated_amount: 2300 },
    rawSources: undefined, sources: [source], messageId: source.messageId })['values.estimated_amount'].value).toBe(2300)
  const budget = employeeSource('客户真实预算2300', 'budget', 2)
  expect(() => proveDraftInputs({ context, action, selection: { objectName: 'forge_sales_lead', source: { kind: 'creation' } }, values: { estimated_amount: 2300 },
    rawSources: undefined, sources: [budget], messageId: budget.messageId })).toThrow('来源')
  const f = await fixture(), uncertain = employeeSource('创建报价甲，客户甲，实施服务2项，含税单价大概100，税率0，折扣100。', 'uncertain', 1)
  const turn = { ...f.turn, employeePrompt: uncertain.text, messageId: uncertain.messageId, inputSources: async () => [uncertain] }
  await f.bridge.list(turn)
  await expect(f.bridge.run(turn, f.input)).rejects.toThrow('来源')
  expect(f.service.executeEmployeeBusinessAction).not.toHaveBeenCalled()
})

it('does not treat readable reference keys as employee selection of another customer', async () => {
  const f = await fixture(), parameter = f.context.actions[0].parameters.find(item => item.name === 'customer_id')!
  parameter.enum = ['customer-a', 'customer-b'];parameter.enumLabels = [{ value: 'customer-a', label: '客户甲' }, { value: 'customer-b', label: '客户乙' }]
  const source = employeeSource(f.turn.employeePrompt, 'choose-a', 1)
  const turn = { ...f.turn, messageId: source.messageId, inputSources: async () => [source] }
  await f.bridge.selectCreation(turn, { ...f.selection, referenceIds: { customer_id: ['customer-b'] }, referenceFacts: { customer_id: { 'customer-b': { name: '客户乙' } } } })
  await f.bridge.list(turn)
  await expect(f.bridge.run(turn, { ...f.input, values: { ...f.input.values, customer_id: 'customer-b' } })).rejects.toThrow('员工原话')
  expect(f.service.executeEmployeeBusinessAction).not.toHaveBeenCalled()
  await f.bridge.selectCreation(turn, f.selection);await f.bridge.list(turn)
  expect(await f.bridge.run(turn, f.input)).toMatchObject({ status: 'succeeded' })
})
it('requires a specification or readable code when material choice has multiple readable SKUs', async () => {
  const f = await fixture(), fields = f.context.actions[0].lineItems!.fields
  fields.find(field => field.name === 'name')!.required = false
  Object.assign(fields.find(field => field.name === 'sku_id')!, { enum: ['sku-a', 'sku-b'], enumLabels: [{ value: 'sku-a', label: '设备甲 · 标准配置（SKU-A）' }, { value: 'sku-b', label: '设备甲 · 高配置（SKU-B）' }] })
  let source = employeeSource('创建报价甲，客户甲，设备甲一套1600，税率0，折扣100。', 'ambiguous-sku', 1)
  const turn = { ...f.turn, messageId: source.messageId, employeePrompt: source.text, inputSources: async () => [source] }
  await f.bridge.selectCreation(turn, { ...f.selection, referenceIds: { ...f.selection.referenceIds, sku_id: ['sku-a', 'sku-b'] }, skuNames: {
    'sku-a': { name: '标准配置', materialName: '设备甲', code: 'SKU-A' }, 'sku-b': { name: '高配置', materialName: '设备甲', code: 'SKU-B' },
  }, referenceFacts: { sku_id: { 'sku-a': { name: '标准配置', code: 'SKU-A' }, 'sku-b': { name: '高配置', code: 'SKU-B' } } } })
  await f.bridge.list(turn)
  const request = { ...f.input, lineItems: [{ line_type: 'material', sku_id: 'sku-a', quantity: 1, taxed_unit_price: 1600, tax_rate: 0, discount_rate: 100 }] }
  await expect(f.bridge.run(turn, request)).rejects.toThrow('歧义')
  expect(f.service.executeEmployeeBusinessAction).not.toHaveBeenCalled()
  source = employeeSource('创建报价甲，客户甲，设备甲标准配置一套1600，税率0，折扣100。', 'selected-sku', 2)
  const selectedTurn = { ...turn, messageId: source.messageId, employeePrompt: source.text }
  await f.bridge.list(selectedTurn)
  expect(await f.bridge.run(selectedTurn, request)).toMatchObject({ status: 'succeeded' })
})

it('blocks stale customer provenance after a later employee correction, including unchanged frozen values', async () => {
  const f = await fixture(), old = employeeSource(f.turn.employeePrompt, 'old-selection', 1)
  const now = employeeSource('按刚才内容建吧', 'authorize', 3)
  let changed = employeeSource('客户改为客户乙，其余不变', 'correction', 2)
  const turn = { ...f.turn, messageId: now.messageId, employeePrompt: now.text, inputSources: async () => [old, changed, now] }
  const input_sources = Object.fromEntries(['values.name', 'values.customer_id', ...Object.keys(f.input.lineItems[0]).map(key => `lineItems.0.${key}`)].map(path => [path, old.source_ref]))
  await f.bridge.list(turn)
  await expect(f.bridge.run(turn, { ...f.input, input_sources })).rejects.toThrow('后续更正或否定')
  const draftKey = `employee-business-operation:${turn.accountKey}:creation:${digest(turn.sessionPath)}:forge_quotation:draft-inputs`
  await new HandoffStore({ directory: f.directory }).checkpoint(draftKey, digest(draftKey), { 'values.customer_id': { value: 'customer-a', source: old } })
  const restarted = new EmployeeBusinessActions(f.service, new HandoffStore({ directory: f.directory }))
  for (const text of ['客户改为客户乙，其余不变', '不要客户甲，其余不变', '客户乙，其余不变']) {
    changed = employeeSource(text, 'correction', 2)
    await restarted.list(turn)
    await expect(restarted.run(turn, { ...f.input, input_sources })).rejects.toThrow('后续更正或否定')
  }
  expect(f.service.executeEmployeeBusinessAction).not.toHaveBeenCalled()
})

it('does not consume one employee line twice, while allowing independently sourced identical service lines', async () => {
  const f = await fixture(), first = employeeSource('报价甲，客户甲，实施服务一项500，税率0，折扣100。', 'first-line', 1)
  const second = employeeSource('另加实施服务一项500，税率0，折扣100。', 'second-line', 2)
  const now = employeeSource('按刚才的两项内容创建报价', 'create-two', 3)
  let sources = [first, now]
  const turn = { ...f.turn, messageId: now.messageId, employeePrompt: now.text, inputSources: async () => sources }
  const line = { ...f.input.lineItems[0], quantity: 1, taxed_unit_price: 500 }
  const input_sources = Object.fromEntries(['values.name', 'values.customer_id', ...[0, 1].flatMap(index => Object.keys(line).map(key => `lineItems.${index}.${key}`))].map(path => [path, first.source_ref]))
  await f.bridge.list(turn)
  for (const duplicate of [line, { ...line, name: '服务' }]) {
    await expect(f.bridge.run(turn, { ...f.input, lineItems: [line, duplicate], input_sources })).rejects.toThrow('同一员工明细来源')
  }
  expect(f.service.executeEmployeeBusinessAction).not.toHaveBeenCalled()
  sources = [first, second, now]
  await f.bridge.list(turn)
  for (const key of Object.keys(line)) input_sources[`lineItems.1.${key}`] = second.source_ref
  expect(await f.bridge.run(turn, { ...f.input, lineItems: [line, line], input_sources })).toMatchObject({ status: 'succeeded' })
  expect(f.sent()!.lineItems).toHaveLength(2)
})
it('checks a newer correction even when its long text is omitted from the model input-source display', async () => {
  const f = await fixture(), old = employeeSource(f.turn.employeePrompt, 'old', 1)
  const changed = employeeSource(`客户改为客户乙，其余不变。${'说明'.repeat(5000)}`, 'large-correction', 2)
  const now = employeeSource('按刚才内容建吧', 'now', 3)
  const turn = { ...f.turn, employeePrompt: now.text, messageId: now.messageId, inputSources: async () => [old, changed, now] }
  const directory = await f.bridge.list(turn) as { input_sources: Array<{ source_ref: string }> }
  expect(directory.input_sources.some(source => source.source_ref === changed.source_ref)).toBe(false)
  const input_sources = Object.fromEntries(['values.name', 'values.customer_id', ...Object.keys(f.input.lineItems[0]).map(key => `lineItems.0.${key}`)].map(path => [path, old.source_ref]))
  await expect(f.bridge.run(turn, { ...f.input, input_sources })).rejects.toThrow('后续更正或否定')
  expect(f.service.executeEmployeeBusinessAction).not.toHaveBeenCalled()
})

it('invalidates the entire input generation after edited history and only recovers from a fresh captured employee message', async () => {
  for (const target of ['customer-a', 'customer-b']) {
    const f = await fixture(), { EmployeeBusinessInputs } = await import('../../electron/main/enterprise/employee-business-inputs')
    const inputs = new EmployeeBusinessInputs(new HandoffStore({ directory: f.directory }))
    const oldText = f.turn.employeePrompt, correction = '客户改为客户乙，其余不变。', current = '按刚才内容建吧'
    const transcript = [oldText, correction, current].map((text, index) => ({ id: `employee-${index}`, role: 'user', text }))
    for (const [index, entry] of transcript.entries()) await inputs.remember(f.turn.accountKey, f.turn.sessionPath, entry.text, index, entry)
    const old = (await inputs.read(f.turn.accountKey, f.turn.sessionPath, transcript))[0]
    const turn = { ...f.turn, messageId: transcript[2].id, employeePrompt: current, inputSources: () => inputs.read(f.turn.accountKey, f.turn.sessionPath, transcript) }
    const input_sources = Object.fromEntries(['values.name', 'values.customer_id', ...Object.keys(f.input.lineItems[0]).map(key => `lineItems.0.${key}`)].map(path => [path, old.source_ref]))
    await f.bridge.list(turn)
    await expect(f.bridge.run(turn, { ...f.input, input_sources })).rejects.toThrow('后续更正或否定')
    transcript[1].text = '客户已改为客户乙，其余不变。'
    await expect(f.bridge.run(turn, { ...f.input, input_sources })).rejects.toThrow('旧草稿来源已失效')
    await inputs.remember(f.turn.accountKey, f.turn.sessionPath, current, 2, transcript[2])
    await expect(f.bridge.list(turn)).rejects.toThrow('旧草稿来源已失效')
    expect(f.service.executeEmployeeBusinessAction).not.toHaveBeenCalled()
    const label = target === 'customer-a' ? '客户甲' : '客户乙'
    const fresh = { id: 'new-captured-employee', role: 'user', text: `请创建报价甲，${label}，实施服务2项，含税单价100，税率0，折扣100。` }
    transcript.push(fresh)
    await inputs.remember(f.turn.accountKey, f.turn.sessionPath, fresh.text, 3, fresh)
    const sources = await inputs.read(f.turn.accountKey, f.turn.sessionPath, transcript)
    expect(sources).toHaveLength(1);expect(sources[0].messageId).toBe(fresh.id)
    const customer = f.context.actions[0].parameters.find(parameter => parameter.name === 'customer_id')!
    customer.enum = [target];customer.enumLabels = [{ value: target, label }]
    const freshTurn = { ...turn, messageId: fresh.id, employeePrompt: fresh.text }
    await f.bridge.selectCreation(freshTurn, { ...f.selection, referenceIds: { customer_id: [target] } });await f.bridge.list(freshTurn)
    expect(await f.bridge.run(freshTurn, { ...f.input, values: { ...f.input.values, customer_id: target } })).toMatchObject({ status: 'succeeded' })
    expect(f.service.executeEmployeeBusinessAction).toHaveBeenCalledTimes(1)
    expect(f.sent()!.values.customer_id).toBe(target)
  }
})
