import { describe, expect, it, vi } from 'vitest'
import { newEnterpriseService, signInAs } from '../helpers/browser-sign-in'
import { dispatchInitialization, type InitializationScope } from '../../electron/main/enterprise/initialization'
import { HandoffStore } from '../../electron/main/enterprise/handoff-store'
import { parseInitializationCatalog, validateInitializationInputs } from '../../electron/main/enterprise/initialization-catalog'

it('accepts the native stock opening reviewer reference as a user parameter', () => {
  const [action] = parseInitializationCatalog({ actions: [{ objectName: 'forge_opening_inbound', name: 'opening_inbound_draft_create',
    requiresRecord: false, requiresConfirmation: true, params: [{ name: 'review_owner_id', type: 'user' }] }] })
  expect(() => validateInitializationInputs(action, { review_owner_id: 'assigned-reviewer' })).not.toThrow()
  expect(() => validateInitializationInputs(action, { review_owner_id: 17 })).toThrow('请按 Forge 声明提供')
})

const objectName = 'forge_business_setting_option'
async function fixture(options: { recordRequired?: boolean; confirmSchema?: boolean; status?: number; sse?: boolean; nativeError?: { code: string; message: string } } = {}) {
  const calls: Array<{ path: string; authorization: string | null; body?: Record<string, unknown> }> = []
  const actions = [
    { name: 'initialization_readiness', objectName, label: '读取初始化要求', requiresRecord: false, requiresConfirmation: false, params: [] },
    { name: 'initialization_units', objectName, label: '初始化计量单位', requiresRecord: false, requiresConfirmation: false, params: [{ name: 'fields_json', type: 'string', required: true }, { name: 'operation_key', type: 'string', required: true }] },
    { name: 'initialization_positions', objectName, label: '初始化岗位', requiresRecord: false, requiresConfirmation: true, params: [{ name: 'fields_json', type: 'string', required: true }, { name: 'operation_key', type: 'string', required: true }] },
    { name: 'initialization_operation_result', objectName, label: '核对原操作', requiresRecord: false, requiresConfirmation: false, params: [{ name: 'operation_key', type: 'string', required: true }] },
    { name: 'opening_inbound_approve', objectName: 'forge_opening_inbound', label: '同意入库', requiresRecord: true, requiresConfirmation: true, params: [{ name: 'approval_note', type: 'string', required: true }] },
    { name: 'delete_all', objectName: 'forge_customer' },
  ]
  const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
    calls.push({ path, authorization: new Headers(init?.headers).get('Authorization'), body })
    if (path === '/__test/approving-account') return Response.json({ token: 'host-native-token', user: { id: 'administrator' } })
    if (path === '/v1/auth/external/exchange') return Response.json({ token: 'host-weave-token', subject: { id: 'administrator' }, organization: { id: 'org' }, issuer: 'forge:test', permissions: ['teams:use'] })
    if (path === '/api/v1/mcp') {
      const params = body?.params as { name?: string; arguments?: { actionName?: string; objectName?: string; recordId?: string; params?: unknown; confirm?: boolean } } | undefined
      let result: Record<string, unknown>
      if (body?.method === 'tools/list') result = { tools: [{ name: 'run_action', inputSchema: {
        type: 'object', required: ['actionName', 'objectName', ...(options.recordRequired ? ['recordId'] : [])],
        properties: { actionName: { type: 'string' }, objectName: { type: 'string' }, recordId: { type: 'string' }, params: { type: 'object' },
          ...(options.confirmSchema === false ? {} : { confirm: { type: 'boolean' } }) },
      } }] }
      else if (params?.name === 'list_actions') {
        if (options.status) return Response.json({ error: 'denied' }, { status: options.status })
        result = { structuredContent: { actions }, content: [] }
      } else if (params?.name === 'run_action' && options.nativeError) {
        result = { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: options.nativeError }) }] }
      } else if (params?.name === 'run_action') {
        const args = params.arguments!
        const native = args.actionName === 'initialization_readiness'
          ? { version: '1', readOnly: true, domains: [{ label: '计量单位', state: 'missing', fields: [{ name: 'name', label: '名称' }] }] }
          : { version: '1', status: 'succeeded', operationId: '8cbe7c3c-6f01-4841-ad53-a4170c3b4d72', nativeRequestDigest: 'c'.repeat(64), outcomes: [{ name: '台' }] }
        const content = { ok: true, action: args.actionName, objectName: args.objectName, ...(args.recordId ? { recordId: args.recordId } : {}), result: native }
        result = { content: [{ type: 'text', text: JSON.stringify(content) }] }
      } else throw new Error('unexpected MCP tool')
      const envelope = { jsonrpc: '2.0', id: body?.id, result }
      return options.sse ? new Response(`event: message\ndata: ${JSON.stringify(envelope)}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } }) : Response.json(envelope)
    }
    return Response.json({}, { status: 404 })
  }) as typeof globalThis.fetch
  const service = newEnterpriseService({ environment: { WORKBENCH_FORGE_URL: 'http://forge.test', WORKBENCH_WEAVE_URL: 'http://weave.test' }, fetch })
  await signInAs(service, 'administrator@example.test')
  const scope: InitializationScope = { accountKey: 'administrator', sessionPath: 'ordinary-session', messageId: 'current-message', employeePrompt: '创建计量单位和岗位',
    list: () => service.listInitializationActions(), run: (...args) => service.runNativeInitializationAction(...args), store: new HandoffStore(), assertCurrent: vi.fn(async () => {}), reserveMutation: vi.fn() }
  const run = (actionName: string) => dispatchInitialization('initialization_run', { object_name: objectName, action_name: actionName,
    ...(actionName === 'initialization_readiness' ? {} : { inputs_json: '{"fields_json":"{\\"name\\":\\"台\\"}"}', employee_request: scope.employeePrompt }) }, scope)
  return { calls, actions, service, scope, run }
}

describe('EnterpriseService native initialization MCP transport', () => {
  it.each([
    ['INITIALIZATION_INPUT_INVALID', 'rejected'],
    ['INITIALIZATION_REQUIRED', 'rejected'],
    ['INITIALIZATION_OPERATION_NOT_FOUND', 'unknown'],
    ['INITIALIZATION_READBACK_FAILED', 'unknown'],
    ['INITIALIZATION_NEW_UNRECOGNIZED_ERROR', 'unknown'],
  ])('distinguishes explicit input rejection from unknown results for %s', async (code, status) => {
    const f = await fixture({ nativeError: { code, message: '请提供仓库地址' } })
    const attempt = await f.service.runNativeInitializationAction({ objectName, actionName: 'initialization_units', params: { fields_json: '{}' } },
      async () => {}, false, async () => {})
    expect(attempt).toMatchObject({ status, code })
    if (status === 'rejected') expect(attempt.message).toBe('请提供仓库地址')
  })
  it.each([false, true])('uses list_actions and native run_action with the Host session (SSE=%s)', async sse => {
    const f = await fixture({ sse })
    const list = await dispatchInitialization('initialization_list', {}, f.scope)
    expect(JSON.stringify(list)).not.toContain('delete_all')
    expect(JSON.stringify(list)).not.toContain('host-native-token')
    expect((await f.run('initialization_readiness')).domains).toEqual([{ label: '计量单位', state: 'missing', fields: [{ name: 'name', label: '名称' }] }])
    expect((await f.run('initialization_units')).status).toBe('succeeded')
    expect((await f.run('initialization_positions')).status).toBe('succeeded')
    const mcp = f.calls.filter(call => call.path === '/api/v1/mcp')
    expect(mcp.every(call => call.authorization === 'Bearer host-native-token')).toBe(true)
    expect(f.calls.some(call => call.path.includes('/workbench/initialization'))).toBe(false)
    const runs = mcp.filter(call => (call.body?.params as { name?: string } | undefined)?.name === 'run_action')
    const args = runs.map(call => (call.body!.params as { arguments: Record<string, unknown> }).arguments)
    expect(args[0]).toEqual({ objectName, actionName: 'initialization_readiness', params: {} })
    expect(args[1]).not.toHaveProperty('confirm')
    expect(args[2]).toHaveProperty('confirm', true)
    expect(args.every(arg => !Object.hasOwn(arg, 'recordId'))).toBe(true)
    expect(JSON.stringify(args)).not.toContain('host-native-token')
  })

  it('retains strict record binding in the approval helper and rejects a server requiring records', async () => {
    const f = await fixture({ recordRequired: true })
    expect((await f.run('initialization_readiness')).status).toBe('rejected')
    const invalid = { actionName: 'initialization_readiness', objectName, params: {} }
    await expect(f.service.runNativeMcpAction(invalid as Parameters<typeof f.service.runNativeMcpAction>[0], async () => {}, false, async () => {})).resolves.toMatchObject({ status: 'rejected' })
    expect(f.calls.filter(call => (call.body?.params as { name?: string } | undefined)?.name === 'run_action')).toHaveLength(0)
  })

  it('does not dispatch confirmation-required actions without native boolean confirmation support', async () => {
    const f = await fixture({ confirmSchema: false })
    expect((await f.run('initialization_positions')).status).toBe('rejected')
    expect(f.calls.filter(call => (call.body?.params as { name?: string } | undefined)?.name === 'run_action')).toHaveLength(0)
  })

  it.each([401, 403])('honors native authentication and permission rejection (%s)', async status => {
    const f = await fixture({ status })
    await expect(f.service.listInitializationActions()).rejects.toThrow()
    expect(f.calls.filter(call => (call.body?.params as { name?: string } | undefined)?.name === 'run_action')).toHaveLength(0)
  })
})
