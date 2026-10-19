import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatchInitialization, type InitializationScope } from '../../electron/main/enterprise/initialization'
import { parseInitializationCatalog } from '../../electron/main/enterprise/initialization-catalog'
import { HandoffStore } from '../../electron/main/enterprise/handoff-store'
import type { InitializationAction } from '../../src/types/enterprise-initialization'

const objectName = 'forge_business_setting_option'
function action(name: string, overrides: Partial<InitializationAction> = {}): InitializationAction {
  return { name, objectName, label: '初始化计量单位', description: '原生定义', effect: 'write', requiresRecord: false, requiresConfirmation: false,
    params: [{ name: 'fields_json', label: '单位资料', type: 'string', required: true }, { name: 'operation_key', label: '原操作', type: 'string', required: true }], ...overrides }
}
function setup() {
  const actions = [action('initialization_units'), action('initialization_positions', { requiresConfirmation: true }),
    action('initialization_readiness', { effect: 'read', params: [] }),
    action('initialization_operation_result', { effect: 'read', params: [{ name: 'operation_key', label: '原操作', type: 'string', required: true }] })]
  const run = vi.fn<InitializationScope['run']>(async (_args, assertCurrent, _confirmation, before) => {
    await before(); await assertCurrent()
    return { status: 'returned', result: { version: '1', status: 'succeeded', operationId: 'private-id', nativeRequestDigest: 'private-digest', outcomes: [{ name: '台' }], summary: '已完成原生资料办理' } }
  })
  const scope: InitializationScope = { accountKey: 'administrator', sessionPath: 'session.jsonl', messageId: 'message', employeePrompt: '请创建计量单位台和岗位',
    list: vi.fn(async () => structuredClone(actions)), run, store: new HandoffStore(), assertCurrent: vi.fn(async () => {}), reserveMutation: vi.fn() }
  const params = { object_name: objectName, action_name: 'initialization_units', inputs_json: JSON.stringify({ fields_json: '{"name":"台","code":"UNIT"}' }), employee_request: scope.employeePrompt }
  return { actions, scope, params, run }
}
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('native initialization catalog and fixed original receipts', () => {
  it('discovers future organization and inventory actions, excluding unrelated writes', async () => {
    const f = setup()
    const native = { ...action('opening_inbound_approve', { objectName: 'forge_opening_inbound', requiresRecord: true }), params: [] }
    const parsed = parseInitializationCatalog({ actions: [...f.actions, action('initialization_organization_future'), native,
      action('delete_all', { objectName: 'forge_customer' }), action('other_inbound_approve', { objectName: 'forge_opening_inbound' })] })
    expect(parsed.map(entry => entry.name)).toContain('initialization_organization_future')
    expect(parsed.map(entry => entry.name)).toContain('opening_inbound_approve')
    expect(parsed.map(entry => entry.name)).not.toContain('delete_all')
    expect(parsed.map(entry => entry.name)).not.toContain('other_inbound_approve')
    const catalog = await dispatchInitialization('initialization_list', {}, f.scope)
    expect(JSON.stringify(catalog)).not.toContain('"name":"operation_key"')
    expect(f.run).not.toHaveBeenCalled()
  })

  it('rejects incomplete or duplicate declarations and honors read effects', () => {
    expect(() => parseInitializationCatalog({ actions: [{ ...action('initialization_units'), requiresConfirmation: undefined }] })).toThrow('明确')
    expect(() => parseInitializationCatalog({ actions: [action('initialization_units'), action('initialization_units')] })).toThrow('重复')
    expect(parseInitializationCatalog({ actions: [action('initialization_future_read', { effect: 'read' })] })[0]?.effect).toBe('read')
  })

  it('runs native readiness without a record, approval or business mutation', async () => {
    const f = setup()
    await dispatchInitialization('initialization_run', { object_name: objectName, action_name: 'initialization_readiness' }, f.scope)
    expect(f.run.mock.calls[0]?.[0]).toEqual({ objectName, actionName: 'initialization_readiness', params: {} })
    expect(f.scope.reserveMutation).not.toHaveBeenCalled()
  })

  it('injects a UUID only when declared and allows several different actions in the same turn', async () => {
    const f = setup()
    const result = await dispatchInitialization('initialization_run', f.params, f.scope)
    await dispatchInitialization('initialization_run', { ...f.params, action_name: 'initialization_positions' }, f.scope)
    expect(f.run).toHaveBeenCalledTimes(2)
    const first = f.run.mock.calls[0]!, second = f.run.mock.calls[1]!
    expect(first[0].params.operation_key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(first[0]).not.toHaveProperty('recordId')
    expect(first[2]).toBe(false)
    expect(second[2]).toBe(true)
    expect(second[0].params.operation_key).not.toEqual(first[0].params.operation_key)
    expect(result).toMatchObject({ status: 'succeeded', outcomes: [{ name: '台' }] })
    expect(result).not.toHaveProperty('operationId')
    expect(result).not.toHaveProperty('nativeRequestDigest')
  })

  it.each([
    { operation_key: 'chosen-by-model' }, { confirm: true }, { actorId: 'someone-else' },
    { fields_json: '{"name":"台","operation_key":"nested-key"}' },
    { fields_json: '[{"name":"台"}]' }, { fields_json: '{"name":"台"}', extra: 'not-declared' },
  ])('rejects model identity, key, confirmation and undeclared inputs: %j', async inputs => {
    const f = setup()
    await expect(dispatchInitialization('initialization_run', { ...f.params, inputs_json: JSON.stringify(inputs) }, f.scope)).rejects.toThrow()
    expect(f.run).not.toHaveBeenCalled()
  })

  it('requires the current employee message and rejects non-directory actions', async () => {
    const f = setup()
    await expect(dispatchInitialization('initialization_run', { ...f.params, employee_request: 'stale' }, f.scope)).rejects.toThrow('当前消息')
    await expect(dispatchInitialization('initialization_run', { ...f.params, action_name: 'generic_write' }, f.scope)).rejects.toThrow('目录')
    await expect(dispatchInitialization('initialization_run', { ...f.params, operation_key: 'invented' }, f.scope)).rejects.toThrow()
    expect(f.run).not.toHaveBeenCalled()
  })

  it('restores a lost reply after a Host restart and later employee turn without redispatch', async () => {
    const f = setup(), directory = await mkdtemp(join(tmpdir(), 'native-init-')); directories.push(directory)
    f.scope.store = new HandoffStore({ directory })
    f.run.mockRejectedValueOnce(new Error('reply lost'))
    expect((await dispatchInitialization('initialization_run', f.params, f.scope)).status).toBe('unknown')
    const originalKey = f.run.mock.calls[0]![0].params.operation_key
    const scope = { ...f.scope, store: new HandoffStore({ directory }), messageId: 'later-message', employeePrompt: '核对原单位资料' }
    // Use a differently formatted but equivalent original row.
    const recovered = await dispatchInitialization('initialization_run', { ...f.params, inputs_json: JSON.stringify({ fields_json: '{ "code": "UNIT", "name": "台" }' }), employee_request: scope.employeePrompt }, scope)
    expect(recovered.status).toBe('succeeded')
    expect(f.run.mock.calls.map(call => call[0].actionName)).toEqual(['initialization_units', 'initialization_operation_result'])
    expect(f.run.mock.calls[1]![0].params).toEqual({ operation_key: originalKey })
  })

  it('retains a definite rejection without querying a nonexistent write receipt', async () => {
    const f = setup()
    f.run.mockResolvedValueOnce({ status: 'rejected', code: 'INITIALIZATION_REQUIRED', message: '请提供仓库地址' })
    expect(await dispatchInitialization('initialization_run', f.params, f.scope)).toMatchObject({ status: 'rejected', summary: '请提供仓库地址' })
    const original = await dispatchInitialization('initialization_run', { object_name: objectName, action_name: 'initialization_operation_result' }, f.scope)
    expect(original.operations).toMatchObject([{ status: 'rejected', summary: '请提供仓库地址' }])
    expect(f.run).toHaveBeenCalledTimes(1)
    const corrected = { ...f.params, inputs_json: JSON.stringify({ fields_json: '{"name":"台","code":"UNIT","remarks":"补正资料"}' }) }
    expect((await dispatchInitialization('initialization_run', corrected, f.scope)).status).toBe('succeeded')
    expect(f.run.mock.calls.map(call => call[0].actionName)).toEqual(['initialization_units', 'initialization_units'])
  })

  it('recovers a prior Host input rejection after restart and allows corrected authorized input', async () => {
    const f = setup(), directory = await mkdtemp(join(tmpdir(), 'native-init-rejection-')); directories.push(directory)
    f.scope.store = new HandoffStore({ directory })
    f.run.mockResolvedValueOnce({ status: 'unknown', code: 'INITIALIZATION_INPUT_INVALID' })
    await dispatchInitialization('initialization_run', f.params, f.scope)
    const scope = { ...f.scope, store: new HandoffStore({ directory }), messageId: 'corrected-message', employeePrompt: '已补正资料，请办理' }
    const original = await dispatchInitialization('initialization_run', { object_name: objectName, action_name: 'initialization_operation_result' }, scope)
    expect(original.operations).toMatchObject([{ status: 'rejected' }])
    expect(f.run).toHaveBeenCalledTimes(1)
    const corrected = { ...f.params, inputs_json: JSON.stringify({ fields_json: '{"name":"套","code":"UNIT"}' }), employee_request: scope.employeePrompt }
    expect((await dispatchInitialization('initialization_run', corrected, scope)).status).toBe('succeeded')
    expect(f.run.mock.calls[1]![0].params.operation_key).not.toEqual(f.run.mock.calls[0]![0].params.operation_key)
  })

  it('queries the original unknown operation before accepting changed content', async () => {
    const f = setup()
    f.run.mockResolvedValueOnce({ status: 'unknown' })
    await dispatchInitialization('initialization_run', f.params, f.scope)
    const changed = { ...f.params, inputs_json: JSON.stringify({ fields_json: '{"name":"套"}' }) }
    const recovery = await dispatchInitialization('initialization_run', changed, f.scope)
    expect(recovery).toMatchObject({ originalOperation: true, submitted: false })
    expect(f.run.mock.calls.map(call => call[0].actionName)).toEqual(['initialization_units', 'initialization_operation_result'])
    await dispatchInitialization('initialization_run', changed, f.scope)
    expect(f.run.mock.calls[2]![0].actionName).toBe('initialization_units')
    expect(f.run.mock.calls[2]![0].params.operation_key).not.toEqual(f.run.mock.calls[0]![0].params.operation_key)
  })

  it('serializes duplicate calls and recovers only receipts belonging to the current account and session', async () => {
    const f = setup()
    await Promise.all([dispatchInitialization('initialization_run', f.params, f.scope), dispatchInitialization('initialization_run', f.params, f.scope)])
    expect(f.run.mock.calls.map(call => call[0].actionName)).toEqual(['initialization_units', 'initialization_operation_result'])
    for (const scope of [{ ...f.scope, accountKey: 'other-account' }, { ...f.scope, sessionPath: 'other-session.jsonl' }]) {
      const read = await dispatchInitialization('initialization_run', { object_name: objectName, action_name: 'initialization_operation_result' }, scope)
      expect(read.operations).toEqual([])
    }
    expect(f.run).toHaveBeenCalledTimes(2)
  })

  it('requires record binding for native opening actions without adding an undeclared key', async () => {
    const f = setup()
    f.actions.push(action('opening_inbound_approve', { objectName: 'forge_opening_inbound', requiresRecord: true, params: [{ name: 'approval_note', label: '审批意见', type: 'string', required: true }] }))
    const params = { object_name: 'forge_opening_inbound', action_name: 'opening_inbound_approve', inputs_json: '{"approval_note":"同意"}', employee_request: f.scope.employeePrompt }
    await expect(dispatchInitialization('initialization_run', params, f.scope)).rejects.toThrow('业务记录')
    await dispatchInitialization('initialization_run', { ...params, record_id: 'inbound-record' }, f.scope)
    expect(f.run.mock.calls[0]![0]).toEqual({ objectName: 'forge_opening_inbound', actionName: 'opening_inbound_approve', recordId: 'inbound-record', params: { approval_note: '同意' } })
  })

  it('uses a fresh operation for a new real employee message even when restoring previously used fields', async () => {
    const f = setup()
    await dispatchInitialization('initialization_run', f.params, f.scope)
    const scope = { ...f.scope, messageId: 'employee-restores-original-value', employeePrompt: '外部资料已变化，请恢复计量单位台' }
    await dispatchInitialization('initialization_run', { ...f.params, employee_request: scope.employeePrompt }, scope)
    expect(f.run.mock.calls.map(call => call[0].actionName)).toEqual(['initialization_units', 'initialization_units'])
    expect(f.run.mock.calls[1]![0].params.operation_key).not.toEqual(f.run.mock.calls[0]![0].params.operation_key)
  })

  it.each(['draft', 'pending_approval', 'stocked'])('does not treat the native business status %s as a transport uncertainty', async status => {
    const f = setup()
    f.actions[0]!.params = f.actions[0]!.params.filter(param => param.name !== 'operation_key')
    f.run.mockResolvedValue({ status: 'returned', result: { status, name: '期初入库单' } })
    await dispatchInitialization('initialization_run', f.params, f.scope)
    await dispatchInitialization('initialization_run', { ...f.params, inputs_json: JSON.stringify({ fields_json: '{"name":"套"}' }) }, f.scope)
    const scope = { ...f.scope, messageId: 'new-employee-message' }
    await dispatchInitialization('initialization_run', f.params, scope)
    expect(f.run).toHaveBeenCalledTimes(3)
    expect(f.run.mock.calls.every(call => call[0].actionName === 'initialization_units')).toBe(true)
  })

  it.each(['unknown', 'in_progress', 'in_doubt'])('keeps the original %s operation across new messages and changed inputs', async status => {
    const f = setup()
    f.run.mockResolvedValue({ status: 'returned', result: { version: '1', status } })
    await dispatchInitialization('initialization_run', f.params, f.scope)
    const scope = { ...f.scope, messageId: 'new-message' }
    await dispatchInitialization('initialization_run', { ...f.params, inputs_json: JSON.stringify({ fields_json: '{"name":"套"}' }) }, scope)
    expect(f.run.mock.calls.map(call => call[0].actionName)).toEqual(['initialization_units', 'initialization_operation_result'])
    expect(f.run.mock.calls[1]![0].params.operation_key).toEqual(f.run.mock.calls[0]![0].params.operation_key)
  })

  it('treats the native organization and opening readers as read-only without reserving an employee mutation', async () => {
    const f = setup()
    const readers = parseInitializationCatalog({ actions: [
      { ...action('initialization_read_organization'), effect: undefined, params: [] },
      { ...action('initialization_organization_read'), effect: undefined, params: [
        { name: 'section', type: 'select', options: [{ value: 'members', label: '组织成员' }] },
        { name: 'limit', type: 'number' }, { name: 'offset', type: 'number' },
      ] },
      { ...action('opening_inbound_read', { objectName: 'forge_opening_inbound', requiresRecord: true }), effect: undefined, params: [] },
      { ...action('opening_inbound_state', { objectName: 'forge_opening_inbound', requiresRecord: true }), effect: undefined, params: [] },
    ] })
    f.actions.push(...readers)
    for (const reader of readers) {
      expect(reader.effect).toBe('read')
      await dispatchInitialization('initialization_run', { object_name: reader.objectName, action_name: reader.name,
        ...(reader.name === 'initialization_organization_read' ? { inputs_json: '{"section":"members","limit":20,"offset":0}' } : {}),
        ...(reader.requiresRecord ? { record_id: 'inbound-current' } : {}) }, f.scope)
    }
    expect(f.scope.reserveMutation).not.toHaveBeenCalled()
    expect(f.run).toHaveBeenCalledTimes(4)
    expect(f.run.mock.calls[1]![0]).toEqual({ objectName, actionName: 'initialization_organization_read', params: { section: 'members', limit: 20, offset: 0 } })
    expect(f.run.mock.calls[3]![0]).toEqual({ objectName: 'forge_opening_inbound', actionName: 'opening_inbound_state', recordId: 'inbound-current', params: {} })
  })

  it('keeps opening approval recovery as a confirmation-required write with current employee authorization', async () => {
    const f = setup()
    const [recovery] = parseInitializationCatalog({ actions: [{
      ...action('opening_inbound_apply_approval', { objectName: 'forge_opening_inbound', requiresRecord: true, requiresConfirmation: true }), effect: undefined,
      params: [{ name: 'expected_version', label: '单据版本', type: 'number', required: true }],
    }] })
    expect(recovery!.effect).toBe('write')
    f.actions.push(recovery!)
    const params = { object_name: 'forge_opening_inbound', action_name: 'opening_inbound_apply_approval', record_id: 'inbound-current', inputs_json: '{"expected_version":2}' }
    await expect(dispatchInitialization('initialization_run', params, f.scope)).rejects.toThrow('当前消息')
    expect(f.run).not.toHaveBeenCalled()
    await dispatchInitialization('initialization_run', { ...params, employee_request: f.scope.employeePrompt }, f.scope)
    expect(f.scope.reserveMutation).toHaveBeenCalledOnce()
    expect(f.run.mock.calls[0]![2]).toBe(true)
    expect(f.run.mock.calls[0]![0]).toEqual({ objectName: 'forge_opening_inbound', actionName: 'opening_inbound_apply_approval', recordId: 'inbound-current', params: { expected_version: 2 } })
  })

  it('queries the latest bounded set and checkpoints once while retaining older original receipts', async () => {
    const f = setup()
    for (let index = 0; index < 25; index++) await dispatchInitialization('initialization_run', { ...f.params, inputs_json: JSON.stringify({ fields_json: JSON.stringify({ name: `单位${index}` }) }) }, f.scope)
    f.run.mockClear()
    const checkpoint = vi.spyOn(f.scope.store, 'checkpoint')
    const result = await dispatchInitialization('initialization_run', { object_name: objectName, action_name: 'initialization_operation_result' }, f.scope)
    expect(result.operations).toHaveLength(20)
    expect(f.run).toHaveBeenCalledTimes(20)
    expect(checkpoint).toHaveBeenCalledTimes(1)
    await dispatchInitialization('initialization_run', { ...f.params, inputs_json: JSON.stringify({ fields_json: '{"name":"单位0"}' }) }, f.scope)
    expect(f.run.mock.calls[20]![0].actionName).toBe('initialization_operation_result')
  })

  it('checks the latest native declaration immediately before dispatch', async () => {
    const f = setup()
    vi.mocked(f.scope.list).mockResolvedValueOnce(structuredClone(f.actions))
    f.actions[0]!.requiresConfirmation = true
    const result = await dispatchInitialization('initialization_run', f.params, f.scope)
    expect(result.status).toBe('unknown')
    expect(f.run).toHaveBeenCalledOnce()
    expect(f.scope.list).toHaveBeenCalledTimes(2)
  })
})
