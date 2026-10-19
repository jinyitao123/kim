import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loomCapabilityExtensions } from '../../electron/main/loom-capability-extensions'
import { LoomCapabilityHost, type CapabilityExtension } from '../../electron/main/loom-capabilities'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function startHost(): Promise<LoomCapabilityHost> {
  const directory = join(mkdtempSync(join(tmpdir(), 'loom-capabilities-')), 'configs')
  const host = new LoomCapabilityHost({ directory })
  await host.start()
  cleanups.push(() => host.stop(), () => rmSync(join(directory, '..'), { recursive: true, force: true }))
  return host
}

interface Config { url: string; headers: { Authorization: string }; toolPrefix: string }
function readConfig(path: string): Config {
  return (JSON.parse(readFileSync(path, 'utf8')) as { mcpServers: { gooeypi: Config } }).mcpServers.gooeypi
}

async function rpc(config: Config, body: Record<string, unknown>, auth = config.headers.Authorization): Promise<Response> {
  return fetch(config.url, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', ...body }) })
}

/** Reads server-sent events from a tools/call answer, handing each message to onMessage until it returns true. */
async function readEvents(response: Response, onMessage: (message: Record<string, unknown>) => Promise<boolean> | boolean): Promise<void> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return
    buffer += decoder.decode(value, { stream: true })
    for (let index = buffer.indexOf('\n\n'); index >= 0; index = buffer.indexOf('\n\n')) {
      const block = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      const data = block.split('\n').find((line) => line.startsWith('data: '))
      if (data && await onMessage(JSON.parse(data.slice(6)) as Record<string, unknown>)) { await reader.cancel(); return }
    }
  }
}

const sample: CapabilityExtension = {
  id: 'sample',
  register: (pi) => {
    pi.on('before_agent_start', (event) => { prompts.push(event.prompt) })
    pi.registerTool({
      name: 'sample_echo',
      description: 'Echo the text',
      promptGuidelines: ['Use only for tests.'],
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      async execute(_id, params: { text: string }) { return { content: [{ type: 'text', text: `echo ${params.text}` }] } },
    })
    pi.registerTool({
      name: 'sample_pick',
      description: 'Ask the user',
      parameters: { type: 'object', properties: {} },
      async execute(_id, _params, _signal, _update, context) {
        const choice = await context!.ui.select('Pick one', ['A', 'B'])
        return { content: [{ type: 'text', text: `picked ${choice}` }] }
      },
    })
  },
}
const prompts: string[] = []

describe('Loom capability host', () => {
  it('serves registered tools to the runtime that owns the token', async () => {
    const host = await startHost()
    const path = host.openRuntime([sample], {})
    const config = readConfig(path)
    expect(config.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    expect(config.toolPrefix).toBe('')

    expect((await rpc(config, { id: 1, method: 'initialize', params: {} }, 'Bearer 00')).status).toBe(401)
    const init = await (await rpc(config, { id: 1, method: 'initialize', params: {} })).json() as { result: { instructions: string; capabilities: { experimental?: Record<string, unknown> } } }
    expect(init.result.instructions).toContain('sample_echo: Use only for tests.')
    expect(init.result.capabilities.experimental).toHaveProperty(['loom/turn'])

    const list = await (await rpc(config, { id: 2, method: 'tools/list' })).json() as { result: { tools: Array<{ name: string; inputSchema: unknown }> } }
    expect(list.result.tools.map((tool) => tool.name)).toEqual(['sample_echo', 'sample_pick'])

    let text = ''
    await readEvents(await rpc(config, { id: 3, method: 'tools/call', params: { name: 'sample_echo', arguments: { text: 'hi' } } }), (message) => {
      text = ((message.result as { content: Array<{ text: string }> }).content[0]).text
      return true
    })
    expect(text).toBe('echo hi')
  })

  it('asks the user through an elicitation in the middle of a tool call', async () => {
    const host = await startHost()
    const config = readConfig(host.openRuntime([sample], {}))
    let result = ''
    await readEvents(await rpc(config, { id: 7, method: 'tools/call', params: { name: 'sample_pick', arguments: {} } }), async (message) => {
      if (message.method === 'elicitation/create') {
        const params = message.params as { message: string; requestedSchema: { properties: { choice: { enum: string[] } } } }
        expect(params.message).toBe('Pick one')
        expect(params.requestedSchema.properties.choice.enum).toEqual(['A', 'B'])
        expect((await rpc(config, { id: message.id, result: { action: 'accept', content: { choice: 'B' } } })).status).toBe(202)
        return false
      }
      result = ((message.result as { content: Array<{ text: string }> }).content[0]).text
      return true
    })
    expect(result).toBe('picked B')
  })

  it('runs turn handlers for the runtime that starts a turn and forgets the runtime when it ends', async () => {
    const host = await startHost()
    const path = host.openRuntime([sample], {})
    const other = readConfig(host.openRuntime([], {}))
    const config = readConfig(path)
    prompts.length = 0
    const turn = await (await rpc(config, { id: 1, method: 'loom/turnStarted', params: { prompt: 'first request' } })).json() as { result?: unknown }
    expect(turn.result).toEqual({})
    await rpc(other, { id: 1, method: 'loom/turnStarted', params: { prompt: 'other runtime' } })
    expect(prompts).toEqual(['first request'])

    await host.closeRuntime(path)
    expect(existsSync(path)).toBe(false)
    expect((await rpc(config, { id: 1, method: 'tools/list' })).status).toBe(401)
  })
})

describe('Loom capability extensions', () => {
  it('register the shared extensions against a runtime bridge and forward calls to it', async () => {
    const calls: Array<{ method: string; params: unknown; auth?: string }> = []
    const bridge: Server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => { body += chunk })
      request.on('end', () => {
        const { method, params } = JSON.parse(body) as { method: string; params: unknown }
        calls.push({ method, params, auth: request.headers.authorization })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true, result: { sessions: [] } }))
      })
    })
    await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', () => resolve()))
    cleanups.push(() => new Promise<void>((resolve) => bridge.close(() => resolve())))
    const bridgeUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}/`

    const host = await startHost()
    const config = readConfig(host.openRuntime(loomCapabilityExtensions({ askUser: true }), {
      GOOEYPI_COLLABORATION_URL: bridgeUrl,
      GOOEYPI_COLLABORATION_TOKEN: 'collaboration-token',
    }))
    const list = await (await rpc(config, { id: 1, method: 'tools/list' })).json() as { result: { tools: Array<{ name: string }> } }
    const names = list.result.tools.map((tool) => tool.name)
    // Only the extension whose bridge is present registers, plus ask-user.
    expect(names).toContain('gooeypi_session_list')
    expect(names).toContain('ask_user')
    expect(names.some((name) => name.startsWith('gooeypi_enterprise_'))).toBe(false)

    let text = ''
    await readEvents(await rpc(config, { id: 2, method: 'tools/call', params: { name: 'gooeypi_session_list', arguments: {} } }), (message) => {
      text = ((message.result as { content: Array<{ text: string }> }).content[0]).text
      return true
    })
    expect(JSON.parse(text)).toEqual({ sessions: [] })
    expect(calls).toEqual([{ method: 'list', params: {}, auth: 'Bearer collaboration-token' }])
  })
})
