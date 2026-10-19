import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EmployeeBusinessActions, type EmployeeBusinessConfirmation, type EmployeeBusinessTurn } from '../../electron/main/enterprise/employee-business-actions'
import { HandoffStore, digest } from '../../electron/main/enterprise/handoff-store'
import { employeeBusinessRequestDigest, parseEmployeeBusinessContext, parseEmployeeBusinessOperation, validateEmployeeBusinessValues } from '../../electron/main/enterprise/employee-business-contract'
import type { EmployeeBusinessContext, EmployeeBusinessOperation, EmployeeBusinessRequest } from '../../src/types/employee-business'
import { readBusinessWork } from '../../electron/main/enterprise/business-work'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })
const id = '10000000-0000-4000-8000-000000000001'
function context(): Extract<EmployeeBusinessContext, { record: unknown }> {
  return { version: '1', contextId: id, contextVersion: 'a'.repeat(64), recordVersion: 'revision-1', expiresAt: new Date(Date.now() + 60_000).toISOString(), readOnly: true,
    record: { objectName: 'forge_sales_contract', recordId: 'contract-1', label: '合同甲' }, source: { kind: 'record' },
    actions: [{ action_ref: 1, capabilityId: 'forge:action:forge_sales_contract.Sign', declarationVersion: 'b'.repeat(64), label: '登记签署', description: '本人登记签署日期', effect: 'write', executionMode: 'employee_only',
      parameters: [{ name: 'signed_on', label: '签署日期', type: 'date', required: true }, { name: 'note', label: '说明', type: 'string', required: true }] }],
  }
}
function receipt(request: EmployeeBusinessRequest): EmployeeBusinessOperation {
  return { version: '1', operationId: request.opKey, contextId: request.contextId, requestDigest: employeeBusinessRequestDigest(request), status: 'succeeded', repeated: false, updatedAt: new Date().toISOString() }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'employee-action-')); directories.push(directory)
  const current = context()
  const service = {
    getEmployeeBusinessContext: vi.fn(async () => structuredClone(current)),
    executeEmployeeBusinessAction: vi.fn(async (request: EmployeeBusinessRequest) => receipt(request)),
    getEmployeeBusinessOperation: vi.fn(async (_key: string): Promise<EmployeeBusinessOperation> => { throw new Error('404') }),
    stageWorkMaterials: vi.fn(async (materials: Array<{ name: string; bytes: number; sha256: string }>) => materials.map((m) => ({ type: 'forge-file' as const, id: 'owned-file', ...m }))),
  }
  const store = new HandoffStore({ directory })
  const bridge = new EmployeeBusinessActions(service, store)
  const turn: EmployeeBusinessTurn = { accountKey: 'employee-a', sessionPath: '/employee-a/session.jsonl', messageId: 'message-1', cwd: directory,
    employeePrompt: '请登记签署，日期2026-10-03，说明内部合成。', materials: [], readOnly: false, assertCurrent: vi.fn(async () => undefined) }
  await bridge.bind(turn.accountKey, turn.sessionPath, { record: current.record, source: current.source })
  const values = { signed_on: '2026-10-03', note: '内部合成' }
  return { directory, current, service, store, bridge, turn, values, run: () => bridge.run(turn, { action_ref: 1, values }) }
}

describe('employee-only business action contract', () => {
  it('preserves native date/file declarations and rejects malformed privilege or structured input', () => {
    const current = context()
    expect(parseEmployeeBusinessContext(current)).toEqual(current)
    current.actions[0].parameters.push({ name: 'evidence', type: 'file', label: '签署凭证', required: true })
    expect(parseEmployeeBusinessContext(current).actions[0].parameters[2].type).toBe('file')
    for (const values of [ { signed_on: '2026-02-30', note: '说明' }, { signed_on: '2026-10-03', note: [] }, { signed_on: '2026-10-03', note: '说明', evidence: 'other-file' }, { signed_on: '2026-10-03', note: '说明', recordId: 'other' } ]) {
      expect(() => validateEmployeeBusinessValues(current.actions[0].parameters, values)).toThrow()
    }
    expect(() => parseEmployeeBusinessContext({ ...current, actions: [{ ...current.actions[0], executionMode: 'team_delegable' }] })).toThrow()
    expect(() => parseEmployeeBusinessOperation({ ...receipt({ version: '1', contextId: id, contextVersion: 'a'.repeat(64), opKey: id, employeeMessage: { sessionId: 's', messageId: 'm', sha256: 'a'.repeat(64) }, action_ref: 1, values: {} }), status: 'unknown', noEffect: true })).toThrow()
  })
  it('enforces scalar enum and numeric bounds without coercion', () => {
    const parameters = [{ name: 'amount', label: '金额', type: 'number' as const, required: true, minimum: 1, maximum: 20 }, { name: 'method', label: '方式', type: 'string' as const, required: true, enum: ['cash'] }]
    expect(validateEmployeeBusinessValues(parameters, { amount: 20, method: 'cash' })).toEqual({ amount: 20, method: 'cash' })
    for (const value of [{ amount: '20', method: 'cash' }, { amount: 21, method: 'cash' }, { amount: NaN, method: 'cash' }, { amount: 2, method: 'guess' }]) expect(() => validateEmployeeBusinessValues(parameters, value)).toThrow()
  })
  it('accepts only a type-preserving complete enum label mapping, retaining ambiguous labels for display', () => {
    const current = context()
    const parameter = { name: 'method', label: '方式', type: 'string' as const, required: true, enum: ['bank_transfer', 'cash'], enumLabels: [{ value: 'bank_transfer', label: '银行转账' }, { value: 'cash', label: '现金' }] }
    current.actions[0].parameters = [parameter]
    expect(parseEmployeeBusinessContext(current).actions[0].parameters[0]).toEqual(parameter)
    for (const enumLabels of [
      [{ value: 'bank_transfer', label: '银行转账' }],
      [{ value: 'bank_transfer', label: '银行转账' }, { value: 'bank_transfer', label: '转账' }],
      [{ value: 'bank_transfer', label: '银行转账' }, { value: 'other', label: '其它' }],
      [{ value: 'bank_transfer', label: '' }, { value: 'cash', label: '现金' }],
      [{ value: 'bank_transfer', label: '银行转账', alias: '汇款' }, { value: 'cash', label: '现金' }],
    ]) expect(() => parseEmployeeBusinessContext({ ...current, actions: [{ ...current.actions[0], parameters: [{ ...parameter, enumLabels }] }] })).toThrow()
    expect(() => parseEmployeeBusinessContext({ ...current, actions: [{ ...current.actions[0], parameters: [{ ...parameter, enum: undefined }] }] })).toThrow()
    expect(() => parseEmployeeBusinessContext({ ...current, actions: [{ ...current.actions[0], parameters: [{ ...parameter, type: 'number', enum: [1, 2], enumLabels: [{ value: '1', label: '一' }, { value: 2, label: '二' }] }] }] })).toThrow()
    const ambiguous = { ...parameter, enumLabels: [{ value: 'bank_transfer', label: '付款' }, { value: 'cash', label: '付款' }] }
    expect(parseEmployeeBusinessContext({ ...current, actions: [{ ...current.actions[0], parameters: [ambiguous] }] }).actions[0].parameters[0]).toEqual(ambiguous)
  })
})

describe('employee action durable authorization and receipts', () => {
  it('preserves the opened item across related record reads and process restart without leaking the anchor', async () => {
    const f = await fixture()
    await f.bridge.bind(f.turn.accountKey, f.turn.sessionPath, { record: f.current.record, source: f.current.source }, true)
    await f.bridge.bind(f.turn.accountKey, f.turn.sessionPath, { record: { objectName: 'forge_fund_account', recordId: 'account-related', label: '测试银行台账' }, source: { kind: 'record' } })
    const reopened = new EmployeeBusinessActions(f.service, new HandoffStore({ directory: f.directory }))
    expect(await reopened.selection(f.turn.accountKey, f.turn.sessionPath)).toEqual({ record: f.current.record, source: f.current.source })
    await reopened.list(f.turn)
    expect(f.service.getEmployeeBusinessContext).toHaveBeenLastCalledWith({ record: f.current.record, source: f.current.source })
    expect(await reopened.run(f.turn, { action_ref: 1, values: f.values })).toMatchObject({ status: 'succeeded' })
    expect(f.service.executeEmployeeBusinessAction).toHaveBeenCalledOnce()
  })
  it('allows a newly verified item to replace the anchor while isolating account and session sources', async () => {
    const f = await fixture()
    await f.bridge.bind(f.turn.accountKey, f.turn.sessionPath, { record: f.current.record, source: f.current.source }, true)
    const next = { record: { objectName: 'forge_customer_prepayment', recordId: 'prepayment-next', label: '云岚预收' }, source: { kind: 'record' as const } }
    await f.bridge.bind(f.turn.accountKey, f.turn.sessionPath, next, true)
    expect(await f.bridge.selection(f.turn.accountKey, f.turn.sessionPath)).toEqual(next)
    expect(await f.bridge.selection('another-employee', f.turn.sessionPath)).toBeUndefined()
    expect(await f.bridge.selection(f.turn.accountKey, '/another-session')).toBeUndefined()
  })
  it('accepts an explicit project start while rejecting a negated start intent', async () => {
    const f = await fixture()
    f.current.record = { objectName: 'forge_project', recordId: 'project-current', label: '云岚交付项目' }
    f.current.actions[0].label = '启动项目'
    f.current.actions[0].parameters = []
    await f.bridge.bind(f.turn.accountKey, f.turn.sessionPath, { record: f.current.record, source: f.current.source })
    await f.bridge.list(f.turn)
    for (const employeePrompt of ['不要启动当前项目。', '暂不启动当前项目。', '禁止启动当前项目。']) {
      await expect(f.bridge.run({ ...f.turn, employeePrompt }, { action_ref: 1, values: {} })).rejects.toThrow('明确要求')
    }
    expect(f.service.executeEmployeeBusinessAction).not.toHaveBeenCalled()
    expect(await f.bridge.run({ ...f.turn, employeePrompt: '启动当前项目。' }, { action_ref: 1, values: {} })).toMatchObject({ status: 'succeeded', action_label: '启动项目' })
    expect(f.service.executeEmployeeBusinessAction).toHaveBeenCalledOnce()
  })
  it('keeps the preceding approval receipt distinct from a newly available send action after restart', async () => {
    const f = await fixture()
    f.current.actions[0].label = '提交报价审批'
    f.turn.employeePrompt = f.turn.employeePrompt.replace('登记签署', '提交报价审批')
    await f.bridge.list(f.turn); await f.run()
    f.current.recordVersion = 'revision-2'
    f.current.actions[0].label = '登记报价已发送'
    f.current.actions[0].capabilityId = 'forge:action:forge_quotation.Send'
    const reopened = new EmployeeBusinessActions(f.service, new HandoffStore({ directory: f.directory }))
    const next = { ...f.turn, messageId: 'message-2', employeePrompt: f.turn.employeePrompt.replace('提交报价审批', '登记报价已发送') }
    const listed = await reopened.list(next)
    if (!('previous_operation' in listed)) throw new Error('Expected the preceding completed operation')
    expect(listed).toMatchObject({
      previous_operation: { status: 'succeeded', action_label: '提交报价审批', message: expect.stringContaining('此前「提交报价审批」') },
      actions: [{ action_ref: 1, label: '登记报价已发送' }],
    })
    expect(listed.previous_operation?.message).toContain('不代表当前目录中的其他动作已办理')
    expect(await reopened.run(next, { action_ref: 1, values: f.values })).toMatchObject({ status: 'succeeded', action_label: '登记报价已发送' })
    expect(f.service.executeEmployeeBusinessAction).toHaveBeenCalledTimes(2)
  })
  it('does not infer a legacy receipt action from a reused current directory reference', async () => {
    const f = await fixture(); await f.bridge.list(f.turn); await f.run()
    for (const name of (await readdir(f.directory)).filter((name) => name.endsWith('.json'))) {
      const path = join(f.directory, name), saved = JSON.parse(await readFile(path, 'utf8'))
      if (saved.value.request) { delete saved.value.actionLabel; await writeFile(path, JSON.stringify(saved)) }
    }
    f.current.actions[0].label = '登记报价已发送'
    const reopened = new EmployeeBusinessActions(f.service, new HandoffStore({ directory: f.directory }))
    const listed = await reopened.list({ ...f.turn, messageId: 'message-2' })
    if (!('previous_operation' in listed)) throw new Error('Expected the preceding legacy operation')
    expect(listed.previous_operation).toMatchObject({ status: 'succeeded', message: expect.stringContaining('旧记录未保存动作名称') })
    expect(listed.previous_operation).not.toHaveProperty('action_label')
    expect(listed.previous_operation?.message).not.toContain('登记报价已发送')
  })
  it('retains the record-wide unknown-result fence when the current action has changed', async () => {
    const f = await fixture()
    f.current.actions[0].label = '提交报价审批'
    f.turn.employeePrompt = f.turn.employeePrompt.replace('登记签署', '提交报价审批')
    f.service.executeEmployeeBusinessAction.mockRejectedValue(new Error('connection lost'))
    await f.bridge.list(f.turn); await f.run()
    f.current.actions[0].label = '登记报价已发送'
    const reopened = new EmployeeBusinessActions(f.service, new HandoffStore({ directory: f.directory }))
    const next = { ...f.turn, messageId: 'message-2' }
    expect(await reopened.list(next)).toMatchObject({ actions: [], operation: { status: 'unknown' } })
    expect(await reopened.run(next, { action_ref: 1, values: f.values })).toMatchObject({ status: 'unknown' })
    expect(f.service.executeEmployeeBusinessAction).toHaveBeenCalledOnce()
  })
  it('accepts the unique native business label while sending its exact declared value', async () => {
    const f = await fixture()
    f.current.actions[0].label = '创建订单'
    f.current.actions[0].parameters = [{ name: 'payment_method', label: '付款方式', type: 'string', required: true, enum: ['bank_transfer', 'cash'], enumLabels: [{ value: 'bank_transfer', label: '银行转账' }, { value: 'cash', label: '现金' }] }]
    f.turn.employeePrompt = '请创建订单，付款方式选择银行转账。'
    await f.bridge.list(f.turn)
    expect(await f.bridge.run(f.turn, { action_ref: 1, values: { payment_method: 'bank_transfer' } })).toMatchObject({ status: 'succeeded' })
    expect(f.service.executeEmployeeBusinessAction.mock.calls[0][0].values).toEqual({ payment_method: 'bank_transfer' })
  })
  it.each(['请创建订单，付款方式银行汇款。', '请创建订单，不用银行转账。', '如果交期可以，请创建订单并用银行转账。'])('rejects guessed, negated or conditional option evidence: %s', async (prompt) => {
    const f = await fixture()
    f.current.actions[0].label = '创建订单'
    f.current.actions[0].parameters = [{ name: 'payment_method', label: '付款方式', type: 'string', required: true, enum: ['bank_transfer'], enumLabels: [{ value: 'bank_transfer', label: '银行转账' }] }]
    f.turn.employeePrompt = prompt; await f.bridge.list(f.turn)
    await expect(f.bridge.run(f.turn, { action_ref: 1, values: { payment_method: 'bank_transfer' } })).rejects.toThrow(prompt.startsWith('如果') ? '明确要求' : '业务选项')
    expect(f.service.executeEmployeeBusinessAction).not.toHaveBeenCalled()
  })
  it('does not authorize either value by an ambiguous label but accepts an exact explicitly stated value', async () => {
    const f = await fixture()
    f.current.actions[0].label = '创建订单'
    f.current.actions[0].parameters = [{ name: 'payment_method', label: '付款方式', type: 'string', required: true, enum: ['bank_transfer', 'cash'], enumLabels: [{ value: 'bank_transfer', label: '付款' }, { value: 'cash', label: '付款' }] }]
    f.turn.employeePrompt = '请创建订单，方式选择付款。'; await f.bridge.list(f.turn)
    for (const value of ['bank_transfer', 'cash']) await expect(f.bridge.run(f.turn, { action_ref: 1, values: { payment_method: value } })).rejects.toThrow('业务选项')
    expect(f.service.executeEmployeeBusinessAction).not.toHaveBeenCalled()
    f.turn.employeePrompt = '请创建订单，付款方式bank_transfer。'
    expect(await f.bridge.run(f.turn, { action_ref: 1, values: { payment_method: 'bank_transfer' } })).toMatchObject({ status: 'succeeded' })
  })
  it('rejects a changed enum label declaration after discovery', async () => {
    const f = await fixture()
    const parameter = { name: 'payment_method', label: '付款方式', type: 'string' as const, required: true, enum: ['bank_transfer'], enumLabels: [{ value: 'bank_transfer', label: '银行转账' }] }
    f.current.actions[0].label = '创建订单'
    f.current.actions[0].parameters = [parameter]
    f.turn.employeePrompt = '请创建订单，付款方式银行转账。'; await f.bridge.list(f.turn)
    parameter.enumLabels[0].label = '其它方式'
    await expect(f.bridge.run(f.turn, { action_ref: 1, values: { payment_method: 'bank_transfer' } })).rejects.toThrow('参数声明已变化')
    expect(f.service.executeEmployeeBusinessAction).not.toHaveBeenCalled()
  })
  it('requires a new employee intent, current directory and literal employee values', async () => {
    const f = await fixture()
    await expect(f.run()).rejects.toThrow('先读取')
    await f.bridge.list(f.turn)
    f.turn.readOnly = true; await expect(f.run()).rejects.toThrow('只授权查看')
    f.turn.readOnly = false; f.turn.employeePrompt = '只读查看2026-10-03内部合成'; await expect(f.run()).rejects.toThrow('明确要求')
    f.turn.employeePrompt = '请不要登记签署2026-10-03内部合成'; await expect(f.run()).rejects.toThrow('明确要求')
    f.turn.employeePrompt = '请登记签署2026-10-04内部合成'; await expect(f.run()).rejects.toThrow('本轮员工明确原文')
    expect(f.service.executeEmployeeBusinessAction).not.toHaveBeenCalled()
  })
  it('persists the fixed operation before POST and executes once under repeated/concurrent calls', async () => {
    const f = await fixture(); await f.bridge.list(f.turn)
    f.service.executeEmployeeBusinessAction.mockImplementation(async (request) => {
      const saved = await Promise.all((await readdir(f.directory)).filter((name) => name.endsWith('.json')).map(async (name) => JSON.parse(await readFile(join(f.directory, name), 'utf8'))))
      expect(saved.some((record) => record.value.phase === 'sent' && record.value.request.opKey === request.opKey)).toBe(true)
      return receipt(request)
    })
    const results = await Promise.all([f.run(), f.run()])
    expect(results).toEqual([expect.objectContaining({ status: 'succeeded' }), expect.objectContaining({ status: 'succeeded' })])
    expect(f.service.executeEmployeeBusinessAction).toHaveBeenCalledOnce()
    await expect(f.bridge.run(f.turn, { action_ref: 1, values: { ...f.values, note: '替换' } })).rejects.toThrow('内容已固定')
  })
  it('keeps a lost result unknown across messages and process restart; 404 never permits a new key', async () => {
    const f = await fixture(); await f.bridge.list(f.turn)
    f.service.executeEmployeeBusinessAction.mockRejectedValue(new Error('connection lost'))
    expect(await f.run()).toMatchObject({ status: 'unknown' })
    const key = f.service.executeEmployeeBusinessAction.mock.calls[0][0].opKey
    const reopened = new EmployeeBusinessActions(f.service, new HandoffStore({ directory: f.directory }))
    const next = { ...f.turn, messageId: 'message-2' }
    expect(await reopened.list(next)).toMatchObject({ actions: [], operation: { status: 'unknown' } })
    expect(await reopened.run(next, { action_ref: 1, values: f.values })).toMatchObject({ status: 'unknown' })
    expect(f.service.getEmployeeBusinessOperation).toHaveBeenCalledWith(key)
    expect(f.service.executeEmployeeBusinessAction).toHaveBeenCalledOnce()
  })
  it('does not accept a success receipt for another request', async () => {
    const f = await fixture(); await f.bridge.list(f.turn)
    f.service.executeEmployeeBusinessAction.mockImplementation(async (request) => ({ ...receipt(request), requestDigest: 'c'.repeat(64) }))
    expect(await f.run()).toMatchObject({ status: 'unknown' })
    expect(f.service.executeEmployeeBusinessAction).toHaveBeenCalledOnce()
  })
  it('rejects changed record/parameter declarations and changed employee evidence before dispatch', async () => {
    const f = await fixture(); await f.bridge.list(f.turn)
    f.current.recordVersion = 'revision-2'; await expect(f.run()).rejects.toThrow('已变化')
    expect(f.service.executeEmployeeBusinessAction).not.toHaveBeenCalled()
    f.current.recordVersion = 'revision-1'; f.current.actions[0].parameters[1].type = 'number'; await expect(f.run()).rejects.toThrow('已变化')
    f.turn.assertCurrent = vi.fn(async () => { throw new Error('账号已切换') }); await expect(f.run()).rejects.toThrow('账号已切换')
  })
  it('does not expose another account or session source', async () => {
    const f = await fixture()
    await expect(f.bridge.list({ ...f.turn, accountKey: 'employee-b' })).rejects.toThrow('先从本人')
    await expect(f.bridge.list({ ...f.turn, sessionPath: '/another-session' })).rejects.toThrow('先从本人')
  })
  it('freezes only the actual attached file and refuses replacement bytes', async () => {
    const f = await fixture(); const path = join(f.directory, 'evidence.txt'); await writeFile(path, '原件')
    f.current.actions[0].parameters.push({ name: 'evidence', label: '凭证', type: 'file', required: true })
    f.turn.materials = [{ name: 'evidence.txt', path, sha256: digest('原件'), bytes: Buffer.byteLength('原件'), mimeType: 'text/plain' }]
    await f.bridge.list(f.turn); await writeFile(path, '被替换')
    await expect(f.run()).rejects.toThrow(); expect(f.service.stageWorkMaterials).not.toHaveBeenCalled(); expect(f.service.executeEmployeeBusinessAction).not.toHaveBeenCalled()
  })
  it('injects the one newly selected file through Host upload without accepting model file identifiers', async () => {
    const f = await fixture(); const path = join(f.directory, 'evidence.txt'); await writeFile(path, '签署凭证')
    f.current.actions[0].parameters.push({ name: 'evidence', label: '凭证', type: 'file', required: true })
    f.turn.materials = [{ name: 'evidence.txt', path, sha256: digest('签署凭证'), bytes: Buffer.byteLength('签署凭证'), mimeType: 'text/plain' }]
    await f.bridge.list(f.turn)
    expect(await f.run()).toMatchObject({ status: 'succeeded' })
    expect(f.service.executeEmployeeBusinessAction.mock.calls[0][0]).toMatchObject({ values: f.values, file: { parameter: 'evidence', fileId: 'owned-file', name: 'evidence.txt', sha256: digest('签署凭证') } })
  })
})

describe('native business work projection', () => {
  it.each([513, 8192])('preserves a signed cursor of %i characters when following the next page', async (length) => {
    const cursor = 'a'.repeat(length)
    const page = { version: '1', items: [], readStatus: 'complete', observedAt: new Date().toISOString() }
    const read = vi.fn().mockResolvedValueOnce({ ...page, nextCursor: cursor }).mockResolvedValueOnce(page)
    expect(await readBusinessWork(read)).toEqual({ items: [] })
    expect(read.mock.calls[1][0]).toBe(`/api/v1/workbench/business-work?limit=100&cursor=${cursor}`)
  })
  it.each(['', 'a'.repeat(8193)])('rejects empty or oversized signed cursors', async (nextCursor) => {
    await expect(readBusinessWork(async () => ({ version: '1', items: [], readStatus: 'complete', observedAt: new Date().toISOString(), nextCursor }))).rejects.toThrow()
  })
  it('accepts authoritative order-condition work and all eight distinct source failures without claiming a complete list', async () => {
    const kinds = ['quotation_follow_up', 'contract_signature', 'contract_order_conditions', 'contract_prepayment', 'prepayment_confirmation', 'sales_order_creation', 'sales_order_submission', 'project_start']
    const item = { workKey: 'a'.repeat(64), kind: 'contract_order_conditions', title: '确认合同下单条件', record: context().record, recordVersion: '1', updatedAt: new Date().toISOString(), assignment: 'assigned' }
    const page = { version: '1', items: [item], readStatus: 'partial', observedAt: item.updatedAt, sourceErrors: kinds.map((kind) => ({ kind, code: 'READ_FAILED' })) }
    expect(await readBusinessWork(async () => page)).toMatchObject({ items: [item], error: expect.any(String) })
    await expect(readBusinessWork(async () => ({ ...page, sourceErrors: [...page.sourceErrors, page.sourceErrors[0]] }))).rejects.toThrow('完整性无效')
    await expect(readBusinessWork(async () => ({ ...page, sourceErrors: [page.sourceErrors[0], page.sourceErrors[0]] }))).rejects.toThrow('完整性无效')
    await expect(readBusinessWork(async () => ({ ...page, sourceErrors: [{ kind: 'unknown', code: 'READ_FAILED' }] }))).rejects.toThrow('完整性无效')
    await expect(readBusinessWork(async () => ({ ...page, items: [{ ...item, kind: 'unknown' }] }))).rejects.toThrow('来源无效')
  })
  it('reads a manager project-start item as a record source without granting a write or inferring a manager', async () => {
    const item = { workKey: 'd'.repeat(64), kind: 'project_start', title: '启动云岚交付项目',
      record: { objectName: 'forge_project', recordId: 'project-current', label: '云岚交付项目' },
      recordVersion: 'linked-order-1', updatedAt: new Date().toISOString(), assignment: 'assigned' }
    const page = { version: '1', items: [item], readStatus: 'complete', observedAt: item.updatedAt }
    expect(await readBusinessWork(async () => page)).toEqual({ items: [item] })
    await expect(readBusinessWork(async () => ({ ...page, items: [{ ...item, assignment: undefined }] }))).rejects.toThrow()
    await expect(readBusinessWork(async () => ({ ...page, items: [{ ...item, record: { ...item.record, objectName: 'sys_user' } }] }))).rejects.toThrow()
  })
  it.each(['提交报价审批', '登记报价发送', '登记客户接受', '转销售合同'])('reads a current quotation follow-up for %s without changing its record source', async (title) => {
    const item = { workKey: 'c'.repeat(64), kind: 'quotation_follow_up', title,
      record: { objectName: 'forge_quotation', recordId: 'quotation-current', label: '设备及服务报价' },
      recordVersion: 'pricing-1', updatedAt: new Date().toISOString(), assignment: 'assigned' }
    expect(await readBusinessWork(async () => ({ version: '1', items: [item], readStatus: 'complete', observedAt: item.updatedAt }))).toEqual({ items: [item] })
  })
  it('follows all pages, preserving assignment without inventing actionable owners', async () => {
    const item = { workKey: 'a'.repeat(64), kind: 'contract_signature', title: '登记签署', record: context().record, recordVersion: '1', updatedAt: new Date().toISOString(), assignment: 'assigned' }
    const read = vi.fn().mockResolvedValueOnce({ version: '1', items: [item], readStatus: 'complete', observedAt: item.updatedAt, nextCursor: 'next' })
      .mockResolvedValueOnce({ version: '1', items: [{ ...item, workKey: 'b'.repeat(64), assignment: 'needs_assignment', assignmentReason: 'multiple_eligible_employees' }], readStatus: 'complete', observedAt: item.updatedAt })
    const result = await readBusinessWork(read)
    expect(result.items.map((item) => item.assignment)).toEqual(['assigned', 'needs_assignment'])
    expect(read.mock.calls[1][0]).toContain('cursor=next')
  })
  it('keeps partial-source errors and rejects missing assignment evidence', async () => {
    const page = { version: '1', items: [], readStatus: 'partial', sourceErrors: [{ kind: 'contract_signature', code: 'READ_FAILED' }], observedAt: new Date().toISOString() }
    expect(await readBusinessWork(async () => page)).toHaveProperty('error')
    await expect(readBusinessWork(async () => ({ ...page, sourceErrors: undefined }))).rejects.toThrow()
  })
})

it('accepts the bound native action label in a new employee request without widening generic record authority', async () => {
  const f = await fixture()
  const note = '客户接受2100元报价，设备和安装培训范围不变'
  const prompt = `客户已接受这份2100元报价，回执附上了。帮我记录客户接受，接受说明：${note}。`
  f.current.record = { objectName: 'forge_quotation', recordId: 'quotation-current', label: '本人2100元报价' }
  f.current.actions[0] = { ...f.current.actions[0], capabilityId: 'forge:action:forge_quotation.quotation_accept', label: '记录客户接受',
    parameters: [{ name: 'customer_acceptance_note', label: '客户接受说明', type: 'string', required: true }, { name: 'customer_acceptance_evidence_attachment', label: '客户接受回执', type: 'file', required: true }] }
  const path = join(f.directory, 'synthetic-acceptance.txt');await writeFile(path, '测试合成回执')
  f.turn.materials = [{ name: 'synthetic-acceptance.txt', path, sha256: digest('测试合成回执'), bytes: Buffer.byteLength('测试合成回执'), mimeType: 'text/plain' }]
  f.turn.employeePrompt = prompt
  await f.bridge.bind(f.turn.accountKey, f.turn.sessionPath, { record: f.current.record, source: f.current.source })
  await f.bridge.list(f.turn)
  const request = { action_ref: 1, values: { customer_acceptance_note: note } }
  for (const employeePrompt of ['只是讨论记录客户接受，不办理。', '不要记录客户接受。', '如果客户接受，再帮我记录客户接受。', '帮我记录客户接受是否合适？', '记录客户接受是什么意思', '我建议记录客户接受。', '帮我记录报价拒绝。', '帮我记录。']) {
    await expect(f.bridge.run({ ...f.turn, employeePrompt }, request)).rejects.toThrow('明确要求')
  }
  await expect(f.bridge.run({ ...f.turn, readOnly: true }, request)).rejects.toThrow('只授权查看')
  await expect(f.bridge.run({ ...f.turn, messageId: 'without-current-directory' }, request)).rejects.toThrow('本轮当前事项动作目录')
  expect(f.service.executeEmployeeBusinessAction).not.toHaveBeenCalled()
  expect(f.service.stageWorkMaterials).not.toHaveBeenCalled()
  expect(await f.bridge.run(f.turn, request)).toMatchObject({ status: 'succeeded', action_label: '记录客户接受' })
  expect(f.service.executeEmployeeBusinessAction).toHaveBeenCalledOnce()
  expect(f.service.executeEmployeeBusinessAction.mock.calls[0][0]).toMatchObject({ action_ref: 1, values: request.values, file: { parameter: 'customer_acceptance_evidence_attachment', fileId: 'owned-file' } })
})

it('scopes a separate negative approval instruction without cancelling the current conversion request', async () => {
  const messages = [
    '那就把这份报价转成合同草稿吧，名称用青杉智造设备安装与培训合同，合同编号QS-HT-20261008-001，金额和设备、安装培训明细沿用这份2100元报价。先别提交审批。',
    '生效日期2026年10月9日，到期2027年10月8日，类型就用设备安装与培训合同。按刚才的名称和编号转成合同草稿，先不提交审批。',
  ]
  for (const employeePrompt of messages) {
    const f = await fixture()
    f.current.actions[0].label = '转为合同';f.current.actions[0].parameters = [] // Only the authorization boundary is under test here.
    const turn = { ...f.turn, employeePrompt };await f.bridge.list(turn)
    for (const denied of ['先转为合同，算了不要转了。', '请转为合同，先别操作。', '请转为合同，只看看。', '不要转为合同。', '如果日期齐了，转为合同。', '只讨论转为合同。', '能否转为合同？', '先不提交审批。', '上一轮转为合同失败了，先不提交审批。', '转为合同失败了，先不提交审批。', '他说转为合同，先不提交审批。', '请创建线索，先不提交审批。']) {
      await expect(f.bridge.run({ ...turn, employeePrompt: denied }, { action_ref: 1, values: {} })).rejects.toThrow('明确要求')
    }
    await expect(f.bridge.run({ ...turn, readOnly: true }, { action_ref: 1, values: {} })).rejects.toThrow('只授权查看')
    await expect(f.bridge.run({ ...turn, messageId: 'no-fresh-directory' }, { action_ref: 1, values: {} })).rejects.toThrow()
    expect(f.service.executeEmployeeBusinessAction).not.toHaveBeenCalled()
    expect(await f.bridge.run(turn, { action_ref: 1, values: {} })).toMatchObject({ status: 'succeeded' })
    expect(f.service.executeEmployeeBusinessAction).toHaveBeenCalledOnce()
  }
})
it('keeps the existing conversion parameter-source guard after accepting the scoped request', async () => {
  const f = await fixture()
  f.current.actions[0].label = '转为合同'
  f.current.actions[0].parameters = [{ name: 'code', label: '合同编号', type: 'string', required: true }, { name: 'starts_on', label: '生效日期', type: 'date', required: true }]
  const turn = { ...f.turn, employeePrompt: '生效日期2026年10月9日，到期2027年10月8日，类型就用设备安装与培训合同。按刚才的名称和编号转成合同草稿，先不提交审批。' }
  await f.bridge.list(turn)
  await expect(f.bridge.run(turn, { action_ref: 1, values: { code: 'QS-HT-20261008-001', starts_on: '2026-10-09' } })).rejects.toThrow('办理参数必须来自本轮员工明确原文')
  expect(f.service.executeEmployeeBusinessAction).not.toHaveBeenCalled()
})

it('uses owned historical contract name/code and field-bound complete Chinese dates for the current quotation conversion', async () => {
  const f = await fixture(), contractName = '青杉智造设备安装与培训合同', code = 'QS-HT-20261008-001'
  const original = `那就把这份报价转成合同草稿吧，名称用${contractName}，合同编号${code}，金额和设备、安装培训明细沿用这份2100元报价。先别提交审批。`
  const current = '生效日期2026年10月9日，到期2027年10月8日，类型就用设备安装与培训合同。按刚才的名称和编号转成合同草稿，先不提交审批。'
  const source = (text: string, messageId: string, eventSeq: number) => ({ source_ref: digest(messageId).slice(0, 32), messageId, eventSeq, text, sha256: digest(text), transcriptSha256: digest(text) })
  const old = source(original, 'original-contract-fields', 1)
  let now = source(current, 'current-conversion', 3)
  let sources = [old, now]
  f.current.record = { objectName: 'forge_quotation', recordId: 'accepted-quotation', label: '已接受2100元报价' }
  f.current.actions[0] = { ...f.current.actions[0], label: '转为合同', capabilityId: 'forge:action:forge_quotation.quotation_convert_to_contract', parameters: [
    { name: 'name', label: '合同名称', type: 'string', required: true }, { name: 'code', label: '合同编号', type: 'string', required: true },
    { name: 'contract_type_id', label: '合同类型', type: 'string', required: true, enum: ['type-equipment'], enumLabels: [{ value: 'type-equipment', label: '设备安装与培训合同' }] },
    { name: 'starts_on', label: '生效日期', type: 'date', required: true }, { name: 'ends_on', label: '到期日期', type: 'date', required: true },
  ] }
  await f.bridge.bind(f.turn.accountKey, f.turn.sessionPath, { record: f.current.record, source: f.current.source })
  const values = { name: contractName, code, contract_type_id: 'type-equipment', starts_on: '2026-10-09', ends_on: '2027-10-08' }
  const turn = () => ({ ...f.turn, messageId: now.messageId, employeePrompt: now.text, inputSources: async () => sources })
  const request = () => ({ action_ref: 1, values, input_sources: Object.fromEntries(Object.keys(values).map(field => [`values.${field}`, ['name', 'code'].includes(field) ? old.source_ref : now.source_ref])) })
  await f.bridge.list(turn())
  await expect(f.bridge.run(turn(), { ...request(), values: { ...values, starts_on: values.ends_on, ends_on: values.starts_on } })).rejects.toThrow('来源')
  for (const incomplete of ['10月9日', '明天', '2026年2月30日']) {
    now = source(current.replace('2026年10月9日', incomplete), `date-${incomplete}`, 3);sources = [old, now]
    await f.bridge.list(turn());await expect(f.bridge.run(turn(), request())).rejects.toThrow('来源')
  }
  now = source(current, 'current-conversion', 3)
  for (const correction of ['合同名称改为另一合同', '合同名称换成另一合同', '合同名称换为另一合同', '合同名称更换为另一合同']) {
    sources = [old, source(correction, 'correct-name', 2), now]
    await f.bridge.list(turn());await expect(f.bridge.run(turn(), request())).rejects.toThrow('后续更正')
  }
  sources = [old, now];await f.bridge.list(turn())
  const borrowedType = request();borrowedType.input_sources['values.contract_type_id'] = old.source_ref
  await expect(f.bridge.run(turn(), borrowedType)).rejects.toThrow('来源')
  expect(f.service.executeEmployeeBusinessAction).not.toHaveBeenCalled()
  sources = [old, now];await f.bridge.list(turn())
  expect(await f.bridge.run(turn(), request())).toMatchObject({ status: 'succeeded' })
  const sent = f.service.executeEmployeeBusinessAction.mock.calls[0][0]
  expect(sent.values).toEqual(values);expect(sent.employeeMessage.messageId).toBe(now.messageId);expect(sent).not.toHaveProperty('input_sources')
})

it('keeps the real quotation-send wording with an omitted bound object but rejects another explicit object', async () => {
  const f = await fixture(), note = '2100元报价已发送，等待客户确认'
  const prompt = `2100元这份报价已经发给客户了，帮我登记已发送。发送说明写：${note}。就用我附的这份材料，其他别改。`
  f.current.record = { objectName: 'forge_quotation', recordId: 'quotation-sent', label: '本人2100元报价' }
  f.current.actions[0] = { ...f.current.actions[0], capabilityId: 'forge:action:forge_quotation.quotation_send', label: '登记报价已发送', parameters: [
    { name: 'sent_evidence_note', label: '发送说明', type: 'string', required: true }, { name: 'sent_evidence_attachment', label: '发送凭证', type: 'file', required: true },
  ] }
  const path = join(f.directory, 'synthetic-sent.txt');await writeFile(path, '测试合成发送凭证')
  const turn: EmployeeBusinessTurn = { ...f.turn, employeePrompt: prompt, materials: [{ name: 'synthetic-sent.txt', path, sha256: digest('测试合成发送凭证'), bytes: Buffer.byteLength('测试合成发送凭证'), mimeType: 'text/plain' }] }
  await f.bridge.bind(turn.accountKey, turn.sessionPath, { record: f.current.record, source: f.current.source });await f.bridge.list(turn)
  const request = { action_ref: 1, values: { sent_evidence_note: note } }
  for (const employeePrompt of ['请登记订单已发送。', '帮我登记已发送的订单。', '报价已经发给客户了。', '帮我登记已发送，先别操作。']) {
    await expect(f.bridge.run({ ...turn, employeePrompt }, request)).rejects.toThrow('明确要求')
  }
  expect(f.service.executeEmployeeBusinessAction).not.toHaveBeenCalled();expect(f.service.stageWorkMaterials).not.toHaveBeenCalled()
  expect(await f.bridge.run(turn, request)).toMatchObject({ status: 'succeeded', action_label: '登记报价已发送' })
  expect(f.service.executeEmployeeBusinessAction).toHaveBeenCalledOnce()
  expect(f.service.executeEmployeeBusinessAction.mock.calls[0][0].file?.parameter).toBe('sent_evidence_attachment')
})

async function sentRegistration(employeePrompt: (note: string) => string) {
  const f = await fixture(), note = '2100元报价已发送，等待客户确认'
  f.current.record = { objectName: 'forge_quotation', recordId: 'quotation-sent', label: '本人2100元报价' }
  f.current.actions[0] = { ...f.current.actions[0], capabilityId: 'forge:action:forge_quotation.quotation_send', label: '登记报价已发送', parameters: [
    { name: 'sent_evidence_note', label: '发送说明', type: 'string', required: true }, { name: 'sent_evidence_attachment', label: '发送凭证', type: 'file', required: true },
  ] }
  const path = join(f.directory, 'synthetic-sent.txt');await writeFile(path, '测试合成发送凭证')
  const confirm = vi.fn(async (_request: EmployeeBusinessConfirmation) => true)
  const turn: EmployeeBusinessTurn = { ...f.turn, employeePrompt: employeePrompt(note), confirm, materials: [{ name: 'synthetic-sent.txt', path, sha256: digest('测试合成发送凭证'), bytes: Buffer.byteLength('测试合成发送凭证'), mimeType: 'text/plain' }] }
  await f.bridge.bind(turn.accountKey, turn.sessionPath, { record: f.current.record, source: f.current.source });await f.bridge.list(turn)
  return { f, turn, confirm, note, request: { action_ref: 1, values: { sent_evidence_note: note } } }
}

it.each([
  ['a generic handling verb before the directory label', (note: string) => `请办理当前报价Q-0001的登记报价已发送，发送凭证就是本轮实际选定的synthetic-sent.txt。发送说明：${note}。仅销售到项目联调测试，记录已审批核价版本1、设备2×900加安装培训1×300共2100元的测试发送状态，没有发生真实对外邮件、消息或文件发送。请按当前事项重新读取动作目录，只绑定本轮这一份实际原件，不用旧附件或文件标识。`],
  ['the bare handling verb and label', (note: string) => `请办理登记报价已发送。发送说明：${note}。`],
  ['the bound record named inside the request', (note: string) => `请登记本人2100元报价已发送。发送说明：${note}。`],
])('handles %s without asking the employee again', async (_name, employeePrompt) => {
  const { f, turn, confirm, request } = await sentRegistration(employeePrompt)
  expect(await f.bridge.run(turn, request)).toMatchObject({ status: 'succeeded', action_label: '登记报价已发送' })
  expect(confirm).not.toHaveBeenCalled()
})

it('puts wording it cannot settle to the employee and handles the action only on their yes', async () => {
  const { f, turn, confirm, note, request } = await sentRegistration((note) => `报价已经发给客户了。发送说明：${note}。`)
  expect(await f.bridge.run(turn, request)).toMatchObject({ status: 'succeeded', action_label: '登记报价已发送' })
  expect(confirm).toHaveBeenCalledExactlyOnceWith({ action: '登记报价已发送', record: '本人2100元报价',
    fields: [{ label: '发送说明', value: note }, { label: '发送凭证', value: 'synthetic-sent.txt' }] })
  expect(f.service.executeEmployeeBusinessAction).toHaveBeenCalledOnce()
})

it('leaves the record untouched when the employee declines and does not ask twice in one message', async () => {
  const { f, turn, confirm, request } = await sentRegistration((note) => `报价已经发给客户了。发送说明：${note}。`)
  confirm.mockResolvedValue(false)
  await expect(f.bridge.run(turn, request)).rejects.toThrow('没有确认办理')
  await expect(f.bridge.run(turn, request)).rejects.toThrow('没有确认办理')
  expect(confirm).toHaveBeenCalledOnce()
  expect(f.service.executeEmployeeBusinessAction).not.toHaveBeenCalled();expect(f.service.stageWorkMaterials).not.toHaveBeenCalled()
})

it('never turns a refusal, a read-only opening or a stale directory into a question', async () => {
  const { f, turn, confirm, note, request } = await sentRegistration((note) => `报价已经发给客户了。发送说明：${note}。`)
  await expect(f.bridge.run({ ...turn, employeePrompt: `帮我登记已发送，先别操作。发送说明：${note}。` }, request)).rejects.toThrow('明确要求')
  await expect(f.bridge.run({ ...turn, employeePrompt: `如果客户确认了，登记报价已发送。发送说明：${note}。` }, request)).rejects.toThrow('明确要求')
  await expect(f.bridge.run({ ...turn, readOnly: true }, request)).rejects.toThrow('只授权查看')
  await expect(f.bridge.run({ ...turn, messageId: 'message-2' }, request)).rejects.toThrow('明确要求')
  await expect(f.bridge.run({ ...turn, confirm: undefined }, request)).rejects.toThrow('明确要求')
  expect(confirm).not.toHaveBeenCalled();expect(f.service.executeEmployeeBusinessAction).not.toHaveBeenCalled()
})

it('trusts nothing read before the answer and fixes the confirmed content for the message', async () => {
  const other = '2100元报价已发送，另一份说明'
  const { f, turn, confirm, request } = await sentRegistration((note) => `报价已经发给客户了。发送说明：${note}。备用说明：${other}。`)
  const version = f.current.contextVersion
  confirm.mockImplementationOnce(async () => { f.current.contextVersion = 'c'.repeat(64); return true })
  await expect(f.bridge.run(turn, request)).rejects.toThrow('已变化')
  expect(f.service.executeEmployeeBusinessAction).not.toHaveBeenCalled()
  f.current.contextVersion = version
  await expect(f.bridge.run(turn, { action_ref: 1, values: { sent_evidence_note: other } })).rejects.toThrow('办理内容已固定')
  expect(await f.bridge.run(turn, request)).toMatchObject({ status: 'succeeded' })
  expect(confirm).toHaveBeenCalledOnce();expect(f.service.executeEmployeeBusinessAction).toHaveBeenCalledOnce()
})
