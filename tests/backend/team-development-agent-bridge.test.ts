import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TeamDevelopmentAgentBridge } from '../../electron/main/development/agent-bridge'
import { configureBusinessCompletion } from '../../src/pages/team-workspace/business-completion'
import { newMember } from '../../src/pages/team-workspace/member'
import { configureWorkflowResultProtocol, initialGraph } from '../../src/pages/team-workspace/graph'
import type { EnterpriseBusinessCapabilityCatalog } from '../../src/types/api'
import type { TeamDefinition, TeamWorkspace, TeamWorkspaceCommand } from '../../src/types/team-workspace'
import { trialToolAction, trialWireActivity, trialWireCases } from '../fixtures/trial-activity'

let bridge: TeamDevelopmentAgentBridge | undefined
const tempDirectories: string[] = []
afterEach(async () => { await bridge?.stop(); bridge = undefined; for (const path of tempDirectories.splice(0)) rmSync(path, { recursive: true, force: true }) })

function workspace(document: TeamDefinition, revision = 4): TeamWorkspace {
  return { revision, published_revision: revision - 1, publishing_revision: 0, prepared_revision: 0, document: structuredClone(document), updated_at: '', trials: [] }
}

type OperationsCommand = Extract<TeamWorkspaceCommand, { action: 'operations' }>
const refusal = (message: string, status: number, code: string) => Object.assign(new Error(message), { status, code })

// Stands in for Weave's controlled edits. These tests are about what the bridge
// sends and keeps, so only a member's duty is really changed; a request id seen
// before gets its first answer again, as Weave does.
function weaveEdits(initial: TeamWorkspace) {
  let remote = initial
  const answers = new Map<string, { revision: number; saved: boolean; changes: string[]; issues: unknown[] }>()
  const commands: OperationsCommand[] = []
  return {
    commands,
    get remote() { return remote },
    set remote(next: TeamWorkspace) { remote = next },
    apply(command: OperationsCommand) {
      commands.push(structuredClone(command))
      const known = answers.get(command.requestId)
      if (known) return structuredClone(known)
      if (command.revision !== remote.revision) throw refusal('草稿已变化或正在发布，请重新读取后再提交', 409, 'development_revision_stale')
      const document = structuredClone(remote.document), changes: string[] = []
      for (const raw of command.operations) {
        const operation = raw as { kind?: string; member?: string; duty?: string }
        if (operation.kind === 'member') {
          const member = document.members.find((item) => item.configuration.displayName === operation.member)
          if (!member) throw refusal(`成员“${operation.member}”不在当前团队草稿中`, 422, 'operation_invalid')
          if (operation.duty) member.relationship.duty = operation.duty
          changes.push(`修改成员：${operation.member}`)
        } else changes.push(`已应用：${operation.kind}`)
      }
      if (command.dryRun) return { revision: remote.revision, saved: false, changes, issues: [] }
      remote = { ...remote, revision: remote.revision + 1, document }
      const answer = { revision: remote.revision, saved: true, changes, issues: [] }
      answers.set(command.requestId, answer)
      return structuredClone(answer)
    },
  }
}

const emptyCatalog: EnterpriseBusinessCapabilityCatalog = { version: '1', provider: { id: 'forge', name: 'Forge', status: 'available' }, capabilities: [], refreshedAt: '' }

function reviewTeam(): TeamDefinition {
  const lead = newMember('deepseek-flash'), worker = newMember('deepseek-flash')
  lead.configuration.role = 'avatar'; worker.configuration.displayName = '审核员'
  return { name: '合同团队', objective: '复核合同', members: [lead, worker], workflows: [{ id: 'flow', name: '复核流程', description: '', trigger_config: {}, graph_definition: initialGraph(worker) }] }
}

async function piSession(sessionPath?: string) {
  await bridge!.start()
  const env = bridge!.environmentFor({ cwd: '/work', harness: 'pi', ...(sessionPath ? { sessionPath } : {}) })
  bridge!.bindRuntime(env.GOOEYPI_TEAM_DEVELOPMENT_TOKEN, 'runtime', sessionPath)
  return async (method: string, params: Record<string, unknown> = {}) => {
    const response = await fetch(env.GOOEYPI_TEAM_DEVELOPMENT_URL!, { method: 'POST', headers: { authorization: `Bearer ${env.GOOEYPI_TEAM_DEVELOPMENT_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ method, params }) })
    return response.json() as Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }>
  }
}

it('sends a change to Weave by name and learns the outcome of a lost answer from the same request', async () => {
  const weave = weaveEdits(workspace(reviewTeam()))
  let lose = true
  bridge = new TeamDevelopmentAgentBridge({
    accountKey: async () => 'developer-1', developer: async () => ({ accountId: 'developer-1' }), teams: async () => [{ id: 'team', name: '合同团队' }],
    team: async () => structuredClone(weave.remote),
    workspace: async (command) => {
      if (command.action !== 'operations') throw new Error(`unexpected action: ${command.action}`)
      const answer = weave.apply(command)
      if (lose) { lose = false; throw new Error('回执丢失') }
      return answer
    },
    catalog: async () => emptyCatalog, extensionPath: '/app/team-development.ts',
  })
  const call = await piSession('/sessions/developer-1.jsonl')
  await call('open', { team_name: '合同团队' })
  const operations = [{ kind: 'member', member: '审核员', duty: '核对付款条件' }]
  const saved = await call('save', { operations })
  expect(saved.ok).toBe(true)
  expect(saved.result).toMatchObject({ team: '合同团队', changes: ['修改成员：审核员'] })
  // The names went to Weave as written, and the repeat carried the first request id.
  expect(weave.commands).toHaveLength(2)
  expect(weave.commands[0]).toMatchObject({ teamId: 'team', accountId: 'developer-1', revision: 4, dryRun: false, operations })
  expect(weave.commands[1]!.requestId).toBe(weave.commands[0]!.requestId)
  expect(weave.remote.revision).toBe(5)
  expect(weave.remote.document.members[1]?.relationship.duty).toBe('核对付款条件')
  expect((await bridge!.getState('runtime')).revision).toBe(5)
  expect(await bridge!.getProposal('runtime')).toBeUndefined()

  // The next change is a new request, on the draft as it now stands.
  expect((await call('save', { operations: [{ kind: 'member', member: '审核员', duty: '再核对一遍' }] })).ok).toBe(true)
  expect(weave.commands[2]).toMatchObject({ revision: 5 })
  expect(weave.commands[2]!.requestId).not.toBe(weave.commands[0]!.requestId)

  // What Weave refuses comes back as it said it; nothing is kept for later.
  const refused = await call('save', { operations: [{ kind: 'member', member: '不存在的人', duty: 'x' }] })
  expect(refused.ok).toBe(false)
  expect(refused.error).toContain('不在当前团队草稿中')
  expect(weave.remote.revision).toBe(6)
  expect((await call('save', { operations: 'not-an-array' })).ok).toBe(false)
})

it('shows what Weave says may be changed and what the draft lacks, and a saved completion check by name', async () => {
  const document = reviewTeam()
  const capabilityID = 'forge:action:contracts.submit'
  document.members[1]!.configuration.businessCapabilityIds = [capabilityID]
  const action = { id: capabilityID, name: '提交指定版本', description: '提交材料', effect: 'write' as const, resourceType: 'contract', requiresEmployeeIntent: true, status: 'available' as const }
  const catalog: EnterpriseBusinessCapabilityCatalog = { ...emptyCatalog, capabilities: [action] }
  document.workflows[0] = configureWorkflowResultProtocol(document.workflows[0]!, true)
  document.workflows[0].graph_definition = configureBusinessCompletion(document, document.workflows[0], [capabilityID], true, catalog)
  const guides: Array<string | undefined> = []
  bridge = new TeamDevelopmentAgentBridge({
    accountKey: async () => 'developer-1', developer: async () => ({ accountId: 'developer-1' }), teams: async () => [{ id: 'team', name: '合同团队' }],
    team: async () => ({ ...workspace(document), issues: [{ scope: 'workflow', target: '复核流程', code: 'workflow_description_missing', message: '流程说明为空', blocks: 'none' }] }),
    workspace: async (command) => {
      if (command.action !== 'guide') throw new Error(`unexpected action: ${command.action}`)
      guides.push(command.topic)
      return command.topic ? { topic: command.topic, operations: [{ kind: 'member_add', summary: '新增成员', example: '{"kind":"member_add"}' }] } : { topics: [{ topic: 'member', title: '成员', covers: '新增、修改成员' }], console_only: '引擎与模型在 Weave 管理端办理' }
    },
    catalog: async () => catalog, extensionPath: '/app/team-development.ts',
  })
  const call = await piSession()
  await call('open', { team_name: '合同团队' })
  const context = (await call('context')).result
  expect(context).toMatchObject({
    team: { issues: [{ code: 'workflow_description_missing' }], workflows: [{ businessCompletion: { actions: ['提交指定版本'], whenAuthorized: true, allowNeedsInput: true } }] },
    editable: [{ topic: 'member', title: '成员' }], console_only: '引擎与模型在 Weave 管理端办理',
  })
  expect(JSON.stringify(context)).not.toContain(capabilityID)
  // The shape of a change is read from Weave when it is needed, one topic at a time.
  expect((await call('guide', { topic: 'member' })).result).toMatchObject({ topic: 'member', operations: [{ kind: 'member_add' }] })
  expect((await call('guide', {})).ok).toBe(false)
  expect(guides).toEqual([undefined, 'member'])
})

it('creates a team once per request in a session and opens its draft', async () => {
  const created = reviewTeam()
  created.name = '线索跟进团队'; created.objective = '整理销售线索'
  const requests: Array<Extract<TeamWorkspaceCommand, { action: 'create' }>> = []
  bridge = new TeamDevelopmentAgentBridge({
    accountKey: async () => 'developer-1', developer: async () => ({ accountId: 'developer-1' }), teams: async () => [],
    team: async (teamId) => { expect(teamId).toBe('new-team'); return workspace(created, 2) },
    workspace: async (command) => {
      if (command.action === 'guide') return { topics: [], console_only: '' }
      if (command.action !== 'create') throw new Error(`unexpected action: ${command.action}`)
      requests.push(structuredClone(command))
      return { team_id: 'new-team', name: command.name, revision: 2 }
    },
    catalog: async () => emptyCatalog, extensionPath: '/app/team-development.ts',
  })
  const call = await piSession('/sessions/developer-1.jsonl')
  expect((await call('create', { name: '线索跟进团队', objective: '' })).ok).toBe(false)
  expect(requests).toHaveLength(0)
  const first = await call('create', { name: ' 线索跟进团队 ', objective: '整理销售线索' })
  expect(first.ok).toBe(true)
  expect(first.result).toMatchObject({ name: '线索跟进团队', objective: '整理销售线索' })
  expect(requests[0]).toMatchObject({ accountId: 'developer-1', name: '线索跟进团队', objective: '整理销售线索' })
  // The new team's draft is the one now open.
  expect((await call('context')).result).toMatchObject({ team: { name: '线索跟进团队' } })
  expect((await bridge!.getState('runtime'))).toEqual({ teamId: 'new-team', revision: 2 })
  // Asking for the same team again is the same request; another team is another.
  await call('create', { name: '线索跟进团队', objective: '整理销售线索' })
  await call('create', { name: '报价核对团队', objective: '核对报价' })
  expect(requests[1]!.requestId).toBe(requests[0]!.requestId)
  expect(requests[2]!.requestId).not.toBe(requests[0]!.requestId)
  expect(requests[0]!.kind).toBe('business')
  // A code team is its own request, even with the same name and objective.
  const code = await call('create', { name: '线索跟进团队', objective: '整理销售线索', kind: 'code' })
  expect(code.ok).toBe(true)
  expect(code.result?.message).toContain('编码与验证')
  expect(requests[3]).toMatchObject({ kind: 'code' })
  expect(requests[3]!.requestId).not.toBe(requests[0]!.requestId)
  expect((await call('create', { name: '团队', objective: '目标', kind: 'ops' })).ok).toBe(false)
})

it('exports the open team to the file the developer picks and imports a file as a new open draft', async () => {
  const source = reviewTeam()
  source.name = '合同复核团队'; source.objective = '复核合同条款'
  const imported = reviewTeam()
  imported.name = '合同复核团队'; imported.objective = '复核合同条款'
  const pkg = { format: 'weave-team-package', version: 1, team: { name: '合同/复核团队', objective: '复核合同条款' }, members: [{}, {}], workflows: [{}] }
  const commands: TeamWorkspaceCommand[] = []
  const saved: Array<{ name: string; contents: string }> = []
  let picked: { name: string; contents: string } | undefined
  bridge = new TeamDevelopmentAgentBridge({
    accountKey: async () => 'developer-1', developer: async () => ({ accountId: 'developer-1' }),
    teams: async () => [{ id: 'source-team', name: '合同复核团队' }],
    team: async (teamId) => teamId === 'source-team' ? workspace(source, 3) : workspace(imported, 2),
    workspace: async (command) => {
      commands.push(structuredClone(command))
      if (command.action === 'export') return pkg
      if (command.action === 'import') return { team_id: 'imported-team', name: '合同复核团队', revision: 2, adjustments: ['“审核员”的外部工具“合同库”在本工作区没有，已去掉'] }
      throw new Error(`unexpected action: ${command.action}`)
    },
    saveTeamPackage: async (name, contents) => { saved.push({ name, contents }); return saved.length > 1 ? undefined : name },
    openTeamPackage: async () => picked,
    catalog: async () => emptyCatalog, extensionPath: '/app/team-development.ts',
  })
  const call = await piSession('/sessions/developer-1.jsonl')
  expect((await call('export')).ok).toBe(false)
  await call('open', { team_name: '合同复核团队' })
  const exported = await call('export')
  expect(exported.result).toMatchObject({ status: 'done', file: '合同_复核团队.weave-team.json', members: 2, workflows: 1 })
  expect(commands.find((command) => command.action === 'export')).toMatchObject({ teamId: 'source-team', accountId: 'developer-1' })
  expect(JSON.parse(saved[0]!.contents)).toEqual(pkg)
  // Cancelling the dialog writes nothing and says so.
  expect((await call('export')).result).toMatchObject({ status: 'declined' })

  expect((await call('import')).result).toMatchObject({ status: 'declined' })
  picked = { name: 'notes.json', contents: '{"name":"别的东西"}' }
  expect((await call('import')).ok).toBe(false)
  expect(commands.some((command) => command.action === 'import')).toBe(false)
  picked = { name: 'team.weave-team.json', contents: JSON.stringify(pkg) }
  const first = await call('import')
  expect(first.result).toMatchObject({ status: 'done', name: '合同复核团队', file: 'team.weave-team.json', adjustments: ['“审核员”的外部工具“合同库”在本工作区没有，已去掉'] })
  expect((await bridge!.getState('runtime'))).toEqual({ teamId: 'imported-team', revision: 2 })
  // The same file again in the session is the same request.
  await call('import')
  const imports = commands.filter((command): command is Extract<TeamWorkspaceCommand, { action: 'import' }> => command.action === 'import')
  expect(imports).toHaveLength(2)
  expect(imports[0]!.package).toEqual(pkg)
  expect(imports[1]!.requestId).toBe(imports[0]!.requestId)
})

it.each(['pi', 'loom'] as const)('binds %s to one developer draft and previews a change without keeping or saving it', async (harness) => {
  let account = 'developer-1'
  const lead = newMember('deepseek-flash'), worker = newMember('deepseek-flash')
  lead.configuration.role = 'avatar'; worker.configuration.displayName = '审核员'
  const document: TeamDefinition = { name: '合同团队', objective: '复核合同', members: [lead, worker], workflows: [{ id: 'flow', name: '复核', description: '', trigger_config: {}, graph_definition: initialGraph(worker) }] }
  const catalog: EnterpriseBusinessCapabilityCatalog = { version: '1', provider: { id: 'forge', name: 'Forge', status: 'available' }, refreshedAt: '', capabilities: [] }
  const weave = weaveEdits(workspace(document))
  bridge = new TeamDevelopmentAgentBridge({
    accountKey: async () => account,
    developer: async () => ({ accountId: account }),
    teams: async () => [{ id: 'team', name: '合同团队' }],
    team: async () => ({ revision: 4, published_revision: 3, publishing_revision: 0, prepared_revision: 0, document, updated_at: '', trials: [] }),
    workspace: async (command: TeamWorkspaceCommand) => {
      if (command.action === 'operations') return weave.apply(command)
      if (command.action === 'guide') return { topics: [], console_only: '' }
      throw new Error('unexpected workspace call')
    },
    catalog: async () => catalog,
    extensionPath: '/app/team-development.ts',
  })
  await bridge.start()
  const env = bridge.environmentFor({ cwd: '/personal-workspace', harness })
  bridge.bindRuntime(env.GOOEYPI_TEAM_DEVELOPMENT_TOKEN, 'runtime')
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await fetch(env.GOOEYPI_TEAM_DEVELOPMENT_URL!, { method: 'POST', headers: { authorization: `Bearer ${env.GOOEYPI_TEAM_DEVELOPMENT_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ method, params }) })
    return response.json() as Promise<{ ok: boolean; result?: Record<string, unknown> }>
  }
  expect((await call('context')).ok).toBe(false)
  expect((await call('list')).result?.teams).toEqual([{ name: '合同团队' }])
  // New teams are created in the Weave console; the bridge keeps no candidate for one.
  expect((await call('propose_new_team', { name: '反馈团队', objective: '分类反馈' })).ok).toBe(false)
  expect((await call('open', { team_name: '合同团队' })).ok).toBe(true)
  const context = (await call('context')).result
  expect((context?.team as { name: string } | undefined)?.name).toBe('合同团队')
  expect(((context?.team as { workflows: Array<{ resultProtocol: string }> } | undefined)?.workflows[0]?.resultProtocol)).toBe('普通结果')
  expect(JSON.stringify(context)).not.toContain(worker.id)
  expect(JSON.stringify(context)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
  const previewed = await call('preview', { operations: [
    { kind: 'member', member: '审核员', duty: '核对付款条件' },
    { kind: 'result_protocol', flow: '复核', enabled: true, from: '审核员' },
  ] })
  expect(previewed.ok).toBe(true)
  expect(previewed.result?.changes).toEqual(['修改成员：审核员', '已应用：result_protocol'])
  expect(String(previewed.result?.message)).toContain('没有保存')
  expect(weave.commands).toHaveLength(1)
  expect(weave.commands[0]).toMatchObject({ dryRun: true, revision: 4 })
  expect(weave.remote.revision).toBe(4)
  expect(weave.remote.document.members[1]?.relationship.duty).toBe('')
  expect(await bridge.getProposal('runtime')).toBeUndefined()
  expect((await call('propose', { operations: [{ kind: 'member', member: '审核员', duty: '核对付款条件' }] })).ok).toBe(false)
  account = 'developer-2'
  expect((await call('context')).ok).toBe(false)
  expect((await call('save', { operations: [{ kind: 'member', member: '审核员', duty: '不应保存' }] })).ok).toBe(false)
})

it('restores the opened team but no previewed change after a desktop restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'team-dev-proposal-')); tempDirectories.push(directory)
  const storage = { directory }
  const worker = newMember('deepseek-flash'); worker.configuration.displayName = '审核员'
  const document: TeamDefinition = { name: '反馈团队', objective: '整理反馈', members: [worker], workflows: [] }
  const catalog: EnterpriseBusinessCapabilityCatalog = { version: '1', provider: { id: 'forge', name: 'Forge', status: 'available' }, capabilities: [], refreshedAt: '' }
  const options = { accountKey: async () => 'developer-1', developer: async () => ({ accountId: 'developer-1' }), teams: async () => [{ id: 'team', name: '反馈团队' }], team: async () => ({ revision: 7, published_revision: 6, publishing_revision: 0, prepared_revision: 0, document, updated_at: '', trials: [] }), workspace: async (command: TeamWorkspaceCommand) => { if (command.action === 'operations' && command.dryRun) return { revision: 7, saved: false, changes: ['修改成员：审核员'], issues: [] }; throw new Error('unexpected workspace call') }, catalog: async () => catalog, extensionPath: '/app/team-development.ts', storage }
  bridge = new TeamDevelopmentAgentBridge(options)
  await bridge.start()
  const env = bridge.environmentFor({ cwd: '/work', harness: 'pi', sessionPath: '/sessions/developer-1.jsonl' })
  bridge.bindRuntime(env.GOOEYPI_TEAM_DEVELOPMENT_TOKEN, 'old-runtime', '/sessions/developer-1.jsonl')
  await bridge.bindContext('old-runtime', { teamId: 'team', revision: 7, document, catalog }, 'developer-1')
  const response = await fetch(env.GOOEYPI_TEAM_DEVELOPMENT_URL!, { method: 'POST', headers: { authorization: `Bearer ${env.GOOEYPI_TEAM_DEVELOPMENT_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'preview', params: { operations: [{ kind: 'member', member: '审核员', duty: '按产品模块整理反馈' }] } }) })
  expect((await response.json() as { ok: boolean }).ok).toBe(true)
  await bridge.stop()
  bridge = new TeamDevelopmentAgentBridge(options)
  await bridge.start()
  const state = await bridge.getStateForSession('/sessions/developer-1.jsonl')
  expect(state.teamId).toBe('team')
  expect(state.revision).toBe(7)
})

it('saves a controlled draft through a lost answer, runs an idempotent isolated trial, and publishes by request', async () => {
  const lead = newMember('deepseek-flash'), worker = newMember('deepseek-flash')
  lead.configuration.role = 'avatar'; worker.configuration.displayName = '审核员'
  const document: TeamDefinition = { name: '合同团队', objective: '复核合同', members: [lead, worker], workflows: [{ id: 'flow', name: '复核流程', description: '', trigger_config: {}, graph_definition: initialGraph(worker) }] }
  let remote = workspace(document)
  const weave = weaveEdits(remote)
  let loseSaveResponse = true
  const calls: TeamWorkspaceCommand[] = []
  const trials = new Map<string, { runId: string; input: string }>()
  const activityCalls: string[] = []
  const catalog: EnterpriseBusinessCapabilityCatalog = { version: '1', provider: { id: 'forge', name: 'Forge', status: 'available' }, refreshedAt: '', capabilities: [] }
  const options = {
    accountKey: async () => 'developer-1', developer: async () => ({ accountId: 'developer-1' }),
    teams: async () => [{ id: 'team', name: '合同团队' }],
    team: async (teamId: string, accountId: string) => {
      expect(teamId).toBe('team'); expect(accountId).toBe('developer-1')
      return structuredClone(remote)
    },
    workspace: async (command: TeamWorkspaceCommand): Promise<unknown> => {
      calls.push(structuredClone(command))
      expect(command.accountId).toBe('developer-1')
      if (command.action === 'operations') {
        weave.remote = remote
        const answer = weave.apply(command)
        remote = { ...weave.remote, updated_at: 'saved' }
        if (loseSaveResponse) { loseSaveResponse = false; throw new Error('保存回执丢失') }
        return answer
      }
      if (command.action === 'trial') {
        let trial = trials.get(command.requestId)
        if (!trial) { trial = { runId: 'private-run-id', input: command.input }; trials.set(command.requestId, trial) }
        remote = { ...remote, trials: [...remote.trials.filter((item) => item.request_id !== command.requestId), { request_id: command.requestId, run_id: trial.runId, revision: command.revision, workflow_id: command.workflowId, status: 'succeeded', created_at: '' }] }
        return { request_id: command.requestId, run_id: trial.runId }
      }
      if (command.action === 'input') return { input: trials.get(command.requestId)?.input ?? '固定输入', status: 'succeeded', output: '最终结果' }
      if (command.action === 'activity') {
        activityCalls.push(command.runId)
        return {
          status: 'succeeded',
          completeness: { stages: 'partial', member_inputs: 'partial', member_outputs: 'partial', member_tool_activity: 'complete', deliverables: 'complete' },
          members: [{ name: '审核员', status: 'finished', stages: [{
            name: '费用核对', status: 'completed', inputs: [{ source: 'run_input', summary: '输入摘要' }],
            outputs: [
              { kind: 'result', content: '逐项核对完成', content_type: 'text/markdown', content_bytes: 21, truncated: false, output_id: 'private-short-output', full_content: 'stored' },
              { kind: 'result', content: '长输出开头', content_type: 'text/markdown', content_bytes: 900_000, truncated: true, output_id: 'private-long-output', full_content: 'stored' },
            ],
            tools: [{ name: '计算工具', status: 'tool_completed', input: '{"amount":10}', output: '{"total":10}' }],
          }] }],
          outputs: [{ id: 'private-deliverable-id', node_id: worker.id, title: '核对结论', content: '金额一致' }],
        }
      }
      if (command.action === 'trial-output') {
        expect(command.runId).toBe('private-run-id')
        expect(command.outputId).toBe('private-long-output')
        return { content: '长输出开头……以及之后的全部正文', content_type: 'text/markdown', content_bytes: 900_000, full_content: 'stored' }
      }
      if (command.action === 'publish') {
        expect(command.revision).toBe(remote.revision)
        remote = { ...remote, published_revision: command.revision }
        return structuredClone(remote)
      }
      throw new Error(`unexpected action: ${command.action}`)
    },
    catalog: async () => catalog,
    extensionPath: '/app/team-development.ts',
  }
  bridge = new TeamDevelopmentAgentBridge(options)
  await bridge.start()
  const env = bridge.environmentFor({ cwd: '/work', harness: 'pi', sessionPath: '/sessions/developer-1.jsonl' })
  bridge.bindRuntime(env.GOOEYPI_TEAM_DEVELOPMENT_TOKEN, 'runtime', '/sessions/developer-1.jsonl')
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await fetch(env.GOOEYPI_TEAM_DEVELOPMENT_URL!, {
      method: 'POST', headers: { authorization: `Bearer ${env.GOOEYPI_TEAM_DEVELOPMENT_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ method, params }),
    })
    return response.json() as Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }>
  }

  await call('list')
  await call('open', { team_name: '合同团队' })
  const operations = [{ kind: 'member', member: '审核员', duty: '核对费用' }]
  const saved = await call('save', { operations })
  expect(saved.ok).toBe(true)
  expect(saved.result?.message).toContain('当前生效版本没有改变')
  expect(remote.revision).toBe(5)
  expect(remote.published_revision).toBe(3)
  expect(remote.document.members[1]?.relationship.duty).toBe('核对费用')
  // The answer to the first request was lost; the repeat asked under the same id and changed nothing more.
  const saves = calls.flatMap((command) => command.action === 'operations' ? [command] : [])
  expect(saves).toHaveLength(2)
  expect(saves[1]!.requestId).toBe(saves[0]!.requestId)

  const trial1 = await call('trial', { workflow_name: '复核流程', input: '核对这条测试材料' })
  const trial2 = await call('trial', { workflow_name: '复核流程', input: '核对这条测试材料' })
  expect(trial1.ok && trial2.ok).toBe(true)
  const trialCommands = calls.filter((command) => command.action === 'trial')
  expect(trialCommands).toHaveLength(2)
  expect(new Set(trialCommands.flatMap((command) => command.action === 'trial' ? [command.requestId] : [])).size).toBe(1)
  const status = await call('trial_status')
  const text = JSON.stringify(status.result)
  expect(text).toContain('固定输入')
  expect(text).toContain('输入摘要')
  expect(text).toContain('逐项核对完成')
  expect(text).toContain('Weave 实际保存的该步骤输出')
  expect(text).toContain('actual_input')
  expect(text).toContain('金额一致')
  expect(text).toContain('活动记录不完整')
  expect(text).not.toContain('private-run-id')
  expect(text).not.toContain('private-deliverable-id')
  expect(text).not.toContain('private-long-output')
  expect(activityCalls).toEqual(['private-run-id'])
  const trace = status.result?.trace as { members: Array<{ steps: Array<{ outputs: Array<{ output_ref?: string; truncated: boolean; evidence: string }> }> }> }
  const steps = trace.members[0]!.steps[0]!.outputs
  const preview = steps.find((item) => item.truncated)!
  expect(preview.evidence).toContain('全文已保存')
  const whole = await call('trial_output', { output_ref: preview.output_ref })
  expect(whole.ok).toBe(true)
  expect(whole.result?.content).toBe('长输出开头……以及之后的全部正文')
  expect((await call('trial_output', { output_ref: 'output-99' })).ok).toBe(false)

  const updated = await call('update_team')
  expect(updated.ok).toBe(true)
  expect(remote.published_revision).toBe(5)
  expect(calls.filter((command) => command.action === 'publish')).toHaveLength(1)
})

it('freezes only workflow actions and keeps each Pi simulation selection in its own fixed request scope', async () => {
  const lead = newMember('deepseek-flash'), worker = newMember('deepseek-flash'), unrelated = newMember('deepseek-flash')
  lead.configuration.role = 'avatar'; worker.configuration.displayName = '转化员'; unrelated.configuration.displayName = '其他成员'
  const action = { id: 'forge:action:crm_lead.convert', name: '转化线索', description: '将线索转换为商机', effect: 'write' as const, executionMode: 'team_delegable' as const, resourceType: 'crm_lead', requiresEmployeeIntent: true, status: 'available' as const, actionName: 'convert', objectName: 'crm_lead' }
  const unrelatedAction = { ...action, id: 'forge:action:crm_quote.create', name: '创建报价', resourceType: 'crm_quote', actionName: 'create', objectName: 'crm_quote' }
  worker.configuration.businessCapabilityIds = [action.id]
  unrelated.configuration.businessCapabilityIds = [unrelatedAction.id]
  const document: TeamDefinition = { name: '线索团队', objective: '转化线索', members: [lead, worker, unrelated], workflows: [
    { id: 'flow', name: '转化流程', description: '', trigger_config: {}, graph_definition: initialGraph(worker) },
    { id: 'other-flow', name: '其他流程', description: '', trigger_config: {}, graph_definition: initialGraph(unrelated) },
  ] }
  let remote = workspace(document, 6)
  let activeAccount = 'developer-1'
  const calls: TeamWorkspaceCommand[] = []
  const catalog: EnterpriseBusinessCapabilityCatalog = { version: '1', provider: { id: 'forge', name: 'Forge', status: 'available' }, refreshedAt: '', capabilities: [action, unrelatedAction] }
  bridge = new TeamDevelopmentAgentBridge({
    accountKey: async () => activeAccount, developer: async () => ({ accountId: activeAccount }),
    teams: async () => [{ id: 'team', name: document.name }], team: async () => structuredClone(remote),
    catalog: async () => catalog, extensionPath: '/app/team-development.ts',
    workspace: async (command: TeamWorkspaceCommand) => {
      calls.push(structuredClone(command))
      if (command.action !== 'trial') throw new Error(`unexpected workspace action: ${command.action}`)
      remote = { ...remote, trials: [...remote.trials, { request_id: command.requestId, run_id: `run-${remote.trials.length}`, revision: command.revision, workflow_id: command.workflowId, status: 'running', created_at: '' }] }
      return { request_id: command.requestId, run_id: `run-${remote.trials.length - 1}` }
    },
  })
  await bridge.start()
  const env = bridge.environmentFor({ cwd: '/work', harness: 'pi', sessionPath: '/sessions/developer-1.jsonl' })
  bridge.bindRuntime(env.GOOEYPI_TEAM_DEVELOPMENT_TOKEN, 'runtime', '/sessions/developer-1.jsonl')
  await bridge.bindContext('runtime', { teamId: 'team', revision: 6, document, catalog }, activeAccount)
  const callMethod = async (method: string, params: Record<string, unknown>, requestEnv = env) => {
    const response = await fetch(requestEnv.GOOEYPI_TEAM_DEVELOPMENT_URL!, { method: 'POST', headers: { authorization: `Bearer ${requestEnv.GOOEYPI_TEAM_DEVELOPMENT_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ method, params }) })
    return response.json() as Promise<{ ok: boolean; error?: string }>
  }
  const call = (params: Record<string, unknown>, requestEnv = env) => callMethod('trial', params, requestEnv)
  const input = '核对开发者提供的线索材料'
  const selectedParams = { workflow_name: '转化流程', input, simulation_actions: ['转化线索'] }
  expect((await call(selectedParams)).ok).toBe(false)
  expect(calls.filter((command) => command.action === 'trial')).toHaveLength(0)
  expect((await callMethod('context', {})).ok).toBe(true)
  const afterContextOnly = await call(selectedParams)
  expect(afterContextOnly.ok).toBe(false)
  expect(afterContextOnly.error).toContain('当前账号和桌面会话中的员工请求')
  expect(calls.filter((command) => command.action === 'trial')).toHaveLength(0)

  const employeePrompt = '请在当前轮次隔离模拟转化线索'
  bridge.beginEmployeeCommand('runtime', 'prompt')
  await bridge.captureTrustedEmployeeCommand('runtime', { type: 'prompt', message: employeePrompt }, { text: employeePrompt, materials: [] })
  expect((await call({ workflow_name: '转化流程', input })).ok).toBe(true)
  expect((await call({ workflow_name: '转化流程', input })).ok).toBe(true)
  const defaultScope = calls.filter((command) => command.action === 'trial')
  expect(defaultScope).toHaveLength(2)
  expect(defaultScope[0]!.requestId).toBe(defaultScope[1]!.requestId)
  expect(defaultScope[0]!.businessActions).toMatchObject([{ id: action.id, simulationAuthorized: false }])
  expect(defaultScope[0]!.businessActions.map((item) => item.id)).not.toContain(unrelatedAction.id)

  const selected = await call(selectedParams)
  expect(selected.ok).toBe(true)
  const selectedRequest = calls.filter((command) => command.action === 'trial').at(-1)!
  expect(selectedRequest.requestId).not.toBe(defaultScope[0]!.requestId)
  expect(selectedRequest.businessActions).toMatchObject([{ id: action.id, simulationAuthorized: true }])
  catalog.capabilities[0]!.description = '目录刚刷新后的新说明'
  await bridge.bindContext('runtime', { teamId: 'team', revision: 6, document, catalog }, activeAccount)
  expect((await call(selectedParams)).ok).toBe(true)
  const retry = calls.filter((command) => command.action === 'trial').at(-1)!
  expect(retry.requestId).toBe(selectedRequest.requestId)
  expect(retry.businessActions).toEqual(selectedRequest.businessActions)

  const otherWorkflow = await call({ workflow_name: '其他流程', input, simulation_actions: ['创建报价'] })
  expect(otherWorkflow.ok).toBe(false)
  expect(otherWorkflow.error).toContain('已绑定其他团队、草稿修订或流程')
  expect(calls.filter((command) => command.action === 'trial')).toHaveLength(4)

  const invalid = await call({ workflow_name: '转化流程', input, simulation_actions: ['创建报价'] })
  expect(invalid.ok).toBe(false)
  expect(invalid.error).toContain('不属于当前流程候选范围')
  expect(calls.filter((command) => command.action === 'trial')).toHaveLength(4)

  bridge.beginEmployeeCommand('runtime', 'abort')
  const afterAbort = await call(selectedParams)
  expect(afterAbort.ok).toBe(false)
  expect(afterAbort.error).toContain('当前账号和桌面会话中的员工请求')
  bridge.beginEmployeeCommand('runtime', 'compact')
  const afterCompact = await call(selectedParams)
  expect(afterCompact.ok).toBe(false)
  expect(afterCompact.error).toContain('当前账号和桌面会话中的员工请求')
  expect(calls.filter((command) => command.action === 'trial')).toHaveLength(4)

  activeAccount = 'developer-2'
  bridge.invalidateAccount()
  const switchedEnv = bridge.environmentFor({ cwd: '/work', harness: 'pi', sessionPath: '/sessions/developer-1.jsonl' })
  bridge.bindRuntime(switchedEnv.GOOEYPI_TEAM_DEVELOPMENT_TOKEN, 'runtime', '/sessions/developer-1.jsonl')
  await bridge.bindContext('runtime', { teamId: 'team', revision: 6, document, catalog }, activeAccount)
  const afterAccountChange = await call(selectedParams, switchedEnv)
  expect(afterAccountChange.ok).toBe(false)
  expect(afterAccountChange.error).toContain('当前账号和桌面会话中的员工请求')
  expect(calls.filter((command) => command.action === 'trial')).toHaveLength(4)
})

it('does not let a user turn arriving after a Pi trial call retroactively authorize that call', async () => {
  const lead = newMember('deepseek-flash'), worker = newMember('deepseek-flash')
  lead.configuration.role = 'avatar'; worker.configuration.displayName = '转化员'
  const action = { id: 'forge:action:crm_lead.convert', name: '转化线索', description: '把线索转为商机', effect: 'write' as const, executionMode: 'team_delegable' as const, resourceType: 'crm_lead', requiresEmployeeIntent: true, status: 'available' as const, actionName: 'convert', objectName: 'crm_lead' }
  worker.configuration.businessCapabilityIds = [action.id]
  const document: TeamDefinition = { name: '线索团队', objective: '转化线索', members: [lead, worker], workflows: [{ id: 'flow', name: '转化流程', description: '', trigger_config: {}, graph_definition: initialGraph(worker) }] }
  const remote = workspace(document, 6)
  const catalog: EnterpriseBusinessCapabilityCatalog = { version: '1', provider: { id: 'forge', name: 'Forge', status: 'available' }, refreshedAt: '', capabilities: [action] }
  let announceDeveloper!: () => void
  let releaseDeveloper!: (value: { accountId: string }) => void
  const developerStarted = new Promise<void>((resolve) => { announceDeveloper = resolve })
  const developerGate = new Promise<{ accountId: string }>((resolve) => { releaseDeveloper = resolve })
  const calls: TeamWorkspaceCommand[] = []
  bridge = new TeamDevelopmentAgentBridge({
    accountKey: async () => 'developer-1', developer: async () => { announceDeveloper(); return developerGate },
    teams: async () => [{ id: 'team', name: document.name }], team: async () => structuredClone(remote),
    catalog: async () => catalog, extensionPath: '/app/team-development.ts',
    workspace: async (command) => { calls.push(command); return {} },
  })
  await bridge.start()
  const env = bridge.environmentFor({ cwd: '/work', harness: 'pi', sessionPath: '/sessions/developer-1.jsonl' })
  bridge.bindRuntime(env.GOOEYPI_TEAM_DEVELOPMENT_TOKEN, 'runtime', '/sessions/developer-1.jsonl')
  await bridge.bindContext('runtime', { teamId: 'team', revision: 6, document, catalog }, 'developer-1')
  const responsePromise = fetch(env.GOOEYPI_TEAM_DEVELOPMENT_URL!, { method: 'POST', headers: { authorization: `Bearer ${env.GOOEYPI_TEAM_DEVELOPMENT_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'trial', params: { workflow_name: '转化流程', input: '核对当前材料', simulation_actions: ['转化线索'] } }) })
  await developerStarted
  const laterPrompt = '请在隔离环境中模拟转化线索'
  bridge.beginEmployeeCommand('runtime', 'prompt')
  await bridge.captureTrustedEmployeeCommand('runtime', { type: 'prompt', message: laterPrompt }, { text: laterPrompt, materials: [] })
  releaseDeveloper({ accountId: 'developer-1' })
  const response = await responsePromise
  const result = await response.json() as { ok: boolean; error?: string }
  expect(result.ok).toBe(false)
  expect(result.error).toContain('当前账号和桌面会话中的员工请求')
  expect(calls.filter((command) => command.action === 'trial')).toHaveLength(0)
})

it.each(['pi', 'loom'] as const)('invalidates the %s simulation source when the UI changes team, revision, or an unsaved workflow document', async (harness) => {
  const worker = newMember('deepseek-flash')
  worker.configuration.displayName = '审核员'
  const action = { id: 'forge:action:contracts.submit', name: '提交合同', description: '提交合同版本', effect: 'write' as const, executionMode: 'team_delegable' as const, resourceType: 'contracts', requiresEmployeeIntent: true, status: 'available' as const, actionName: 'Submit', objectName: 'contracts' }
  worker.configuration.businessCapabilityIds = [action.id]
  const document: TeamDefinition = { name: '合同团队', objective: '审核合同', members: [worker], workflows: [{ id: 'flow', name: '合同流程', description: '', trigger_config: {}, graph_definition: initialGraph(worker) }] }
  const remote = workspace(document, 6)
  const catalog: EnterpriseBusinessCapabilityCatalog = { version: '1', provider: { id: 'forge', name: 'Forge', status: 'available' }, refreshedAt: '', capabilities: [action] }
  const calls: TeamWorkspaceCommand[] = []
  bridge = new TeamDevelopmentAgentBridge({
    accountKey: async () => 'developer-1', developer: async () => ({ accountId: 'developer-1' }),
    teams: async () => [{ id: 'team', name: document.name }, { id: 'other-team', name: '其他团队' }],
    team: async () => structuredClone(remote), catalog: async () => catalog, extensionPath: '/app/team-development.ts',
    workspace: async (command) => { calls.push(command); return command.action === 'trial' ? { request_id: command.requestId, run_id: 'run-1' } : {} },
  })
  await bridge.start()
  const env = bridge.environmentFor({ cwd: '/work', harness, sessionPath: '/sessions/developer-1.jsonl' })
  bridge.bindRuntime(env.GOOEYPI_TEAM_DEVELOPMENT_TOKEN, 'runtime', '/sessions/developer-1.jsonl')
  const originalContext = { teamId: 'team', revision: 6, document, catalog }
  await bridge.bindContext('runtime', originalContext, 'developer-1')
  const call = async () => {
    const response = await fetch(env.GOOEYPI_TEAM_DEVELOPMENT_URL!, { method: 'POST', headers: { authorization: `Bearer ${env.GOOEYPI_TEAM_DEVELOPMENT_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'trial', params: { workflow_name: '合同流程', input: '核对当前合同', simulation_actions: ['提交合同'] } }) })
    return response.json() as Promise<{ ok: boolean; error?: string }>
  }
  const capture = async (text: string) => {
    bridge!.beginEmployeeCommand('runtime', 'prompt')
    await bridge!.captureTrustedEmployeeCommand('runtime', { type: 'prompt', message: text }, { text, materials: [] })
  }
  const changedDocument = structuredClone(document)
  changedDocument.objective = '调整未保存的审核目标'
  const changedWorkflow = structuredClone(document)
  changedWorkflow.workflows[0]!.name = '改过的合同流程'
  for (const [label, changed] of [
    ['team', { ...originalContext, teamId: 'other-team' }],
    ['revision', { ...originalContext, revision: 7 }],
    ['unsaved document', { ...originalContext, document: changedDocument }],
    ['workflow', { ...originalContext, document: changedWorkflow }],
  ] as const) {
    await capture(`切换上下文测试 ${label}`)
    expect((await call()).ok, label).toBe(true)
    const beforeContextChange = calls.filter((command) => command.action === 'trial').length
    await bridge.bindContext('runtime', changed, 'developer-1')
    await bridge.bindContext('runtime', originalContext, 'developer-1')
    const denied = await call()
    expect(denied.ok, label).toBe(false)
    expect(denied.error, label).toContain('当前账号和桌面会话中的员工请求')
    expect(calls.filter((command) => command.action === 'trial')).toHaveLength(beforeContextChange)
  }
  expect(calls.filter((command) => command.action === 'trial')).toHaveLength(4)
})

it.each(['pi', 'loom'] as const)('opens the first %s team and rebinds the same user turn through a controlled save before trial', async (harness) => {
  const worker = newMember('deepseek-flash')
  worker.configuration.displayName = '审核员'
  worker.configuration.businessCapabilityIds = ['forge:action:contracts.submit']
  const action = { id: 'forge:action:contracts.submit', name: '提交合同', description: '提交合同版本', effect: 'write' as const, executionMode: 'team_delegable' as const, resourceType: 'contracts', requiresEmployeeIntent: true, status: 'available' as const, actionName: 'Submit', objectName: 'contracts' }
  const document: TeamDefinition = { name: '合同团队', objective: '审核合同', members: [worker], workflows: [{ id: 'flow', name: '合同流程', description: '', trigger_config: {}, graph_definition: initialGraph(worker) }] }
  let remote = workspace(document, 6)
  const catalog: EnterpriseBusinessCapabilityCatalog = { version: '1', provider: { id: 'forge', name: 'Forge', status: 'available' }, refreshedAt: '', capabilities: [action] }
  const calls: TeamWorkspaceCommand[] = []
  const weave = weaveEdits(remote)
  bridge = new TeamDevelopmentAgentBridge({
    accountKey: async () => 'developer-1', developer: async () => ({ accountId: 'developer-1' }),
    teams: async () => [{ id: 'team', name: document.name }], team: async () => structuredClone(remote),
    catalog: async () => catalog, extensionPath: '/app/team-development.ts',
    workspace: async (command) => {
      calls.push(structuredClone(command))
      if (command.action === 'operations') {
        weave.remote = remote
        const answer = weave.apply(command)
        remote = weave.remote
        return answer
      }
      if (command.action === 'trial') {
        remote = { ...remote, trials: [...remote.trials, { request_id: command.requestId, run_id: `run-${remote.trials.length}`, revision: command.revision, workflow_id: command.workflowId, status: 'running', created_at: '' }] }
        return { request_id: command.requestId, run_id: `run-${remote.trials.length - 1}` }
      }
      throw new Error(`unexpected action: ${command.action}`)
    },
  })
  await bridge.start()
  const env = bridge.environmentFor({ cwd: '/work', harness, sessionPath: '/sessions/developer-1.jsonl' })
  bridge.bindRuntime(env.GOOEYPI_TEAM_DEVELOPMENT_TOKEN, 'runtime', '/sessions/developer-1.jsonl')
  const employeePrompt = '打开合同团队，先保存职责修改，再模拟提交合同流程'
  bridge.beginEmployeeCommand('runtime', 'prompt')
  await bridge.captureTrustedEmployeeCommand('runtime', { type: 'prompt', message: employeePrompt }, { text: employeePrompt, materials: [] })
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await fetch(env.GOOEYPI_TEAM_DEVELOPMENT_URL!, { method: 'POST', headers: { authorization: `Bearer ${env.GOOEYPI_TEAM_DEVELOPMENT_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ method, params }) })
    return response.json() as Promise<{ ok: boolean; error?: string }>
  }
  expect((await call('list')).ok).toBe(true)
  expect((await call('open', { team_name: document.name })).ok).toBe(true)
  expect((await call('trial', { workflow_name: '合同流程', input: '首次打开后的隔离检查', simulation_actions: ['提交合同'] })).ok).toBe(true)
  const openedTrial = calls.filter((command) => command.action === 'trial').at(-1)!
  expect(openedTrial).toMatchObject({ revision: 6, businessActions: [{ id: action.id, simulationAuthorized: true }] })
  const saved = await call('save', { operations: [{ kind: 'member', member: '审核员', duty: '逐项核验并提交' }] })
  expect(saved.ok).toBe(true)
  expect(remote.revision).toBe(7)
  expect((await call('trial', { workflow_name: '合同流程', input: '保存后首轮隔离检查', simulation_actions: ['提交合同'] })).ok).toBe(true)
  const afterFirstSave = calls.filter((command) => command.action === 'trial').at(-1)!
  const savedAgain = await call('save', { operations: [{ kind: 'member', member: '审核员', duty: '再次核验后提交' }] })
  expect(savedAgain.ok).toBe(true)
  expect(remote.revision).toBe(8)
  const afterSave = await call('trial', { workflow_name: '合同流程', input: '保存后隔离检查', simulation_actions: ['提交合同'] })
  expect(afterSave.ok).toBe(true)
  const trials = calls.filter((command) => command.action === 'trial')
  expect(trials).toHaveLength(3)
  expect(trials[0]).toMatchObject({ requestId: openedTrial.requestId, revision: 6 })
  expect(trials[1]).toMatchObject({ requestId: afterFirstSave.requestId, revision: 7 })
  expect(trials[2]).toMatchObject({ revision: 8, businessActions: [{ id: action.id, simulationAuthorized: true }] })
})

it('restores the original fixed action definition after an uncertain Pi trial response', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'team-trial-scope-')); tempDirectories.push(directory)
  const lead = newMember('deepseek-flash'), worker = newMember('deepseek-flash')
  lead.configuration.role = 'avatar'; worker.configuration.displayName = '转化员'
  const action = { id: 'forge:action:crm_lead.convert', name: '转化线索', description: '原始动作定义', effect: 'write' as const, executionMode: 'team_delegable' as const, resourceType: 'crm_lead', requiresEmployeeIntent: true, status: 'available' as const, actionName: 'convert', objectName: 'crm_lead' }
  worker.configuration.businessCapabilityIds = [action.id]
  const document: TeamDefinition = { name: '线索团队', objective: '转化线索', members: [lead, worker], workflows: [{ id: 'flow', name: '转化流程', description: '', trigger_config: {}, graph_definition: initialGraph(worker) }] }
  const remote = workspace(document, 6)
  const firstCalls: TeamWorkspaceCommand[] = [], retryCalls: TeamWorkspaceCommand[] = []
  const base = {
    accountKey: async () => 'developer-1', developer: async () => ({ accountId: 'developer-1' }),
    teams: async () => [{ id: 'team', name: document.name }], team: async () => structuredClone(remote),
    extensionPath: '/app/team-development.ts', storage: { directory },
  }
  const firstCatalog: EnterpriseBusinessCapabilityCatalog = { version: '1', provider: { id: 'forge', name: 'Forge', status: 'available' }, refreshedAt: '', capabilities: [action] }
  bridge = new TeamDevelopmentAgentBridge({
    ...base, catalog: async () => firstCatalog,
    workspace: async (command) => { firstCalls.push(structuredClone(command)); throw new Error('试跑响应暂未收到') },
  })
  await bridge.start()
  const firstEnv = bridge.environmentFor({ cwd: '/work', harness: 'pi', sessionPath: '/sessions/developer-1.jsonl' })
  bridge.bindRuntime(firstEnv.GOOEYPI_TEAM_DEVELOPMENT_TOKEN, 'runtime', '/sessions/developer-1.jsonl')
  await bridge.bindContext('runtime', { teamId: 'team', revision: 6, document, catalog: firstCatalog }, 'developer-1')
  const employeePrompt = '私有模拟授权原文：请在隔离环境中模拟转化线索'
  bridge.beginEmployeeCommand('runtime', 'prompt')
  await bridge.captureTrustedEmployeeCommand('runtime', { type: 'prompt', message: employeePrompt }, { text: employeePrompt, materials: [] })
  const call = async (env: NodeJS.ProcessEnv) => {
    const response = await fetch(env.GOOEYPI_TEAM_DEVELOPMENT_URL!, { method: 'POST', headers: { authorization: `Bearer ${env.GOOEYPI_TEAM_DEVELOPMENT_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'trial', params: { workflow_name: '转化流程', input: '核对这条材料', simulation_actions: ['转化线索'] } }) })
    return response.json() as Promise<{ ok: boolean; error?: string }>
  }
  expect((await call(firstEnv)).ok).toBe(false)
  const original = firstCalls.find((command) => command.action === 'trial')!
  expect((await call(firstEnv)).ok).toBe(false)
  expect(firstCalls.filter((command) => command.action === 'trial')).toHaveLength(2)
  expect(firstCalls.at(-1)).toMatchObject({ action: 'trial', requestId: original.requestId })
  const savedFile = readdirSync(directory).find((file) => file.endsWith('.json'))!
  const savedText = readFileSync(join(directory, savedFile), 'utf8')
  const saved = JSON.parse(savedText) as { value: { trial: Record<string, unknown> } }
  expect(saved.value.trial.authorizationSourceHash).toMatch(/^[0-9a-f]{64}$/)
  expect(savedText).not.toContain(employeePrompt)
  expect(savedText).not.toContain('trusted_desktop_employee_input')
  await bridge.stop(); bridge = undefined

  const refreshedCatalog: EnterpriseBusinessCapabilityCatalog = { ...firstCatalog, capabilities: [{ ...action, description: '刷新后的动作定义' }] }
  bridge = new TeamDevelopmentAgentBridge({
    ...base, catalog: async () => refreshedCatalog,
    workspace: async (command) => { retryCalls.push(structuredClone(command)); if (command.action !== 'trial') throw new Error('unexpected workspace action'); return { request_id: command.requestId, run_id: 'run-1' } },
  })
  await bridge.start()
  const retryEnv = bridge.environmentFor({ cwd: '/work', harness: 'pi', sessionPath: '/sessions/developer-1.jsonl' })
  bridge.bindRuntime(retryEnv.GOOEYPI_TEAM_DEVELOPMENT_TOKEN, 'runtime', '/sessions/developer-1.jsonl')
  const afterRestart = await call(retryEnv)
  expect(afterRestart.ok).toBe(false)
  expect(afterRestart.error).toContain('当前账号和桌面会话中的员工请求')
  expect(retryCalls.filter((command) => command.action === 'trial')).toHaveLength(0)
})

it.each(trialWireCases)('interprets the same $name wire record as the trial panel without inventing payload evidence', async (tool) => {
  const lead = newMember('deepseek-flash'), worker = newMember('deepseek-flash')
  lead.configuration.role = 'avatar'
  worker.configuration.businessCapabilityIds = [trialToolAction.id]
  const document: TeamDefinition = { name: '线索团队', objective: '', members: [lead, worker], workflows: [{ id: 'flow', name: '线索流程', description: '', trigger_config: {}, graph_definition: initialGraph(worker) }] }
  const remote = workspace(document)
  const directory = mkdtempSync(join(tmpdir(), 'trial-evidence-')); tempDirectories.push(directory)
  const catalog: EnterpriseBusinessCapabilityCatalog = { version: '1', provider: { id: 'forge', name: 'Forge', status: 'available' }, capabilities: [trialToolAction], refreshedAt: '' }
  bridge = new TeamDevelopmentAgentBridge({
    accountKey: async () => 'developer-1', developer: async () => ({ accountId: 'developer-1' }), teams: async () => [{ id: 'team', name: document.name }],
    team: async () => structuredClone(remote), catalog: async () => catalog, extensionPath: '/app/team-development.ts', storage: { directory },
    workspace: async (command) => {
      if (command.action === 'trial') return { request_id: command.requestId, run_id: 'private-run' }
      if (command.action === 'input') return { input: '合成固定输入', status: 'succeeded', output: '模型自述：已经转化。' }
      if (command.action === 'activity') return trialWireActivity(tool)
      throw new Error('unexpected mutation')
    },
  })
  await bridge.start()
  const env = bridge.environmentFor({ cwd: '/work', harness: 'pi' })
  bridge.bindRuntime(env.GOOEYPI_TEAM_DEVELOPMENT_TOKEN, 'runtime')
  await bridge.bindContext('runtime', { teamId: 'team', revision: remote.revision, document, catalog }, 'developer-1')
  const call = async (method: string, params = {}) => {
    const response = await fetch(env.GOOEYPI_TEAM_DEVELOPMENT_URL!, { method: 'POST', headers: { authorization: `Bearer ${env.GOOEYPI_TEAM_DEVELOPMENT_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ method, params }) })
    return response.json() as Promise<{ ok: boolean; result: { trace: { completeness: { tool_input_output: string }; trajectory: string; members: Array<{ steps: Array<{ tools: Array<{ name: string; status: string; evidence: string; actual_input?: string; actual_output?: string }> }> }> } } }>
  }
  expect((await call('trial', { workflow_name: '线索流程', input: '合成固定输入' })).ok).toBe(true)
  const result = await call('trial_status')
  expect(result.ok).toBe(true)
  expect(result.result.trace.members[0]!.steps[0]!.tools).toEqual([])
  const actual = result.result.trace.members[0]!.steps[1]!.tools[0]!
  expect(actual.name).toBe(tool.displayName ?? '工具调用')
  expect(actual.status).toBe(tool.label)
  expect(actual.actual_input).toBe(tool.hiddenInput ? undefined : tool.input)
  expect(actual.actual_output).toBe(tool.hiddenOutput ? undefined : tool.output)
  expect(result.result.trace.completeness.tool_input_output).toBe(tool.completeness)
  if (!tool.input && !tool.output && tool.completeness === '不可用') {
    expect(actual.evidence).toBe('此调试记录未保存调用参数和模拟回执')
    expect(result.result.trace.trajectory).not.toBe('完整活动记录')
  }
  if (tool.input_state === 'truncated') {
    expect(actual.evidence).toContain('调用参数已截断')
    expect(result.result.trace.trajectory).not.toBe('完整活动记录')
  }
  const text = JSON.stringify(result.result)
  expect(text).not.toContain('private-node-')
  expect(text).not.toContain('private-call')
})

it('leaves a draft that moved on alone and starts again from it when the team is reopened', async () => {
  const weave = weaveEdits(workspace(reviewTeam(), 7))
  bridge = new TeamDevelopmentAgentBridge({
    accountKey: async () => 'developer-1', developer: async () => ({ accountId: 'developer-1' }), teams: async () => [{ id: 'team', name: '合同团队' }],
    team: async () => structuredClone(weave.remote),
    workspace: async (command) => {
      if (command.action === 'operations') return weave.apply(command)
      if (command.action === 'guide') return { topics: [], console_only: '' }
      throw new Error(`unexpected action: ${command.action}`)
    },
    catalog: async () => emptyCatalog, extensionPath: '/app/team-development.ts',
  })
  const call = await piSession()
  await call('open', { team_name: '合同团队' })
  weave.remote = { ...weave.remote, revision: 8, document: { ...weave.remote.document, objective: '另一位开发者的新目标' } }
  const operations = [{ kind: 'member', member: '审核员', duty: '按模块分类' }]
  for (const method of ['save', 'save', 'preview']) {
    const refused = await call(method, { operations })
    expect(refused.ok).toBe(false)
    expect(refused.error).toContain('团队草稿已变化')
    expect(refused.error).toContain('重新打开该团队')
  }
  expect(weave.remote.revision).toBe(8)
  expect(weave.remote.document.members[1]?.relationship.duty).toBe('')
  expect(JSON.stringify((await call('context')).result)).toContain('已在别处变化')

  // Reopening reads the draft as it now stands; the same change then goes through.
  const reopened = await call('open', { team_name: '合同团队' })
  expect(reopened.ok).toBe(true)
  expect((await bridge!.getState('runtime')).revision).toBe(8)
  expect(((await call('context')).result?.team as { objective: string; draftStatus: string })).toMatchObject({ objective: '另一位开发者的新目标', draftStatus: '当前草稿' })
  expect((await call('save', { operations })).ok).toBe(true)
  expect(weave.remote.revision).toBe(9)
  expect(weave.remote.document.members[1]?.relationship.duty).toBe('按模块分类')
})

it('refuses to update a team whose action-bound flow lacks the receipt completion check', async () => {
  const lead = newMember('deepseek-flash'), worker = newMember('deepseek-flash')
  lead.configuration.role = 'avatar'; worker.configuration.displayName = '转化员'
  worker.configuration.businessCapabilityIds = ['forge:action:crm_lead.convert']
  const document: TeamDefinition = { name: '线索团队', objective: '转化线索', members: [lead, worker], workflows: [{ id: 'flow', name: '转化流程', description: '', trigger_config: {}, graph_definition: initialGraph(worker) }] }
  const calls: TeamWorkspaceCommand[] = []
  const catalog: EnterpriseBusinessCapabilityCatalog = { version: '1', provider: { id: 'forge', name: 'Forge', status: 'available' }, refreshedAt: '', capabilities: [
    { id: 'forge:action:crm_lead.convert', name: '转化线索', description: '把线索转为商机', effect: 'write', executionMode: 'team_delegable', resourceType: 'crm_lead', requiresEmployeeIntent: true, status: 'available' },
  ] }
  bridge = new TeamDevelopmentAgentBridge({
    accountKey: async () => 'developer-1', developer: async () => ({ accountId: 'developer-1' }), teams: async () => [{ id: 'team', name: '线索团队' }],
    team: async () => workspace(document), catalog: async () => catalog, extensionPath: '/app/team-development.ts',
    workspace: async (command: TeamWorkspaceCommand) => { calls.push(command); throw new Error(`unexpected workspace call: ${command.action}`) },
  })
  await bridge.start()
  const env = bridge.environmentFor({ cwd: '/work', harness: 'pi', sessionPath: '/sessions/developer-1.jsonl' })
  bridge.bindRuntime(env.GOOEYPI_TEAM_DEVELOPMENT_TOKEN, 'runtime', '/sessions/developer-1.jsonl')
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await fetch(env.GOOEYPI_TEAM_DEVELOPMENT_URL!, {
      method: 'POST', headers: { authorization: `Bearer ${env.GOOEYPI_TEAM_DEVELOPMENT_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ method, params }),
    })
    return response.json() as Promise<{ ok: boolean; error?: string }>
  }
  await call('list')
  await call('open', { team_name: '线索团队' })
  const updated = await call('update_team')
  expect(updated.ok).toBe(false)
  expect(updated.error).toContain('转化流程')
  expect(updated.error).toContain('完成检查')
  expect(calls).toHaveLength(0)
})

it('requires current server readiness for Pi publication of a write-action flow', async () => {
  const lead = newMember('deepseek-flash'), worker = newMember('deepseek-flash')
  lead.configuration.role = 'avatar'; worker.configuration.displayName = '转化员'
  const action = { id: 'forge:action:crm_lead.convert', name: '转化线索', description: '把线索转为商机', effect: 'write' as const, executionMode: 'team_delegable' as const, resourceType: 'crm_lead', requiresEmployeeIntent: true, status: 'available' as const, actionName: 'convert', objectName: 'crm_lead' }
  worker.configuration.businessCapabilityIds = [action.id]
  const flow: TeamDefinition['workflows'][number] = { id: 'flow', name: '转化流程', description: '', trigger_config: {}, graph_definition: initialGraph(worker) }
  flow.graph_definition.delivery_contract = {
    version: 1, coverage: 'incomplete', output: { type: 'text' }, external_effects: 'required', external_effects_check_id: 'business-action-receipts',
    required_checks: [{ id: 'business-action-receipts', title: '已授权业务动作具备成功回执', verifier_id: 'weave.business-action-receipts', verifier_version: 'v1', parameters: { required_capability_ids: [action.id], when_authorized: true, allow_needs_input: false } }],
  }
  const document: TeamDefinition = { name: '线索团队', objective: '转化线索', members: [lead, worker], workflows: [flow] }
  let remote = { ...workspace(document, 6), trials: [{ request_id: 'trial', revision: 6, workflow_id: flow.id, run_id: 'run', status: 'succeeded', created_at: '' }] }
  const publishCalls: TeamWorkspaceCommand[] = []
  const catalog: EnterpriseBusinessCapabilityCatalog = { version: '1', provider: { id: 'forge', name: 'Forge', status: 'available' }, refreshedAt: '', capabilities: [action] }
  bridge = new TeamDevelopmentAgentBridge({
    accountKey: async () => 'developer-1', developer: async () => ({ accountId: 'developer-1' }),
    teams: async () => [{ id: 'team', name: document.name }], team: async () => structuredClone(remote),
    catalog: async () => catalog, extensionPath: '/app/team-development.ts',
    workspace: async (command: TeamWorkspaceCommand) => {
      publishCalls.push(command)
      if (command.action !== 'publish') throw new Error(`unexpected workspace action: ${command.action}`)
      remote = { ...remote, published_revision: command.revision }
      return structuredClone(remote)
    },
  })
  await bridge.start()
  const env = bridge.environmentFor({ cwd: '/work', harness: 'pi' })
  bridge.bindRuntime(env.GOOEYPI_TEAM_DEVELOPMENT_TOKEN, 'runtime')
  await bridge.bindContext('runtime', { teamId: 'team', revision: 6, document, catalog }, 'developer-1')
  const call = async () => {
    const response = await fetch(env.GOOEYPI_TEAM_DEVELOPMENT_URL!, { method: 'POST', headers: { authorization: `Bearer ${env.GOOEYPI_TEAM_DEVELOPMENT_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'update_team', params: {} }) })
    return response.json() as Promise<{ ok: boolean; error?: string }>
  }

  const legacy = await call()
  expect(legacy.ok).toBe(false)
  expect(legacy.error).toContain('无法确认当前草稿的模拟回执覆盖')
  expect(legacy.error).not.toContain(action.id)
  expect(publishCalls).toHaveLength(0)

  remote.publication_readiness = { ready: true, workflows: [{ workflow_id: flow.id, required_capability_ids: [action.id], covered_capability_ids: [action.id], missing_capability_ids: [], passed: true }] }
  const ready = await call()
  expect(ready.ok).toBe(true)
  expect(publishCalls.map((command) => command.action)).toEqual(['publish'])
  expect(remote.published_revision).toBe(6)
})

it('fails closed on a legacy write-flow response without readiness and publishes only after server coverage passes', async () => {
  const lead = newMember('deepseek-flash'), worker = newMember('deepseek-flash')
  lead.configuration.role = 'avatar'; worker.configuration.displayName = '转化员'
  const action = { id: 'forge:action:crm_lead.convert', name: '转化线索', description: '把线索转为商机', effect: 'write' as const, executionMode: 'team_delegable' as const, resourceType: 'crm_lead', requiresEmployeeIntent: true, status: 'available' as const, actionName: 'convert', objectName: 'crm_lead' }
  worker.configuration.businessCapabilityIds = [action.id]
  const flow = { id: 'flow', name: '转化流程', description: '', trigger_config: {}, graph_definition: initialGraph(worker) }
  flow.graph_definition.delivery_contract = {
    version: 1, coverage: 'incomplete', output: { type: 'text' }, external_effects: 'required', external_effects_check_id: 'business-action-receipts',
    required_checks: [{ id: 'business-action-receipts', title: '已授权业务动作具备成功回执', verifier_id: 'weave.business-action-receipts', verifier_version: 'v1', parameters: { required_capability_ids: [action.id], when_authorized: true, allow_needs_input: false } }],
  }
  const document: TeamDefinition = { name: '线索团队', objective: '转化线索', members: [lead, worker], workflows: [flow] }
  let remote = { ...workspace(document, 6), trials: [{ request_id: 'trial', revision: 6, workflow_id: flow.id, run_id: 'run', status: 'succeeded', created_at: '' }] }
  const publishCalls: TeamWorkspaceCommand[] = []
  const catalog: EnterpriseBusinessCapabilityCatalog = { version: '1', provider: { id: 'forge', name: 'Forge', status: 'available' }, refreshedAt: '', capabilities: [action] }
  bridge = new TeamDevelopmentAgentBridge({
    accountKey: async () => 'developer-1', developer: async () => ({ accountId: 'developer-1' }),
    teams: async () => [{ id: 'team', name: document.name }], team: async () => structuredClone(remote),
    catalog: async () => catalog, extensionPath: '/app/team-development.ts',
    workspace: async (command: TeamWorkspaceCommand) => {
      publishCalls.push(command)
      if (command.action !== 'publish') throw new Error(`unexpected workspace action: ${command.action}`)
      remote = { ...remote, published_revision: command.revision }
      return structuredClone(remote)
    },
  })
  await bridge.start()
  const env = bridge.environmentFor({ cwd: '/work', harness: 'pi' })
  bridge.bindRuntime(env.GOOEYPI_TEAM_DEVELOPMENT_TOKEN, 'runtime')
  await bridge.bindContext('runtime', { teamId: 'team', revision: 6, document, catalog }, 'developer-1')
  const call = async () => {
    const response = await fetch(env.GOOEYPI_TEAM_DEVELOPMENT_URL!, { method: 'POST', headers: { authorization: `Bearer ${env.GOOEYPI_TEAM_DEVELOPMENT_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'update_team', params: {} }) })
    return response.json() as Promise<{ ok: boolean; error?: string }>
  }

  const oldResponse = await call()
  expect(oldResponse.ok).toBe(false)
  expect(oldResponse.error).toContain('无法确认当前草稿的模拟回执覆盖')
  expect(publishCalls).toHaveLength(0)

  remote.publication_readiness = { ready: true, workflows: [{ workflow_id: flow.id, required_capability_ids: [action.id], covered_capability_ids: [action.id], missing_capability_ids: [], passed: true }] }
  const covered = await call()
  expect(covered.ok).toBe(true)
  expect(publishCalls.map((command) => command.action)).toEqual(['publish'])
  expect(remote.published_revision).toBe(6)
})


it('keeps unsupported harnesses outside the development bridge', () => {
  bridge = new TeamDevelopmentAgentBridge({
    accountKey: async () => 'developer-1', developer: async () => ({ accountId: 'developer-1' }),
    teams: async () => [], team: async () => workspace(reviewTeam()), workspace: async () => ({}),
    catalog: async () => emptyCatalog, extensionPath: '/app/team-development.ts',
  })
  expect(() => bridge!.environmentFor({ cwd: '/work', harness: 'prime' })).toThrow('当前运行环境不支持团队开发')
})
