import { describe, expect, it, vi } from 'vitest'
import type { NativeMcpActionArguments } from '../../electron/main/enterprise'
import { callNativeMcpRunAction, parseCurrentApprovalActions } from '../../electron/main/enterprise/approval-actions'
import type { EnterpriseApprovalContext } from '../../src/types/api'
import { completeViewedApproval, type ApprovalUiAttempt } from '../../electron/main/enterprise/approval-ui-actions'
import { currentItemContextFingerprint } from '../../electron/main/enterprise/approval-context-binding'
import { runCurrentItemAction, type CurrentItemActionRuntime } from '../../electron/main/enterprise/current-item-actions'
import { digest } from '../../electron/main/enterprise/handoff-store'

const args: NativeMcpActionArguments = {
  actionName: 'quotation_approval_mcp_reject', objectName: 'forge_quotation', recordId: 'quotation-current',
  params: { approvalRequestId: 'approval-current', itemVersion: 'item-current', sourceMaterialVersion: 'a'.repeat(64), comment: '本轮本人意见' },
}

// JSON Schema shape produced by the public ObjectStack MCP 17.5 registration.
function nativeSchema(confirm: unknown = { type: 'boolean' }) {
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false,
    properties: { actionName: { type: 'string' }, objectName: { type: 'string' },
      recordId: { type: 'string' }, params: { type: 'object', propertyNames: { type: 'string' }, additionalProperties: {} },
      ...(confirm === undefined ? {} : { confirm }) }, required: ['actionName'] }
}

function fixture(options: {
  schema?: unknown; tools?: unknown[]; metadata?: 'lost' | '401' | '403' | 'malformed' | 'wrong-id' | 'partial';
  write?: 'lost' | '428' | 'malformed'; onList?: () => void;
} = {}) {
  const calls: Array<{ id: string; method: string; params?: { name: string; arguments: Record<string, unknown> } }> = []
  let generation = 1
  const assertCurrent = vi.fn(async () => {})
  const assertBeforeDispatch = vi.fn(async () => {})
  const signOutIfCurrent = vi.fn(async () => {})
  const transport = {
    assertCurrentAuth: vi.fn((snapshot: unknown) => { if (snapshot !== generation) throw new Error('账号变化') }),
    assertAuthGeneration: vi.fn(() => { if (generation !== 1) throw new Error('登录代次变化') }),
    signOutIfCurrent,
    fetch: vi.fn(async (init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as typeof calls[number]
      calls.push(request)
      if (request.method === 'tools/list') {
        if (options.metadata === 'lost') throw new Error('工具声明响应丢失')
        options.onList?.()
        const response = options.metadata === 'malformed' ? new Response('not-json')
          : Response.json({ jsonrpc: '2.0', id: options.metadata === 'wrong-id' ? 'another-request' : request.id,
            result: { tools: options.tools ?? [{ name: 'run_action', inputSchema: options.schema ?? nativeSchema() }],
              ...(options.metadata === 'partial' ? { nextCursor: 'next-page' } : {}) } },
          { status: options.metadata === '401' ? 401 : options.metadata === '403' ? 403 : 200 })
        return { response, snapshot: 1 }
      }
      if (options.write === 'lost') throw new Error('动作回执丢失')
      if (options.write === '428') return { response: Response.json({ error: { code: 'ACTION_CONFIRMATION_REQUIRED' } }, { status: 428 }), snapshot: 1 }
      if (options.write === 'malformed') return { response: new Response('not-json'), snapshot: 1 }
      return { response: Response.json({ jsonrpc: '2.0', id: request.id,
        result: { structuredContent: { action: args.actionName, objectName: args.objectName, recordId: args.recordId, ok: true,
          result: { decision: 'reject', requestId: 'approval-current' } } } }), snapshot: 1 }
    }),
  }
  const run = (required: boolean | undefined = true, before: (() => Promise<void>) | undefined = assertBeforeDispatch, input = args) =>
    callNativeMcpRunAction(input, assertCurrent, transport, required, before)
  return { calls, transport, assertCurrent, assertBeforeDispatch, signOutIfCurrent, run,
    switchAccount: () => { generation = 2 }, writes: () => calls.filter(call => call.method === 'tools/call') }
}

describe('Host-owned native approval confirmation', () => {
  it('reads the live standard schema and confirms only the one bound 17.5 call', async () => {
    const f = fixture()
    expect(await f.run()).toMatchObject({ status: 'returned' })
    expect(f.calls.map(call => call.method)).toEqual(['tools/list', 'tools/call'])
    expect(f.calls[1].params).toEqual({ name: 'run_action', arguments: { ...args, confirm: true } })
    expect(f.calls[1].params?.arguments.params).toEqual(args.params)
    expect(args).not.toHaveProperty('confirm')
    expect(f.assertBeforeDispatch).toHaveBeenCalledOnce()
    expect(f.assertCurrent).toHaveBeenCalledTimes(3)
  })

  it('keeps explicit false with a legacy schema at the exact original four-argument shape', async () => {
    const schema = nativeSchema(); delete schema.properties.confirm
    const f = fixture({ schema })
    expect(await f.run(false)).toMatchObject({ status: 'returned' })
    expect(JSON.stringify(f.writes()[0].params?.arguments)).toBe(JSON.stringify(args))
    expect(f.writes()[0].params?.arguments).not.toHaveProperty('confirm')
  })

  it('also keeps explicit false at four arguments when the 17.5 schema supports confirmation', async () => {
    const f = fixture()
    expect(await f.run(false)).toMatchObject({ status: 'returned' })
    expect(JSON.stringify(f.writes()[0].params?.arguments)).toBe(JSON.stringify(args))
    expect(f.writes()[0].params?.arguments).not.toHaveProperty('confirm')
  })

  it('never infers permission to write from an absent action declaration or fresh-binding callback', async () => {
    const missing = fixture()
    expect(await callNativeMcpRunAction(args, missing.assertCurrent, missing.transport, undefined, missing.assertBeforeDispatch))
      .toMatchObject({ status: 'rejected', code: 'APPROVAL_ACTION_CONFIRMATION_UNKNOWN' })
    expect(missing.calls).toHaveLength(0)
    const unbound = fixture()
    expect(await callNativeMcpRunAction(args, unbound.assertCurrent, unbound.transport, false))
      .toMatchObject({ status: 'rejected', code: 'APPROVAL_ACTION_BINDING_MISMATCH' })
    expect(unbound.calls).toHaveLength(0)
  })

  it('fails before writing when a required declaration meets the old protocol', async () => {
    const schema = nativeSchema(); delete schema.properties.confirm
    const f = fixture({ schema })
    expect(await f.run()).toMatchObject({ status: 'rejected', code: 'APPROVAL_ACTION_CONFIRMATION_UNSUPPORTED' })
    expect(f.writes()).toHaveLength(0)
  })

  it.each([
    { type: 'string' }, { type: ['boolean', 'null'] }, { type: 'boolean', nullable: true },
    { type: 'boolean', enum: [true] }, { type: 'boolean', const: true }, { type: 'boolean', default: 'true' },
    { anyOf: [{ type: 'boolean' }] }, { $ref: '#/boolean' }, null,
  ])('refuses incompatible confirmation member %j even for explicit false', async (confirm) => {
    const f = fixture({ schema: nativeSchema(confirm) })
    expect(await f.run(false)).toHaveProperty('status', 'rejected')
    expect(f.writes()).toHaveLength(0)
  })

  it.each([
    [], [{ name: 'run_action', inputSchema: nativeSchema() }, { name: 'run_action', inputSchema: nativeSchema() }],
    [{ name: 'run_action' }], [{ name: 'run_action', inputSchema: { properties: {} } }],
  ].map(tools => ({ tools })))('requires a unique usable declaration $tools', async ({ tools }) => {
    const f = fixture({ tools })
    expect(await f.run()).toHaveProperty('status', 'rejected')
    expect(f.writes()).toHaveLength(0)
  })

  it.each(['actionName', 'objectName', 'recordId', 'params'] as const)('requires normal legacy business member %s even when confirmation is false', async (name) => {
    const schema = nativeSchema()
    delete (schema.properties as Record<string, unknown>)[name]
    delete schema.properties.confirm
    const f = fixture({ schema })
    expect(await f.run(false)).toHaveProperty('status', 'rejected')
    expect(f.writes()).toHaveLength(0)
  })

  it('does not accept an empty legacy properties bag', async () => {
    const f = fixture({ schema: { type: 'object', required: ['actionName'], properties: {} } })
    expect(await f.run(false)).toHaveProperty('status', 'rejected')
    expect(f.writes()).toHaveLength(0)
  })

  it.each(['lost', '401', '403', 'malformed', 'wrong-id', 'partial'] as const)('keeps protocol %s failure before the business effect', async (metadata) => {
    const f = fixture({ metadata })
    expect(await f.run()).toHaveProperty('status', 'rejected')
    expect(f.writes()).toHaveLength(0)
    expect(f.signOutIfCurrent).toHaveBeenCalledTimes(metadata === '401' ? 1 : 0)
  })

  it('rejects a late account switch without using metadata from the old login', async () => {
    const f = fixture()
    f.transport.fetch.mockImplementationOnce(async () => {
      f.switchAccount()
      return { response: Response.json({}), snapshot: 1 }
    })
    expect(await f.run()).toHaveProperty('status', 'rejected')
    expect(f.writes()).toHaveLength(0)
  })

  it('rechecks the bound actor and intent after metadata before the fresh current-item lookup', async () => {
    const f = fixture()
    f.assertCurrent.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => { throw new Error('本轮意见已变化') })
    expect(await f.run()).toHaveProperty('status', 'rejected')
    expect(f.assertBeforeDispatch).not.toHaveBeenCalled()
    expect(f.writes()).toHaveLength(0)
  })

  it('calls the fresh version validator only after tools/list, and never after the write', async () => {
    const f = fixture()
    f.assertBeforeDispatch.mockImplementation(async () => {
      expect(f.calls.map(call => call.method)).toEqual(['tools/list'])
      throw new Error('当前事项版本变化')
    })
    expect(await f.run()).toHaveProperty('status', 'rejected')
    expect(f.assertBeforeDispatch).toHaveBeenCalledOnce()
    expect(f.writes()).toHaveLength(0)
  })

  it.each(['lost', '428', 'malformed'] as const)('keeps dispatched %s unknown and sends no second write', async (write) => {
    const f = fixture({ write })
    expect(await f.run()).toHaveProperty('status', 'unknown')
    expect(f.writes()).toHaveLength(1)
    expect(f.assertBeforeDispatch).toHaveBeenCalledOnce()
  })

  it.each([
    { ...args, confirm: true }, { ...args, requiresConfirmation: false },
    { ...args, params: { ...args.params, confirm: 'true' } },
    { ...args, params: { ...args.params, requiresConfirmation: 'false' } },
  ])('rejects model or caller confirmation injection %j', async (input) => {
    const f = fixture()
    expect(await f.run(true, f.assertBeforeDispatch, input)).toMatchObject({ status: 'rejected', code: 'APPROVAL_ACTION_INVALID' })
    expect(f.calls).toHaveLength(0)
  })
})

describe('current approval declaration parsing', () => {
  const context = { requestId: 'approval-current', businessObject: { objectName: 'forge_quotation', recordId: 'quotation-current' }, sourceMaterialVersion: 'a'.repeat(64) }
  const entry = { label: '驳回报价', description: '当前本人原生动作', execution: { tool: 'run_action', actionName: args.actionName,
    objectName: args.objectName, recordId: args.recordId,
    params: { approvalRequestId: 'approval-current', itemVersion: 'item-current', sourceMaterialVersion: 'a'.repeat(64) } },
  inputs: [{ name: 'comment', type: 'string', label: '办理意见', required: true }] }

  it.each([true, false])('retains explicit %s from the server declaration', (requiresConfirmation) => {
    expect(parseCurrentApprovalActions([{ ...entry, execution: { ...entry.execution, requiresConfirmation } }], context)?.[0].execution.requiresConfirmation)
      .toBe(requiresConfirmation)
  })
  it('preserves missing confirmation as unknown for read-only context compatibility', () => {
    expect(parseCurrentApprovalActions([entry], context)?.[0].execution).not.toHaveProperty('requiresConfirmation')
  })
  it.each(['true', null, 1])('rejects nonboolean %j', (requiresConfirmation) => {
    expect(() => parseCurrentApprovalActions([{ ...entry, execution: { ...entry.execution, requiresConfirmation } }], context)).toThrow()
  })
  it('never exposes a confirmation member as an employee/model input', () => {
    expect(() => parseCurrentApprovalActions([{ ...entry, inputs: [{ name: 'confirm', type: 'string', label: '确认', required: true }] }], context)).toThrow()
  })
})

function callerFixture() {
  const f = fixture()
  const context: EnterpriseApprovalContext = {
    requestId: 'approval-current', status: 'pending', viewer: 'current_approver', title: '报价审批', step: '本人核价',
    businessObject: { objectName: args.objectName, recordId: args.recordId }, sourceMaterialVersion: 'a'.repeat(64), fields: [], files: [],
    availableActions: [{ semantic: 'reject', label: '驳回报价', description: '本轮本人动作',
      execution: { tool: 'run_action', actionName: args.actionName, objectName: args.objectName, recordId: args.recordId,
        requiresConfirmation: true, params: { approvalRequestId: 'approval-current', itemVersion: 'item-current', sourceMaterialVersion: 'a'.repeat(64) } },
      inputs: [{ name: 'comment', type: 'string', label: '办理意见', required: true }] }],
  }
  const initial = structuredClone(context), action = initial.availableActions![0]
  const nativeReceipt = { decision: 'reject', status: 'rejected', requestId: 'approval-current', recordId: args.recordId,
    itemVersion: 'item-current', sourceMaterialVersion: 'a'.repeat(64), resumed: false, autoRejected: false, alreadyApplied: false }
  const fetch = f.transport.fetch.getMockImplementation()!
  f.transport.fetch.mockImplementation(async (init) => {
    const request = JSON.parse(String(init.body)) as typeof f.calls[number]
    if (request.method === 'tools/call') {
      f.calls.push(request)
      return { response: Response.json({ jsonrpc: '2.0', id: request.id,
        result: { structuredContent: { action: args.actionName, objectName: args.objectName, recordId: args.recordId, ok: true, result: nativeReceipt } } }), snapshot: 1 }
    }
    return fetch(init)
  })
  const service = {
    getApprovalContext: vi.fn(async (_requestId: string) => structuredClone(context)), accountKey: vi.fn(async () => 'employee-a'),
    getApprovalActionHistory: vi.fn(async () => []), getSession: vi.fn(async () => ({ status: 'signed-in', user: { id: 'employee' } })),
    runNativeMcpAction: vi.fn(async (input: NativeMcpActionArguments, assertCurrent: () => Promise<void>, required?: boolean, before?: () => Promise<void>) =>
      callNativeMcpRunAction(input, assertCurrent, f.transport, required, before)),
  }
  const version = currentItemContextFingerprint(initial), accountCheck = vi.fn()
  const attempts = new Map<string, ApprovalUiAttempt>()
  const ui = () => completeViewedApproval(service, 'approval-current', 'forge:approval:approval-current', 'employee-a',
    { actionRef: digest(JSON.stringify(action)), actionVersion: version, comment: args.params.comment }, attempts, accountCheck)
  const binding = { purpose: 'review' as const, accountKey: 'employee-a', sessionPath: '/session/current-review', fingerprint: version, context: initial }
  const runtime: CurrentItemActionRuntime = {
    service: service as unknown as CurrentItemActionRuntime['service'],
    claim: { token: 'fixture-capability', sessionPath: binding.sessionPath } as CurrentItemActionRuntime['claim'],
    turn: { key: 'turn-current', prompt: '请按本轮意见驳回', accountKey: 'employee-a', messageId: 'employee-current', enterpriseReadOnly: true },
    bound: binding, contextChanged: false, attempts: new Map(), refs: new Map([['1', { action, accountKey: 'employee-a', requestId: 'approval-current',
      sessionPath: binding.sessionPath, turnKey: 'turn-current', messageId: 'employee-current', contextFingerprint: version, baselineHistoryIds: [] }]]),
    assertCurrent: vi.fn(async () => { accountCheck() }),
    getCurrentContext: vi.fn(async () => {
      const latest = await service.getApprovalContext('approval-current')
      if (currentItemContextFingerprint(latest) !== version) throw new Error('当前事项变化')
      return latest
    }),
  }
  const pi = () => runCurrentItemAction({ turn_key: 'turn-current', action_ref: '1', comment: args.params.comment }, runtime)
  return { f, context, service, ui, pi, accountCheck, nativeReceipt, runtime }
}

describe('UI and Pi share the fresh native confirmation boundary', () => {
  it.each(['ui', 'pi'] as const)('%s sends one Host-confirmed call after a second current-item read', async (caller) => {
    const c = callerFixture()
    await c[caller]()
    expect(c.service.getApprovalContext).toHaveBeenCalledTimes(2)
    expect(c.f.writes()).toHaveLength(1)
    expect(c.f.writes()[0].params?.arguments).toEqual({ ...args, confirm: true })
  })

  it.each(['ui', 'pi'] as const)('%s catches a declaration/version change after tools/list with zero writes', async (caller) => {
    const c = callerFixture(), fetch = c.f.transport.fetch.getMockImplementation()!
    c.f.transport.fetch.mockImplementation(async (init) => {
      const response = await fetch(init)
      c.context.availableActions![0].execution.requiresConfirmation = false
      return response
    })
    if (caller === 'ui') await expect(c.ui()).rejects.toThrow()
    else expect(await c.pi()).toHaveProperty('outcome', 'rejected')
    expect(c.f.writes()).toHaveLength(0)
  })

  it.each(['ui', 'pi'] as const)('%s catches an account/intent change during the late read with zero writes', async (caller) => {
    const c = callerFixture()
    c.service.getApprovalContext.mockImplementationOnce(async () => structuredClone(c.context)).mockImplementationOnce(async () => {
      c.accountCheck.mockImplementation(() => { throw new Error('本轮员工已变化') })
      return structuredClone(c.context)
    })
    if (caller === 'ui') await expect(c.ui()).rejects.toThrow()
    else expect(await c.pi()).toHaveProperty('outcome', 'rejected')
    expect(c.f.writes()).toHaveLength(0)
  })

  it.each(['ui', 'pi'] as const)('%s accepts the matched receipt when the current item disappears after dispatch', async (caller) => {
    const c = callerFixture(), fetch = c.f.transport.fetch.getMockImplementation()!
    c.f.transport.fetch.mockImplementation(async (init) => {
      const response = await fetch(init)
      if ((JSON.parse(String(init.body)) as { method: string }).method === 'tools/call') c.service.getApprovalContext.mockRejectedValue(new Error('事项已终态'))
      return response
    })
    await c[caller]()
    expect(c.f.writes()).toHaveLength(1)
    expect(c.service.getApprovalContext).toHaveBeenCalledTimes(2)
  })

  it.each(['ui', 'pi'] as const)('%s preserves unknown and never resends it on a second invocation', async (caller) => {
    const c = callerFixture(), fetch = c.f.transport.fetch.getMockImplementation()!
    c.f.transport.fetch.mockImplementation(async (init) => {
      const request = JSON.parse(String(init.body)) as typeof c.f.calls[number]
      if (request.method === 'tools/call') { c.f.calls.push(request); throw new Error('回执丢失') }
      return fetch(init)
    })
    if (caller === 'ui') { await expect(c.ui()).rejects.toThrow(); await expect(c.ui()).rejects.toThrow() }
    else { expect(await c.pi()).toHaveProperty('outcome', 'unknown'); expect(await c.pi()).toHaveProperty('outcome', 'unknown') }
    expect(c.f.writes()).toHaveLength(1)
  })
})
