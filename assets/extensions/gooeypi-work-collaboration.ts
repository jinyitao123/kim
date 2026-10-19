/** Shared Kim session-collaboration tools for Prime Agent and Pi. */

interface SchemaOptions { description?: string; minLength?: number; maxLength?: number; minimum?: number; maximum?: number }
interface HostTypebox {
  Object(properties: Record<string, unknown>, options?: SchemaOptions): unknown
  String(options?: SchemaOptions): unknown
  Number(options?: SchemaOptions): unknown
  Boolean(options?: SchemaOptions): unknown
  Optional(schema: unknown): unknown
}
interface ToolResult { content: Array<{ type: 'text'; text: string }>; details: Record<string, unknown> }
interface ExtensionApi {
  typebox?: { Type: HostTypebox }
  registerTool<Params>(tool: {
    name: string
    label: string
    description: string
    parameters: unknown
    execute(id: string, params: Params): Promise<ToolResult>
  }): void
}

async function importHostModule(specifier: string): Promise<Record<string, unknown> | undefined> {
  try { return (await import(specifier)) as Record<string, unknown> } catch { return undefined }
}

async function resolveHostTypebox(): Promise<HostTypebox> {
  const Type = (await importHostModule('typebox'))?.Type as HostTypebox | undefined
  if (Type) return Type
  const optional = new WeakSet<object>()
  return {
    Object: (properties, options) => ({
      type: 'object', properties,
      required: Object.entries(properties).filter(([, value]) => typeof value !== 'object' || value === null || !optional.has(value)).map(([key]) => key),
      ...(options ?? {}),
    }),
    String: (options) => ({ type: 'string', ...(options ?? {}) }),
    Number: (options) => ({ type: 'number', ...(options ?? {}) }),
    Boolean: (options) => ({ type: 'boolean', ...(options ?? {}) }),
    Optional: (schema) => { if (typeof schema === 'object' && schema !== null) optional.add(schema); return schema },
  }
}

interface BridgeResult { ok: boolean; result?: unknown; error?: string }
/** Where a runtime reaches the desktop bridge, read from that runtime's environment. */
interface Bridge { url?: string; token?: string }
function bridgeFrom(env: Record<string, string | undefined>): Bridge { return { url: env.GOOEYPI_COLLABORATION_URL, token: env.GOOEYPI_COLLABORATION_TOKEN } }

async function call(bridge: Bridge, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  if (!bridge.url || !bridge.token) throw new Error('Kim session collaboration is not available in this runtime')
  let response: Response
  try {
    response = await fetch(bridge.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ method, params }),
    })
  } catch (error) {
    throw new Error(`Kim's session collaboration broker is not reachable: ${String(error)}`)
  }
  const body = (await response.json()) as BridgeResult
  if (!body.ok) throw new Error(body.error || `Session collaboration call failed with status ${response.status}`)
  return body.result
}

function result(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], details: {} }
}

export default function (pi: ExtensionApi): void | Promise<void> {
  return registerExtension(pi, process.env)
}

/** Registers the tools for one runtime environment: Pi passes process.env, the Loom capability host a per-runtime environment. */
export function registerExtension(pi: ExtensionApi, env: Record<string, string | undefined>): void | Promise<void> {
  const bridge = bridgeFrom(env)
  if (!bridge.url || !bridge.token) return
  const injected = pi.typebox?.Type
  if (injected) { registerTools(pi, injected, bridge); return }
  return resolveHostTypebox().then((Type) => { registerTools(pi, Type, bridge) })
}

function registerTools(pi: ExtensionApi, Type: HostTypebox, bridge: Bridge): void {
  const target = Type.String({ description: 'Exact session UUID from an @session reference, Copy session UUID, gooeypi_session_list, or from_session_id in an incoming Kim agent message' })

  pi.registerTool({
    name: 'gooeypi_session_list',
    label: 'List sessions',
    description: 'List other Kim sessions in this working directory. Results include title, UUID, harness, status, and whether the session is live. Use an exact UUID with the other session tools.',
    parameters: Type.Object({}),
    async execute() { return result(await call(bridge, 'list')) },
  })
  pi.registerTool<{ query?: string }>({
    name: 'gooeypi_session_models',
    label: 'List session models',
    description: 'List models available for new Kim sessions in this harness from providers currently active in the GUI. Results include exact model keys and supported reasoning levels. Use an approximate query when a model was requested by name.',
    parameters: Type.Object({
      query: Type.Optional(Type.String({ maxLength: 256, description: 'Optional approximate model name, provider, family, or spoken model wording' })),
    }),
    async execute(_id, params) { return result(await call(bridge, 'models', params)) },
  })
  pi.registerTool<{ prompt: string; title?: string; model?: string; reasoning?: string; fast?: boolean }>({
    name: 'gooeypi_session_create',
    label: 'Create session',
    description: 'Create and immediately start a new readable top-level Kim session in this same harness and working directory. Use gooeypi_session_models when selecting a model. Model and reasoning wording may be approximate; Kim resolves and revalidates them against active GUI providers before launch. Set fast true to request fast/priority mode when the selected model and harness support it. The result includes the exact session UUID for gooeypi_session_read, gooeypi_session_send, and gooeypi_session_wait.',
    parameters: Type.Object({
      prompt: Type.String({ minLength: 1, maxLength: 1_000_000, description: 'The self-contained initial task for the new session' }),
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: 'Optional concise session title' })),
      model: Type.Optional(Type.String({ minLength: 1, maxLength: 512, description: 'Optional exact key from gooeypi_session_models or approximate model wording' })),
      reasoning: Type.Optional(Type.String({ minLength: 1, maxLength: 64, description: 'Optional reasoning intensity; the closest level supported by the selected or default model is used' })),
      fast: Type.Optional(Type.Boolean({ description: 'Request fast/priority mode; unsupported models still start normally and report fast mode as unavailable' })),
    }),
    async execute(_id, params) { return result(await call(bridge, 'create', params)) },
  })
  pi.registerTool<{ target_session_id: string }>({
    name: 'gooeypi_session_read',
    label: 'Read session',
    description: 'Read bounded recent conversational context from another Kim session in this working directory without modifying its transcript. Includes user, assistant, agent, and thinking text; omits tool calls, tool results, and internal compaction data. Results are capped at 30,000 estimated tokens and report whether truncation occurred.',
    parameters: Type.Object({ target_session_id: target }),
    async execute(_id, params) { return result(await call(bridge, 'read', params)) },
  })
  pi.registerTool<{ target_session_id: string; message: string }>({
    name: 'gooeypi_session_send',
    label: 'Message session',
    description: 'Send an attributed background message to another Kim session in this working directory. For an incoming agent message, reply directly to its from_session_id; its signed reply_with field names this tool, so no session listing is needed. Kim safely wakes an idle saved session when needed. This returns after delivery; call gooeypi_session_wait with cursor_before to wait for its response. Never busy-wait or create mutual waits.',
    parameters: Type.Object({
      target_session_id: target,
      message: Type.String({ minLength: 1, maxLength: 64 * 1024, description: 'The concise message or coordination request to send' }),
    }),
    async execute(_id, params) { return result(await call(bridge, 'send', params)) },
  })
  pi.registerTool<{ target_session_id: string; after_cursor?: string; timeout_ms?: number }>({
    name: 'gooeypi_session_wait',
    label: 'Wait for session',
    description: 'Wait briefly for another Kim session to become idle and produce context after a cursor. Returns a bounded snapshot and timed_out; call again only when continued waiting is useful.',
    parameters: Type.Object({
      target_session_id: target,
      after_cursor: Type.Optional(Type.String({ description: 'cursor_before returned by gooeypi_session_send, or cursor returned by gooeypi_session_read/gooeypi_session_wait' })),
      timeout_ms: Type.Optional(Type.Number({ minimum: 0, maximum: 30_000, description: 'Maximum wait, default 15000 and hard-capped at 30000' })),
    }),
    async execute(_id, params) { return result(await call(bridge, 'wait', params)) },
  })
}

export type WorkExtensionApi = ExtensionApi
