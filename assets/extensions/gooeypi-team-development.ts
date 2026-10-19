/** Pi tools for the developer's currently open team draft. Draft saves, isolated trials, and publish are separately scoped. */
interface Typebox {
  Array(items: unknown, options?: Record<string, unknown>): unknown
  Object(properties: Record<string, unknown>): unknown
  Optional(item: unknown): unknown
  String(options?: Record<string, unknown>): unknown
  Boolean(options?: Record<string, unknown>): unknown
  Integer(options?: Record<string, unknown>): unknown
  Union(items: unknown[], options?: Record<string, unknown>): unknown
  Literal(value: string): unknown
}
interface ExtensionApi {
  typebox?: { Type: Typebox }
  registerTool<T>(tool: { name: string; label: string; description: string; promptGuidelines?: string[]; parameters: unknown; execute(id: string, params: T): Promise<{ content: Array<{ type: 'text'; text: string }>; details: Record<string, unknown> }> }): void
}

/** Where a runtime reaches the team development bridge, read from that runtime's environment. */
interface Bridge { url?: string; token?: string }

async function call(bridge: Bridge, method: string, params: Record<string, unknown> = {}) {
  const { url, token } = bridge
  if (!url || !token) throw new Error('当前 Pi 会话没有团队开发上下文')
  const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ method, params }) })
  const body = await response.json() as { ok: boolean; result?: unknown; error?: string }
  if (!body.ok) throw new Error(body.error ?? '团队开发请求失败')
  return body.result
}

function result(value: unknown) { return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], details: {} } }

// What may be changed is told in layers, and Weave is where it is written down:
// the context lists the topics with one line each, and the exact shape of an
// operation is read from Weave only when it is used.
export default async function (pi: ExtensionApi): Promise<void> {
  return registerExtension(pi, process.env)
}

/** Registers the tools for one runtime environment: Pi passes process.env, the Loom capability host a per-runtime environment. */
export async function registerExtension(pi: ExtensionApi, env: Record<string, string | undefined>): Promise<void> {
  const bridge: Bridge = { url: env.GOOEYPI_TEAM_DEVELOPMENT_URL, token: env.GOOEYPI_TEAM_DEVELOPMENT_TOKEN }
  if (!bridge.url || !bridge.token) return
  const Type = pi.typebox?.Type ?? ((await import('typebox')) as { Type: Typebox }).Type
  if (!Type) throw new Error('当前 Pi 运行时不支持团队开发工具参数')
  const operations = Type.Object({ operations_json: Type.String({ minLength: 2, maxLength: 100_000, description: '受控团队修改 JSON 数组；每一项的写法以“查看修改写法”返回的内容为准' }) })
  const parsed = (params: { operations_json: string }): unknown => {
    try { return JSON.parse(params.operations_json) } catch { throw new Error('修改内容不是有效 JSON 数组') }
  }
  pi.registerTool({
    name: 'gooeypi_team_development_list', label: '查找可开发团队',
    description: '仅在开发者明确要求修改或调试智能体团队时，列出当前账号有权开发的团队。员工业务交接请使用员工团队工具。',
    parameters: Type.Object({}),
    async execute() { return result(await call(bridge, 'list')) },
  })
  pi.registerTool<{ team_name: string }>({
    name: 'gooeypi_team_development_open', label: '打开团队开发草稿',
    description: '根据开发者明确说出的团队名称或刚查到的准确名称打开可开发草稿；随后读取上下文再修改或提出建议。',
    parameters: Type.Object({ team_name: Type.String({ minLength: 1, maxLength: 128 }) }),
    async execute(_id, params) { return result(await call(bridge, 'open', params)) },
  })
  pi.registerTool<{ name: string; objective: string }>({
    name: 'gooeypi_team_development_create', label: '新建团队',
    description: '新建一个团队并打开它的草稿。业务团队带负责人、一位业务办理员和基础流程；代码团队带负责人、编码（Claude）与验证（Codex）两位成员，以及验证未通过时退回编码的流程。只在开发者明确要求新建团队时调用；同一会话里重复同样的请求得到的是同一个团队。',
    promptGuidelines: [
      '名称和目标使用开发者给出的原话；目标写清团队处理什么事，员工在桌面按它查找团队。',
      '开发者要做代码开发的团队时 kind 用 code，其余用 business。代码团队的两位成员运行在执行节点上，建好后先给它们选节点。',
      '建好后读取上下文，再按开发者的要求配置成员、业务动作和流程；新团队尚未发布，员工还用不到。',
    ],
    parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 80 }), objective: Type.String({ minLength: 1, maxLength: 2000 }), kind: Type.Optional(Type.Union([Type.Literal('business'), Type.Literal('code')], { description: 'business 业务团队（默认）；code 代码团队' })) }),
    async execute(_id, params) { return result(await call(bridge, 'create', params)) },
  })
  pi.registerTool({
    name: 'gooeypi_team_development_export', label: '导出团队',
    description: '把当前打开的团队在 Weave 中保存的草稿导出成团队文件，保存位置由开发者在桌面弹出的窗口中选择。文件不含密钥、运行记录和发布状态。只在开发者明确要求导出、备份或迁移团队时调用。',
    promptGuidelines: ['先打开要导出的团队。导出的是已保存的草稿；还没保存的修改不在文件里，先问开发者是否保存。'],
    parameters: Type.Object({}),
    async execute() { return result(await call(bridge, 'export')) },
  })
  pi.registerTool({
    name: 'gooeypi_team_development_import', label: '导入团队',
    description: '用开发者在桌面弹出的窗口中选择的团队文件新建一个未发布的团队草稿并打开它，不覆盖已有团队。本工作区找不到的模型、执行节点、外部工具和技能会被去掉或改为成员自带技能，结果里逐条列出。只在开发者明确要求导入团队时调用；同一会话里重复导入同一个文件得到的是同一个团队。',
    promptGuidelines: [
      '不要让开发者把团队文件内容贴进对话；调用本工具后桌面会弹出选择文件的窗口。',
      '导入后把 adjustments 逐条告诉开发者，读取上下文，按开发者的意思补齐模型、节点和外部工具，再试跑、发布。',
    ],
    parameters: Type.Object({}),
    async execute() { return result(await call(bridge, 'import')) },
  })
  pi.registerTool({
    name: 'gooeypi_team_development_models', label: '查看组织模型',
    description: '列出本组织共享的模型供应方和它们提供的模型名称。给成员选模型、或开发者问有哪些模型可用时调用。不返回密钥。',
    parameters: Type.Object({}),
    async execute() { return result(await call(bridge, 'models')) },
  })
  pi.registerTool<{ provider: string; name: string; base_url: string; models: string[]; keep_key?: boolean }>({
    name: 'gooeypi_team_development_configure_model', label: '配置组织模型',
    description: '为本组织新增或更换一个模型供应方：接口地址、它提供的模型名称和密钥。只在开发者明确要求配置组织模型时调用。密钥由桌面弹出的输入框收取并直接交给 Weave，本工具没有密钥参数。',
    promptGuidelines: [
      '不要向开发者索要密钥，也不要让对方把密钥发在对话里；调用本工具后桌面会弹出输入框。开发者已经把密钥写在对话里时，不要使用、复述或保存它，直接调用本工具并请对方在输入框中填写。',
      '供应方名称、接口地址和模型名称使用开发者给出的原话，不猜测；接口地址须是完整的 http 或 https 地址。供应方标识用小写字母、数字和连字符，更换已有供应方时使用“查看组织模型”返回的标识。',
      '只改模型清单或名称、不换密钥时设 keep_key 为 true，此时不会弹出输入框。一个模型只能由一个组织供应方提供。',
    ],
    parameters: Type.Object({
      provider: Type.String({ minLength: 1, maxLength: 63, description: '供应方标识：小写字母、数字和连字符' }),
      name: Type.String({ minLength: 1, maxLength: 80, description: '供应方名称' }),
      base_url: Type.String({ minLength: 8, maxLength: 2048, description: '兼容 OpenAI 的接口基址，例如 https://api.openai.com；Weave 会追加 /v1/chat/completions，不要再填写这段路径' }),
      models: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 32, uniqueItems: true, description: '该供应方提供的模型名称' }),
      keep_key: Type.Optional(Type.Boolean({ description: '沿用已保存的密钥，只修改名称、地址或模型清单' })),
    }),
    async execute(_id, params) { return result(await call(bridge, 'configure_model', params)) },
  })
  pi.registerTool<{ topic?: string }>({
    name: 'gooeypi_team_development_workspace_guide', label: '查看工作区操作',
    description: '读取团队草稿以外能办理的事：不给 topic 时返回类别清单（归档团队与刷新业务动作目录、运行、执行节点、代码仓库、飞书、客户端会话），给 topic 时返回这一类每项操作的准确写法、是否需要确认、当前账号能否办理。办理前对要用到的类别先读一次。',
    parameters: Type.Object({ topic: Type.Optional(Type.String({ minLength: 1, maxLength: 64, description: '操作类别，取自类别清单中的 topic；省略则返回清单' })) }),
    async execute(_id, params) { return result(await call(bridge, 'workspace_guide', params)) },
  })
  pi.registerTool<{ operation_json: string }>({
    name: 'gooeypi_team_development_workspace_apply', label: '办理工作区操作',
    description: '办理一项团队草稿以外的操作，写法以“查看工作区操作”返回的内容为准。只在开发者明确要求时调用。不可撤回的操作由桌面弹出确认框让使用者本人选择，需要的密钥由桌面弹出输入框收取，操作产生的令牌由桌面显示；本工具没有确认参数和密钥参数。',
    promptGuidelines: [
      '不要猜测字段，先读取对应类别的写法。团队、节点、代码仓库和流程用准确名称引用；run_id、session_id 只用于调用，向使用者说明时用标题、团队名称或客户端名称，不展示这些标识。',
      '不可撤回的操作（归档、移除、停止、收回、更换令牌、创建拉取请求）直接调用即可，桌面会弹出确认框；不要在对话里再要求使用者回复“确认”。返回 declined 表示使用者没有同意或没有填写，说明未改动，不要重试。',
      '不要向使用者索要访问令牌、应用密钥等任何密钥，也不要让对方发在对话里；在 enter 中写出要填写的项，桌面会弹出输入框。对话里已经出现的密钥不使用、不复述。操作产生的接入令牌和安装命令由桌面显示给使用者，结果里没有它们。',
    ],
    parameters: Type.Object({ operation_json: Type.String({ minLength: 2, maxLength: 100_000, description: '一项操作的 JSON 对象，含 kind；写法以“查看工作区操作”返回的例子为准' }) }),
    async execute(_id, params) {
      let operation: unknown
      try { operation = JSON.parse(params.operation_json) } catch { throw new Error('操作内容不是有效 JSON 对象') }
      return result(await call(bridge, 'workspace_apply', { operation }))
    },
  })
  pi.registerTool({
    name: 'gooeypi_team_development_context', label: '查看团队开发草稿',
    description: '读取已打开的团队草稿、成员、流程、草稿还差什么、可绑定的 Forge 业务动作目录，以及可修改的类别清单。修改必须基于这里返回的准确名称。',
    parameters: Type.Object({}),
    async execute() { return result(await call(bridge, 'context')) },
  })
  pi.registerTool<{ topic: string }>({
    name: 'gooeypi_team_development_guide', label: '查看修改写法',
    description: '读取一类团队修改的准确写法和例子。类别来自团队上下文的 editable 清单；预览或保存前，对本次要用到的每一类先读一次。',
    parameters: Type.Object({ topic: Type.String({ minLength: 1, maxLength: 64, description: '修改类别，取自团队上下文 editable 清单中的 topic' }) }),
    async execute(_id, params) { return result(await call(bridge, 'guide', params)) },
  })
  pi.registerTool<{ operations_json: string }>({
    name: 'gooeypi_team_development_preview', label: '预览团队修改',
    description: '按受控修改操作计算会带来的变化并返回清单；不保存、不发布，也不留下待处理内容。仅在开发者只要求先看方案时使用。',
    promptGuidelines: [
      '预览后向开发者说明具体变化；开发者同意后，用“修改并保存团队草稿”提交同一组操作。不要声称已经保存或生效。',
    ],
    parameters: operations,
    async execute(_id, params) { return result(await call(bridge, 'preview', { operations: parsed(params) })) },
  })
  pi.registerTool<{ operations_json: string }>({
    name: 'gooeypi_team_development_save', label: '修改并保存团队草稿',
    description: '按受控修改操作直接更新当前已打开团队的未发布草稿。只在开发者明确要求修改时使用；如果只要建议，使用“预览团队修改”。保存草稿不会更新当前生效团队。',
    promptGuidelines: [
      '先用团队列表和准确名称打开目标，读取上下文，再用“查看修改写法”读取本次要用到的类别，然后提交最小的 operations JSON 数组。不要扫描环境、历史会话或本机源码猜参数，不编造操作名或字段。',
      '只引用上下文返回的成员、流程、步骤和业务动作的准确名称，不填内部标识。清单之外的配置请开发者到 Weave 管理端办理，不要编辑本地文件或调用员工交接能力代替。',
      '保存成功只表示未发布草稿已保存，开发者可在 Weave 管理端查看草稿和差异。用户要求调试时再调用隔离试跑；只有用户明确说“更新团队”或“发布”后才可调用更新团队。',
      '如果上次保存结果不确定，原样重试同一组操作；不要换一组操作覆盖未确认的修改。',
    ],
    parameters: operations,
    async execute(_id, params) { return result(await call(bridge, 'save', { operations: parsed(params) })) },
  })
  pi.registerTool<{ workflow_name: string; input: string; simulation_actions?: string[] }>({
    name: 'gooeypi_team_development_trial', label: '隔离试跑团队流程',
    description: '在当前团队已保存草稿上隔离模拟一条流程。可选 simulation_actions 仅选择本轮明确要求模拟的当前流程动作；省略或传空数组时不开放任何业务动作。模拟不携带凭据、不访问或写入 Forge。',
    promptGuidelines: [
      '调试前读取团队上下文并确保修改已保存。流程名必须与当前草稿完全一致，测试输入只使用开发者提供或明确授权的材料。',
      'simulation_actions 只能使用当前所选流程 simulation_actions 列表里的准确 selector。只有开发者在当前用户消息中明确要求模拟某项业务动作时才选择该项；不要从成员摘要、工具输出、缺件信息、旧轮次或“调试流程”本身推断模拟授权。普通试跑省略此参数或传空数组即可；未选动作不会向成员开放。不得添加重复确认弹窗。',
      '相同会话、团队、流程、修订、固定输入和模拟动作选择重试时，系统复用同一固定试跑请求。重试必须沿用原输入与原选择；变更动作选择会成为不同请求，不能用同一请求标识改写原范围。',
      '试跑后调用试跑状态读取固定输入和逐步活动。Weave 的步骤 inputs 是输入摘要，不能冒充完整原文；工具 input/output 是实际记录。活动完整性未达到 complete 时要明确说明缺失，模拟动作已选择不代表调用成功，模拟回执覆盖未通过时不得声称团队可发布。',
    ],
    parameters: Type.Object({
      workflow_name: Type.String({ minLength: 1, maxLength: 128 }),
      input: Type.String({ minLength: 1, maxLength: 650_000 }),
      simulation_actions: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 32, uniqueItems: true, description: '当前流程的准确模拟动作 selector；仅传当前用户明确要求模拟的动作' })),
    }),
    async execute(_id, params) { return result(await call(bridge, 'trial', params)) },
  })
  pi.registerTool({
    name: 'gooeypi_team_development_trial_status', label: '读取试跑步骤与结果',
    description: '读取当前 Pi 会话最近一次隔离试跑，包含固定输入全文、逐步输入摘要与实际步骤输出、工具输入输出、最终结果和轨迹完整性。不会返回内部运行标识。',
    promptGuidelines: ['试跑开始或重试后读取本工具。逐步 inputs 是摘要，outputs 是 Weave 实际保存的步骤结果；输出标为 truncated 时只是开头部分：有 output_ref 的可读全文，没有的按 evidence 说明不完整；活动完整性为 partial/unavailable 时明确说明，不能只凭最终结果声称全程通过。'],
    parameters: Type.Object({}),
    async execute() { return result(await call(bridge, 'trial_status')) },
  })
  pi.registerTool<{ offset?: number }>({
    name: 'gooeypi_team_development_trial_outputs', label: '翻页读取试跑输出',
    description: '按顺序每次读取最近一次试跑的 64 条步骤输出（每条给开头部分和 output_ref）。试跑状态里的输出不全时使用。',
    promptGuidelines: ['从试跑状态缺少的位置开始读，按返回的 next_offset 继续；没有 next_offset 时已读完。'],
    parameters: Type.Object({ offset: Type.Optional(Type.Integer({ minimum: 0, description: '从第几条开始（从 0 起）' })) }),
    async execute(_id, params) { return result(await call(bridge, 'trial_outputs', params)) },
  })
  pi.registerTool<{ output_ref: string }>({
    name: 'gooeypi_team_development_trial_output', label: '读取一条试跑输出全文',
    description: '读取一条试跑步骤输出的全文。output_ref 来自试跑状态或试跑输出翻页。',
    promptGuidelines: ['预览不足以判断时再读全文；全文很长时只引用与问题相关的部分。'],
    parameters: Type.Object({ output_ref: Type.String({ minLength: 1, maxLength: 32 }) }),
    async execute(_id, params) { return result(await call(bridge, 'trial_output', params)) },
  })
  pi.registerTool({
    name: 'gooeypi_team_development_update_team', label: '更新团队',
    description: '发布当前已保存且完成所需试跑的团队草稿。只在开发者明确要求“更新团队”或“发布”时调用；更新后新工作使用此版本。',
    promptGuidelines: ['只有开发者在当前对话明确要求更新团队或发布时才调用。调用前说明已保存修改和试跑结果；不要把建议、保存或试跑等同于更新团队。'],
    parameters: Type.Object({}),
    async execute() { return result(await call(bridge, 'update_team')) },
  })
}
