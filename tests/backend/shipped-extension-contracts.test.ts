import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionAPI } from 'prime-agent'
import { EXTENSION_INJECTIONS, SHIPPED_EXTENSION_FILENAMES, type ExtensionInjection } from '../../electron/main/extension-manifest'
import type { WorkExtensionApi } from '../../assets/extensions/gooeypi-work-browser'
import type { PiFastModeExtensionApi } from '../../assets/extensions/pi-work-fast-mode'

type Registration = { kind: 'tool' | 'command' | 'event'; name: string }

interface Fixture {
  api: object
  registrations: Registration[]
  tools?: unknown[]
  handlers?: Map<string, (event: { prompt: string }) => Promise<void>>
}

type PrimeFixtureApi = Pick<ExtensionAPI, 'registerTool' | 'on'>
type PiFixtureApi = PiFastModeExtensionApi & Omit<WorkExtensionApi, 'typebox'>

function primeHost(): Fixture {
  const registrations: Registration[] = []
  const target: PrimeFixtureApi = {
    on: (event) => { registrations.push({ kind: 'event', name: event }) },
    registerTool: (tool) => { registrations.push({ kind: 'tool', name: tool.name }) },
  }
  const api = new Proxy(target, {
    get(object, property, receiver) {
      if (typeof property === 'symbol' || property === 'then' || property === 'constructor') return Reflect.get(object, property, receiver)
      // Model the absent optional shim that shipped files probe before using their dynamic-import fallback.
      if (property === 'typebox') return undefined
      if (!(property in object)) throw new Error(`Prime fixture does not inject ${String(property)}`)
      return Reflect.get(object, property, receiver)
    },
  })
  return { api, registrations }
}

function piHost(): Fixture {
  const registrations: Registration[] = []
  const tools: unknown[] = []
  const handlers = new Map<string, (event: { prompt: string }) => Promise<void>>()
  const target: PiFixtureApi = {
    registerTool: (tool) => { registrations.push({ kind: 'tool', name: tool.name }); tools.push(tool) },
    registerCommand: (name: string) => { registrations.push({ kind: 'command', name }) },
    on: (event: string, handler: unknown) => {
      registrations.push({ kind: 'event', name: event })
      handlers.set(event, handler as (event: { prompt: string }) => Promise<void>)
    },
  }
  const api = new Proxy(target, {
    get(object, property, receiver) {
      if (typeof property === 'symbol' || property === 'then' || property === 'constructor') return Reflect.get(object, property, receiver)
      // Model the absent optional shim that shipped files probe before using their dynamic-import fallback.
      if (property === 'typebox') return undefined
      if (!(property in object)) throw new Error(`Pi fixture does not inject ${String(property)}`)
      return Reflect.get(object, property, receiver)
    },
  })
  return { api, registrations, tools, handlers }
}

const fixtureFactories = {
  prime: primeHost,
  pi: piHost,
}

const expectedRegistrations: Record<string, Registration[]> = {
  'prime-work-browser.ts': [
    ...['terminal_read', 'browser_tabs', 'browser_navigate', 'browser_screenshot', 'browser_read_page', 'browser_click', 'browser_type', 'browser_press_key', 'browser_scroll', 'browser_evaluate'].map((name) => ({ kind: 'tool' as const, name })),
  ],
  'gooeypi-work-browser.ts': [
    ...['terminal_read', 'browser_tabs', 'browser_navigate', 'browser_screenshot', 'browser_read_page', 'browser_click', 'browser_type', 'browser_press_key', 'browser_scroll', 'browser_evaluate'].map((name) => ({ kind: 'tool' as const, name })),
  ],
  'gooeypi-work-ask-user.ts': [{ kind: 'tool', name: 'ask_user' }],
  'gooeypi-work-collaboration.ts': [
    ...['gooeypi_session_list', 'gooeypi_session_models', 'gooeypi_session_create', 'gooeypi_session_read', 'gooeypi_session_send', 'gooeypi_session_wait'].map((name) => ({ kind: 'tool' as const, name })),
  ],
  'gooeypi-enterprise.ts': [
    { kind: 'event', name: 'before_agent_start' },
    ...['gooeypi_enterprise_initialization_workbook', 'gooeypi_enterprise_initialization_list', 'gooeypi_enterprise_initialization_run'].map((name) => ({ kind: 'tool' as const, name })),
    ...['gooeypi_enterprise_client_sessions', 'gooeypi_enterprise_client_session_revoke', 'gooeypi_enterprise_material_read', 'gooeypi_enterprise_team_search', 'gooeypi_enterprise_team_describe', 'gooeypi_enterprise_business_objects', 'gooeypi_enterprise_business_record_find', 'gooeypi_enterprise_business_record_read', 'gooeypi_enterprise_work_submit', 'gooeypi_enterprise_work_recover', 'gooeypi_enterprise_work_authorization_renew', 'gooeypi_enterprise_current_business_material', 'gooeypi_enterprise_current_item_actions', 'gooeypi_enterprise_current_item_action', 'gooeypi_approval_revision_submit'].map((name) => ({ kind: 'tool' as const, name })),
  ],
  'gooeypi-team-development.ts': [
    { kind: 'tool', name: 'gooeypi_team_development_list' },
    { kind: 'tool', name: 'gooeypi_team_development_open' },
    { kind: 'tool', name: 'gooeypi_team_development_create' },
    { kind: 'tool', name: 'gooeypi_team_development_export' },
    { kind: 'tool', name: 'gooeypi_team_development_import' },
    { kind: 'tool', name: 'gooeypi_team_development_models' },
    { kind: 'tool', name: 'gooeypi_team_development_configure_model' },
    { kind: 'tool', name: 'gooeypi_team_development_workspace_guide' },
    { kind: 'tool', name: 'gooeypi_team_development_workspace_apply' },
    { kind: 'tool', name: 'gooeypi_team_development_context' },
    { kind: 'tool', name: 'gooeypi_team_development_guide' },
    { kind: 'tool', name: 'gooeypi_team_development_preview' },
    { kind: 'tool', name: 'gooeypi_team_development_save' },
    { kind: 'tool', name: 'gooeypi_team_development_trial' },
    { kind: 'tool', name: 'gooeypi_team_development_trial_status' },
    { kind: 'tool', name: 'gooeypi_team_development_trial_outputs' },
    { kind: 'tool', name: 'gooeypi_team_development_trial_output' },
    { kind: 'tool', name: 'gooeypi_team_development_update_team' },
  ],
  'gooeypi-work-schedules.ts': [
    ...['scheduled_tasks_list', 'scheduled_task_create_once', 'scheduled_task_create_recurring', 'scheduled_task_update', 'scheduled_task_manage'].map((name) => ({ kind: 'tool' as const, name })),
  ],
  'pi-work-fast-mode.ts': [
    { kind: 'command', name: 'gooeypi-fast-mode' },
    { kind: 'event', name: 'before_provider_request' },
  ],
}

const brokerVariables: Partial<Record<ExtensionInjection['capability'], readonly [string, string]>> = {
  browser: ['PRIME_WORK_BROWSER_URL', 'PRIME_WORK_BROWSER_TOKEN'],
  schedule: ['PRIME_WORK_SCHEDULE_URL', 'PRIME_WORK_SCHEDULE_TOKEN'],
  collaboration: ['GOOEYPI_COLLABORATION_URL', 'GOOEYPI_COLLABORATION_TOKEN'],
  enterprise: ['GOOEYPI_ENTERPRISE_URL', 'GOOEYPI_ENTERPRISE_TOKEN'],
  teamDevelopment: ['GOOEYPI_TEAM_DEVELOPMENT_URL', 'GOOEYPI_TEAM_DEVELOPMENT_TOKEN'],
}

const LEGACY_UNPREFIXED_TOOLS = [
  'ask_user', 'terminal_read', 'browser_tabs', 'browser_navigate', 'browser_screenshot', 'browser_read_page',
  'browser_click', 'browser_type', 'browser_press_key', 'browser_scroll', 'browser_evaluate',
  'scheduled_tasks_list', 'scheduled_task_create_once', 'scheduled_task_create_recurring',
  'scheduled_task_update', 'scheduled_task_manage',
]

async function loadExtension(injection: ExtensionInjection, configured: boolean) {
  vi.resetModules()
  vi.unstubAllEnvs()
  const variables = brokerVariables[injection.capability]
  if (configured && variables) {
    vi.stubEnv(variables[0], 'http://127.0.0.1:1/')
    vi.stubEnv(variables[1], 'inert-test-token')
  }
  const url = pathToFileURL(join(process.cwd(), 'assets', 'extensions', injection.filename)).href
  return (await import(url)).default as (api: object) => void | Promise<void>
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('shipped extension contracts', () => {
  it('keeps the enterprise handoff extension in the Pi runtime manifest', () => {
    expect(EXTENSION_INJECTIONS.pi).toContainEqual({
      capability: 'enterprise',
      filename: 'gooeypi-enterprise.ts',
      environmentVariable: 'GOOEYPI_ENTERPRISE_EXTENSION_PATH',
    })
    expect(SHIPPED_EXTENSION_FILENAMES).toContain('gooeypi-enterprise.ts')
  })

  it('initializes every manifest injection against its genuine host surface', async () => {
    for (const filename of SHIPPED_EXTENSION_FILENAMES) {
      expect(expectedRegistrations[filename], `Missing registration contract for ${filename}`).toBeDefined()
    }
    for (const [harness, injections] of Object.entries(EXTENSION_INJECTIONS)) {
      for (const injection of injections) {
        for (const configured of [false, true]) {
          const fixture = fixtureFactories[harness as keyof typeof fixtureFactories]()
          const factory = await loadExtension(injection, configured)
          await factory(fixture.api)
          const expected = expectedRegistrations[injection.filename]
          expect(fixture.registrations, `${harness}/${injection.filename} configured=${configured}`).toEqual(
            configured || !brokerVariables[injection.capability] ? expected : [],
          )
        }
      }
    }
  })

  it('routes Pi team-development tools to the scoped desktop bridge and carries no operation shapes of its own', async () => {
    const requests: Array<{ url: string; options?: RequestInit; body: Record<string, unknown> }> = []
    let rejectNext = false
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
      const body = JSON.parse(String(options?.body)) as Record<string, unknown>
      requests.push({ url: String(input), options, body })
      if (rejectNext) {
        rejectNext = false
        return Response.json({ ok: false, error: '团队草稿版本已变化' })
      }
      const result = body.method === 'list' ? { teams: [{ name: '反馈分类团队' }] }
        : body.method === 'preview' ? { changes: ['修改成员：整理员'] }
          : { method: body.method }
      return Response.json({ ok: true, result })
    }))
    const injection = EXTENSION_INJECTIONS.pi.find((candidate) => candidate.filename === 'gooeypi-team-development.ts')!
    const fixture = piHost()
    const factory = await loadExtension(injection, true)
    await factory(fixture.api)
    const tools = new Map((fixture.tools as Array<{ name: string; execute(id: string, params: Record<string, unknown>): Promise<{ content: Array<{ text: string }> }> }>).map((tool) => [tool.name, tool]))

    const listed = await tools.get('gooeypi_team_development_list')!.execute('list', {})
    expect(listed.content[0]?.text).toContain('反馈分类团队')
    await tools.get('gooeypi_team_development_open')!.execute('open', { team_name: '反馈分类团队' })
    expect(tools.has('gooeypi_team_development_propose_new')).toBe(false)
    const created = await tools.get('gooeypi_team_development_create')!.execute('create', { name: '反馈团队', objective: '归类员工反馈' })
    expect(created.content[0]?.text).toContain('create')
    // What may be changed, and how each change is written, comes from Weave through the bridge.
    expect(JSON.parse((await tools.get('gooeypi_team_development_context')!.execute('context', {})).content[0]!.text)).toEqual({ method: 'context' })
    expect((await tools.get('gooeypi_team_development_guide')!.execute('guide', { topic: 'member' })).content[0]?.text).toContain('guide')
    const described = (fixture.tools as Array<{ name: string; description: string; promptGuidelines?: string[] }>).filter((tool) => tool.name.startsWith('gooeypi_team_development_'))
    for (const tool of described) expect(`${tool.description}${(tool.promptGuidelines ?? []).join('')}`).not.toMatch(/右侧|侧栏|面板|kind:/)
    const previewed = await tools.get('gooeypi_team_development_preview')!.execute('preview', { operations_json: '[{"kind":"member","member":"整理员","duty":"按模块分类"}]' })
    expect(previewed.content[0]?.text).toContain('修改成员：整理员')
    const saved = await tools.get('gooeypi_team_development_save')!.execute('save', { operations_json: '[{"kind":"member","member":"整理员","duty":"按模块分类"}]' })
    expect(saved.content[0]?.text).toContain('save')
    await tools.get('gooeypi_team_development_trial')!.execute('hidden-tool-call-id', { workflow_name: '分类流程', input: '测试材料', simulation_actions: ['提交合同'] })
    await tools.get('gooeypi_team_development_trial_status')!.execute('status', {})
    await tools.get('gooeypi_team_development_update_team')!.execute('publish', {})
    expect(requests.map(({ body }) => body.method)).toEqual(['list', 'open', 'create', 'context', 'guide', 'preview', 'save', 'trial', 'trial_status', 'update_team'])
    expect(requests[2]?.body.params).toEqual({ name: '反馈团队', objective: '归类员工反馈' })
    expect(requests[4]?.body.params).toEqual({ topic: 'member' })
    expect(requests[5]?.body.params).toEqual({ operations: [{ kind: 'member', member: '整理员', duty: '按模块分类' }] })
    expect(requests[7]?.body.params).toEqual({ workflow_name: '分类流程', input: '测试材料', simulation_actions: ['提交合同'] })
    expect(JSON.stringify(requests)).not.toContain('hidden-tool-call-id')
    for (const request of requests) expect(new Headers(request.options?.headers).get('authorization')).toBe('Bearer inert-test-token')
    await expect(tools.get('gooeypi_team_development_preview')!.execute('invalid', { operations_json: '{' })).rejects.toThrow('不是有效 JSON 数组')
    expect(requests).toHaveLength(10)
    rejectNext = true
    await expect(tools.get('gooeypi_team_development_open')!.execute('stale', { team_name: '反馈分类团队' })).rejects.toThrow('团队草稿版本已变化')
  })

  it('requires an employee turn before Pi can search authorized teams', async () => {
    const requests: Array<{ body: Record<string, unknown>; options?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, options?: RequestInit) => {
      const body = JSON.parse(String(options?.body)) as Record<string, unknown>
      requests.push({ body, options })
      const result = body.method === 'activate' ? { turn_key: 'employee-turn' } : { choices: [{ name: '报价核对团队' }] }
      return Response.json({ ok: true, result })
    }))
    const injection = EXTENSION_INJECTIONS.pi.find((candidate) => candidate.filename === 'gooeypi-enterprise.ts')!
    const fixture = piHost()
    const factory = await loadExtension(injection, true)
    await factory(fixture.api)
    const tools = new Map((fixture.tools as Array<{ name: string; execute(id: string, params: Record<string, unknown>): Promise<{ content: Array<{ text: string }> }> }>).map((tool) => [tool.name, tool]))
    const search = tools.get('gooeypi_enterprise_team_search')!

    await expect(search.execute('before-turn', { work_summary: '核对报价明细' })).rejects.toThrow('当前没有已绑定的员工轮次')
    await fixture.handlers?.get('before_agent_start')?.({ prompt: '请帮我核对这份报价。' })
    const result = await search.execute('search', { work_summary: '核对报价明细' })
    expect(result.content[0]?.text).toContain('报价核对团队')
    expect(requests.map(({ body }) => body.method)).toEqual(['activate', 'search'])
    expect(requests[1]?.body.params).toEqual({ work_summary: '核对报价明细', turn_key: 'employee-turn' })
    expect(new Headers(requests[0]?.options?.headers).get('authorization')).toBe('Bearer inert-test-token')
  })

  it('routes initialization through static list/run tools and leaves operation keys and confirmation with Host', async () => {
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, options?: RequestInit) => {
      const body = JSON.parse(String(options?.body)) as { method: string; params: Record<string, unknown> }
      requests.push(body)
      return Response.json({ ok: true, result: body.method === 'activate' ? { turn_key: 'employee-turn' } : { version: '1', status: 'succeeded' } })
    }))
    const injection = EXTENSION_INJECTIONS.pi.find(candidate => candidate.filename === 'gooeypi-enterprise.ts')!
    const fixture = piHost(), factory = await loadExtension(injection, true)
    await factory(fixture.api)
    const tools = new Map((fixture.tools as Array<{ name: string; parameters: { properties: Record<string, unknown> }; execute(id: string, params: Record<string, unknown>): Promise<unknown> }>).map(tool => [tool.name, tool]))
    await fixture.handlers?.get('before_agent_start')?.({ prompt: '创建计量单位台' })
    await tools.get('gooeypi_enterprise_initialization_list')!.execute('list', {})
    const params = { object_name: 'forge_business_setting_option', action_name: 'initialization_units', inputs_json: JSON.stringify({ fields_json: '{"name":"台"}' }), employee_request: '创建计量单位台' }
    await tools.get('gooeypi_enterprise_initialization_run')!.execute('run', params)
    expect(requests.map(request => request.method)).toEqual(['activate', 'initialization_list', 'initialization_run'])
    expect(requests[2]!.params).toEqual({ ...params, turn_key: 'employee-turn' })
    const schema = tools.get('gooeypi_enterprise_initialization_run')!.parameters
    for (const name of ['operation_key', 'confirm', 'actorId', 'plan_key', 'mapping_key']) expect(schema.properties).not.toHaveProperty(name)
    expect(tools.has('gooeypi_enterprise_initialization_preview')).toBe(false)
    expect(tools.has('gooeypi_enterprise_initialization_apply')).toBe(false)
  })

  it('registers Forge record reads without a team handoff key', async () => {
    const requests: Array<{ body: Record<string, unknown> }> = []
    const objectRef = 'a'.repeat(32), recordKey = 'b'.repeat(32)
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, options?: RequestInit) => {
      const body = JSON.parse(String(options?.body)) as Record<string, unknown>
      requests.push({ body })
      const result = body.method === 'activate' ? { turn_key: 'employee-turn' }
        : body.method === 'list_business_objects' ? { status: 'complete', objects: [{ object_ref: objectRef, name: '销售合同' }] }
          : body.method === 'find_business_record' ? { status: 'candidate', records: [{ record_key: recordKey, name: '测试合同' }] }
            : { status: 'read', record_key: recordKey, complete: true }
      return Response.json({ ok: true, result })
    }))
    const injection = EXTENSION_INJECTIONS.pi.find((candidate) => candidate.filename === 'gooeypi-enterprise.ts')!
    const fixture = piHost()
    const factory = await loadExtension(injection, true)
    await factory(fixture.api)
    const tools = new Map((fixture.tools as Array<{
      name: string
      parameters: unknown
      execute(id: string, params: Record<string, unknown>): Promise<{ content: Array<{ text: string }> }>
    }>).map((tool) => [tool.name, tool]))
    const directoryTool = tools.get('gooeypi_enterprise_business_objects')!
    const findTool = tools.get('gooeypi_enterprise_business_record_find')!
    const readTool = tools.get('gooeypi_enterprise_business_record_read')!
    await fixture.handlers?.get('before_agent_start')?.({ prompt: '只读核对这条业务记录。' })

    const directory = JSON.parse((await directoryTool.execute('directory', {})).content[0]!.text) as { objects: Array<{ object_ref: string }> }
    const found = JSON.parse((await findTool.execute('find', { object_ref: objectRef, work_summary: '测试合同' })).content[0]!.text) as { records: Array<{ record_key: string }> }
    await readTool.execute('read', { record_key: recordKey })

    const directorySchema = directoryTool.parameters as { properties?: Record<string, unknown>; required?: string[] }
    const findSchema = findTool.parameters as { properties?: Record<string, unknown>; required?: string[] }
    const readSchema = readTool.parameters as { properties?: Record<string, unknown>; required?: string[] }
    expect(directorySchema.properties).toEqual({})
    expect(findSchema.properties).not.toHaveProperty('handoff_key')
    expect(readSchema.properties).not.toHaveProperty('handoff_key')
    expect(directory.objects[0]?.object_ref).toBe(objectRef)
    expect(found.records[0]?.record_key).toBe(recordKey)
    expect(requests.map(({ body }) => body.method)).toEqual(['activate', 'list_business_objects', 'find_business_record', 'read_business_record'])
    expect(requests.slice(1).map(({ body }) => body.params)).toEqual([
      { turn_key: 'employee-turn' },
      { object_ref: objectRef, work_summary: '测试合同', turn_key: 'employee-turn' },
      { record_key: recordKey, turn_key: 'employee-turn' },
    ])
  })

  it('uses the original recovery key only after the employee explicitly continues the frozen handoff', async () => {
    const requests: Array<{ body: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, options?: RequestInit) => {
      const body = JSON.parse(String(options?.body)) as Record<string, unknown>
      requests.push({ body })
      const result = body.method === 'activate' ? { turn_key: 'employee-turn' }
        : { status: 'accepted' }
      return Response.json({ ok: true, result })
    }))
    const injection = EXTENSION_INJECTIONS.pi.find((candidate) => candidate.filename === 'gooeypi-enterprise.ts')!
    const fixture = piHost()
    const factory = await loadExtension(injection, true)
    await factory(fixture.api)
    const tools = new Map((fixture.tools as Array<{
      name: string
      description?: string
      promptGuidelines?: string[]
      execute(id: string, params: Record<string, unknown>): Promise<{ content: Array<{ text: string }> }>
    }>).map((tool) => [tool.name, tool]))
    const recover = tools.get('gooeypi_enterprise_work_recover')!

    await expect(recover.execute('recover-before-turn', { recovery_key: 'a'.repeat(64) })).rejects.toThrow('当前没有已绑定的员工轮次')
    await fixture.handlers?.get('before_agent_start')?.({ prompt: '继续核对同一冻结请求。' })
    const recovered = await recover.execute('recover', { recovery_key: 'a'.repeat(64) })
    expect(recovered.content[0]?.text).toContain('accepted')
    expect(recover.description).toContain('核对刚才那次交接')
    expect(recover.promptGuidelines?.join('\n')).toContain('不按单个关键词触发')
    expect(recover.promptGuidelines?.join('\n')).toContain('绝不向员工展示、朗读或要求员工复制')
    expect(recover.promptGuidelines?.join('\n')).toContain('原业务动作范围保持冻结')
    expect(recover.promptGuidelines?.join('\n')).toContain('Forge 会重新校验当前权限')
    expect(recover.promptGuidelines?.join('\n')).toContain('不能改用提交工具另建工作来绕过')
    expect(recover.promptGuidelines?.join('\n')).not.toContain('只询问状态时不得调用')

    expect(requests.map(({ body }) => body.method)).toEqual(['activate', 'recover'])
    expect(requests[1]?.body.params).toEqual({ recovery_key: 'a'.repeat(64), turn_key: 'employee-turn' })
  })

  it('keeps tool registrations namespaced', () => {
    // The allow-list only shrinks as legacy tools are renamed. See #192.
    for (const registrations of Object.values(expectedRegistrations)) {
      for (const registration of registrations) {
        if (registration.kind !== 'tool') continue
        expect(registration.name.startsWith('gooeypi_') || LEGACY_UNPREFIXED_TOOLS.includes(registration.name)).toBe(true)
      }
    }
  })

  it('rejects properties outside each host fixture from the proxy trap', () => {
    for (const [harness, factory] of Object.entries(fixtureFactories)) {
      const fixture = factory()
      expect(() => Reflect.get(fixture.api, 'unsupportedCapability'), harness).toThrow(`${harness === 'prime' ? 'Prime' : 'Pi'} fixture does not inject unsupportedCapability`)
    }
  })

  it('derives the shipped inventory from the actual extension directory', () => {
    const actual = readdirSync(join(process.cwd(), 'assets', 'extensions'), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => entry.name)
      .sort()
    expect(SHIPPED_EXTENSION_FILENAMES).toEqual(actual)
  })
})
