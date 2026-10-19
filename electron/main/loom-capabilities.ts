import { randomBytes, timingSafeEqual } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

/**
 * Serves the app's agent capabilities (enterprise work, ask-user, browser,
 * schedules, collaboration, team development) to Loom runtimes as one local
 * MCP server. The tools come from the same extension modules Pi loads: each
 * runtime registers them against a small Pi-compatible API with its own
 * bridge environment, so both harnesses share one implementation and one
 * permission path. Requests need the runtime's bearer token and are served on
 * the loopback interface only.
 *
 * 主进程中的 Loom 能力宿主：把桌面能力以本机 MCP 提供给 Loom。工具定义来自 Pi 所加载的
 * 同一批扩展模块，每个运行时用自己的桥接环境注册一次，两个内核共用同一份实现与权限路径。
 */

/** The part of Pi's extension API the app's extensions use. */
export interface CapabilityToolDefinition {
  name: string
  label?: string
  description: string
  promptGuidelines?: string[]
  parameters: unknown
  execute(id: string, params: never, signal?: AbortSignal, onUpdate?: unknown, context?: CapabilityToolContext): Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details?: unknown }>
}

export interface CapabilityToolContext {
  hasUI: boolean
  ui: {
    select(title: string, options: string[], settings?: { signal?: AbortSignal }): Promise<string | undefined>
    confirm(title: string, message: string, settings?: { signal?: AbortSignal }): Promise<boolean>
    input(title: string, placeholder?: string, settings?: { signal?: AbortSignal }): Promise<string | undefined>
  }
}

export interface CapabilityExtensionApi {
  typebox?: { Type: unknown }
  registerTool(tool: CapabilityToolDefinition): void
  on(event: string, handler: (event: { prompt: string }) => unknown): void
}

/** One extension module: Pi's default export takes process.env; this takes a runtime environment. */
export interface CapabilityExtension {
  id: string
  register(pi: CapabilityExtensionApi, env: Record<string, string | undefined>): void | Promise<void>
}

interface PendingElicitation { resolve(value: { action: string; content?: Record<string, unknown> }): void }

interface RuntimeCapabilities {
  token: Buffer
  configPath: string
  tools: Map<string, CapabilityToolDefinition>
  promptHandlers: Array<(event: { prompt: string }) => unknown>
  calls: Map<string, AbortController>
  elicitations: Map<string, PendingElicitation>
  /** Settles when every extension finished registering, including asynchronous ones. */
  ready: Promise<unknown>
}

const MAX_REQUEST_BYTES = 8 * 1024 * 1024
const PROTOCOL_VERSION = '2025-06-18'
/** Experimental MCP capability asking Loom to send TURN_STARTED_METHOD when a turn begins. */
const TURN_CAPABILITY = 'loom/turn'
const TURN_STARTED_METHOD = 'loom/turnStarted'

export interface LoomCapabilityHostOptions {
  /** Private directory for the per-runtime MCP config files. */
  directory: string
  /** TypeBox's Type, offered to extensions that build schemas with it. */
  typebox?: unknown
}

export class LoomCapabilityHost {
  private server: Server | null = null
  private port = 0
  private readonly runtimes = new Map<string, RuntimeCapabilities>()
  private readonly byConfig = new Map<string, RuntimeCapabilities>()
  private nextElicitation = 0

  constructor(private readonly options: LoomCapabilityHostOptions) {}

  async start(): Promise<void> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 })
    const server = createServer((request, response) => { void this.handle(request, response) })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    this.server = server
    this.port = (server.address() as AddressInfo).port
  }

  async stop(): Promise<void> {
    for (const runtime of this.runtimes.values()) this.abortRuntime(runtime)
    this.runtimes.clear()
    this.byConfig.clear()
    const server = this.server
    this.server = null
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(this.options.directory, { recursive: true, force: true })
  }

  /**
   * Registers the enabled extensions for a runtime that is about to start and
   * writes its MCP config. Returns the config path to pass to Loom. It is
   * synchronous because runtime environments are built synchronously; the
   * extensions register their tools synchronously when TypeBox is provided.
   */
  openRuntime(extensions: readonly CapabilityExtension[], env: Record<string, string | undefined>): string {
    if (!this.server) throw new Error('Loom capability host is not running')
    const key = randomBytes(16).toString('hex')
    const runtime: RuntimeCapabilities = {
      token: randomBytes(32),
      configPath: join(this.options.directory, `${key}.json`),
      tools: new Map(),
      promptHandlers: [],
      calls: new Map(),
      elicitations: new Map(),
      ready: Promise.resolve(),
    }
    const api: CapabilityExtensionApi = {
      ...(this.options.typebox ? { typebox: { Type: this.options.typebox } } : {}),
      registerTool: (tool) => { if (!runtime.tools.has(tool.name)) runtime.tools.set(tool.name, tool) },
      on: (event, handler) => { if (event === 'before_agent_start') runtime.promptHandlers.push(handler) },
    }
    const reportFailure = (id: string, error: unknown) => console.error(`Loom capability ${id} failed to register: ${error instanceof Error ? error.message : String(error)}`)
    const pendings: Promise<unknown>[] = []
    for (const extension of extensions) {
      try {
        const pending = extension.register(api, env)
        if (pending instanceof Promise) pendings.push(pending.catch((error: unknown) => reportFailure(extension.id, error)))
      } catch (error) { reportFailure(extension.id, error) }
    }
    runtime.ready = Promise.all(pendings)
    const config = {
      mcpServers: {
        gooeypi: {
          url: `http://127.0.0.1:${this.port}/mcp`,
          headers: { Authorization: `Bearer ${runtime.token.toString('hex')}` },
          // Tool names stay exactly as the extensions register them, so prompts
          // and guidelines that name them keep working.
          toolPrefix: '',
        },
      },
    }
    writeFileSync(runtime.configPath, JSON.stringify(config), { mode: 0o600 })
    this.runtimes.set(key, runtime)
    this.byConfig.set(runtime.configPath, runtime)
    return runtime.configPath
  }

  /** Ends a runtime's registration: pending calls are aborted and its config removed. */
  async closeRuntime(configPath: string | undefined): Promise<void> {
    const runtime = configPath ? this.byConfig.get(configPath) : undefined
    if (!runtime) return
    this.abortRuntime(runtime)
    this.byConfig.delete(runtime.configPath)
    for (const [key, value] of this.runtimes) if (value === runtime) this.runtimes.delete(key)
    await rm(runtime.configPath, { force: true })
  }

  private abortRuntime(runtime: RuntimeCapabilities): void {
    for (const controller of runtime.calls.values()) controller.abort()
    for (const pending of runtime.elicitations.values()) pending.resolve({ action: 'cancel' })
    runtime.calls.clear()
    runtime.elicitations.clear()
  }

  private authenticate(request: IncomingMessage): RuntimeCapabilities | undefined {
    const header = request.headers.authorization
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return undefined
    const presented = Buffer.from(header.slice(7), 'hex')
    for (const runtime of this.runtimes.values()) {
      if (presented.length === runtime.token.length && timingSafeEqual(presented, runtime.token)) return runtime
    }
    return undefined
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.url !== '/mcp') { response.writeHead(404).end(); return }
    const runtime = this.authenticate(request)
    if (!runtime) { response.writeHead(401).end(); return }
    if (request.method === 'DELETE') { response.writeHead(200).end(); return }
    if (request.method !== 'POST') { response.writeHead(405).end(); return }
    let message: Record<string, unknown>
    try { message = JSON.parse(await readBody(request)) as Record<string, unknown> } catch {
      response.writeHead(400).end()
      return
    }
    const id = message.id as string | number | undefined
    const method = typeof message.method === 'string' ? message.method : undefined
    if (!method) {
      // A client's answer to one of our elicitation requests.
      const pending = runtime.elicitations.get(String(id))
      runtime.elicitations.delete(String(id))
      const result = (message.result ?? { action: 'cancel' }) as { action: string; content?: Record<string, unknown> }
      pending?.resolve(result)
      response.writeHead(202).end()
      return
    }
    if (id === undefined) {
      if (method === 'notifications/cancelled') {
        const params = message.params as { requestId?: unknown } | undefined
        runtime.calls.get(String(params?.requestId))?.abort()
      }
      response.writeHead(202).end()
      return
    }
    await runtime.ready
    const reply = (payload: Record<string, unknown>) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id, ...payload }))
    }
    switch (method) {
      case 'initialize':
        reply({ result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {}, experimental: { [TURN_CAPABILITY]: {} } }, serverInfo: { name: 'gooeypi', version: '1' }, instructions: this.instructions(runtime) } })
        return
      case 'ping':
        reply({ result: {} })
        return
      case TURN_STARTED_METHOD: {
        // Loom waits for this answer before the model sees the turn, so the
        // extensions' before_agent_start handlers bind the prompt first.
        const prompt = (message.params as { prompt?: unknown } | undefined)?.prompt
        await this.turnStarted(runtime, typeof prompt === 'string' ? prompt : '')
        reply({ result: {} })
        return
      }
      case 'tools/list':
        reply({ result: { tools: [...runtime.tools.values()].map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: plainSchema(tool.parameters),
        })) } })
        return
      case 'tools/call':
        await this.callTool(runtime, id, message.params as { name?: unknown; arguments?: unknown } | undefined, response)
        return
      default:
        reply({ error: { code: -32601, message: `Method not found: ${method}` } })
    }
  }

  /** Runs the before_agent_start handlers for a runtime's new turn. */
  private async turnStarted(runtime: RuntimeCapabilities, prompt: string): Promise<void> {
    for (const handler of runtime.promptHandlers) {
      try { await handler({ prompt }) } catch { /* handlers report their own failures to their tools */ }
    }
  }

  private instructions(runtime: RuntimeCapabilities): string {
    const lines: string[] = []
    for (const tool of runtime.tools.values()) {
      for (const guideline of tool.promptGuidelines ?? []) lines.push(`- ${tool.name}: ${guideline}`)
    }
    return lines.length ? `Guidelines for the desktop tools:\n${lines.join('\n')}` : ''
  }

  /** Runs one tool on an event stream, so elicitation requests can reach the client mid-call. */
  private async callTool(runtime: RuntimeCapabilities, id: string | number, params: { name?: unknown; arguments?: unknown } | undefined, response: ServerResponse): Promise<void> {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const send = (payload: Record<string, unknown>) => response.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', ...payload })}\n\n`)
    const tool = typeof params?.name === 'string' ? runtime.tools.get(params.name) : undefined
    if (!tool) {
      send({ id, result: { content: [{ type: 'text', text: `Tool ${String(params?.name)} is not available.` }], isError: true } })
      response.end()
      return
    }
    const controller = new AbortController()
    runtime.calls.set(String(id), controller)
    response.on('close', () => controller.abort())
    const elicit = (message: string, schema: Record<string, unknown>): Promise<{ action: string; content?: Record<string, unknown> }> => {
      if (controller.signal.aborted) return Promise.resolve({ action: 'cancel' })
      const requestId = `e${++this.nextElicitation}`
      return new Promise((resolve) => {
        runtime.elicitations.set(requestId, { resolve })
        controller.signal.addEventListener('abort', () => { runtime.elicitations.delete(requestId); resolve({ action: 'cancel' }) }, { once: true })
        send({ id: requestId, method: 'elicitation/create', params: { message, requestedSchema: schema } })
      })
    }
    const context: CapabilityToolContext = {
      hasUI: true,
      ui: {
        select: async (title, options) => {
          const answer = await elicit(title, { type: 'object', properties: { choice: { type: 'string', enum: options } }, required: ['choice'] })
          return answer.action === 'accept' && typeof answer.content?.choice === 'string' ? answer.content.choice : undefined
        },
        confirm: async (title, message) => {
          const answer = await elicit(message && message !== title ? `${title}\n\n${message}` : title, { type: 'object', properties: {} })
          return answer.action === 'accept'
        },
        input: async (title, placeholder) => {
          const answer = await elicit(title, { type: 'object', properties: { value: { type: 'string', ...(placeholder ? { description: placeholder } : {}) } }, required: ['value'] })
          return answer.action === 'accept' && typeof answer.content?.value === 'string' ? answer.content.value : undefined
        },
      },
    }
    try {
      const args = (params?.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as never
      const result = await tool.execute(String(id), args, controller.signal, undefined, context)
      const content = (result.content ?? []).map((block) => block.type === 'image'
        ? { type: 'image', data: block.data ?? '', mimeType: block.mimeType ?? 'image/png' }
        : { type: 'text', text: block.text ?? '' })
      send({ id, result: { content, isError: false } })
    } catch (error) {
      send({ id, result: { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true } })
    } finally {
      runtime.calls.delete(String(id))
      response.end()
    }
  }
}

/** TypeBox schemas carry symbol keys; JSON keeps only the JSON Schema itself. */
function plainSchema(schema: unknown): unknown {
  const plain = JSON.parse(JSON.stringify(schema ?? { type: 'object', properties: {} }))
  return plain && typeof plain === 'object' ? plain : { type: 'object', properties: {} }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_REQUEST_BYTES) { reject(new Error('request too large')); request.destroy(); return }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}
