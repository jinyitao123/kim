import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TeamDevelopmentAgentBridge } from '../../electron/main/development/agent-bridge'
import { teamWorkspaceRequest } from '../../electron/main/enterprise/team-workspace'
import type { TeamWorkspaceCommand } from '../../src/types/team-workspace'

type Apply = Extract<TeamWorkspaceCommand, { action: 'workspace-apply' }>
type Window = {
  confirmOperation?: (question: { title: string; subject?: string; message: string }) => Promise<boolean>
  requestSecret?: (prompt: { title: string; label: string }) => Promise<string | undefined>
  revealSecrets?: (secret: { values: Array<{ label: string; value: string }> }) => boolean
}

let bridge: TeamDevelopmentAgentBridge | undefined
let directory: string | undefined
afterEach(async () => { await bridge?.stop(); bridge = undefined; if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined })

// weave answers the way the server does: what an operation still needs, then its outcome.
async function client(weave: (command: Apply) => unknown, window: Window = {}, accountKey = () => Promise.resolve('alice@org')) {
  // A test that needs a second client starts over with a clean bridge and directory.
  await bridge?.stop()
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = mkdtempSync(join(tmpdir(), 'workspace-operations-test-'))
  const sent: Apply[] = []
  const workspace = vi.fn(async (command: TeamWorkspaceCommand) => {
    if (command.action !== 'workspace-apply') return { topics: [{ topic: 'node' }] }
    sent.push(structuredClone(command))
    return weave(command)
  })
  bridge = new TeamDevelopmentAgentBridge({ accountKey, developer: async () => ({ accountId: 'alice' }), teams: async () => [], team: async () => { throw new Error('unused') }, workspace, ...window, catalog: async () => ({ version: '1', provider: { id: 'forge', name: 'Forge', status: 'available' }, capabilities: [], refreshedAt: '' }), extensionPath: '/extension', storage: { directory } })
  await bridge.start()
  const env = bridge.environmentFor({ cwd: '/work', harness: 'pi', sessionPath: join(directory, 'session.jsonl') })
  bridge.bindRuntime(env.GOOEYPI_TEAM_DEVELOPMENT_TOKEN, 'runtime', join(directory, 'session.jsonl'))
  const call = async (method: string, arguments_: Record<string, unknown>) => {
    const response = await fetch(env.GOOEYPI_TEAM_DEVELOPMENT_URL!, { method: 'POST', headers: { authorization: `Bearer ${env.GOOEYPI_TEAM_DEVELOPMENT_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ method, params: arguments_ }) })
    return response.json() as Promise<{ ok: boolean; result?: { status?: string; result?: unknown; message?: string }; error?: string }>
  }
  return { workspace, sent, call }
}
const archive = { kind: 'team_archive', team: '线索跟进团队' }
const asksFirst = (command: Apply) => command.confirmed ? { status: 'done', result: { archived: true } } : { status: 'confirmation_required', title: '归档团队', subject: '线索跟进团队', message: '归档后不再接新的工作。' }

it('reads the catalog from Weave and carries out an operation that needs nothing more', async () => {
  const { workspace, sent, call } = await client(() => ({ status: 'done', result: { nodes: [] } }))
  expect((await call('workspace_guide', { topic: 'node' })).ok).toBe(true)
  expect(workspace).toHaveBeenCalledWith({ action: 'workspace-guide', accountId: 'alice', topic: 'node' })
  const listed = await call('workspace_apply', { operation: { kind: 'node_list' } })
  expect(listed.result).toEqual({ status: 'done', result: { nodes: [] } })
  expect(sent).toEqual([expect.objectContaining({ operation: { kind: 'node_list' }, confirmed: false, forgeSession: false })])
  expect((await call('workspace_apply', { operation: 'node_list' })).ok).toBe(false)
})

it('asks the person at the window before what cannot be taken back, and a model cannot answer for them', async () => {
  const confirmOperation = vi.fn(async () => true)
  const { sent, call } = await client(asksFirst, { confirmOperation })
  const done = await call('workspace_apply', { operation: archive, confirmed: true })
  expect(done.result).toEqual({ status: 'done', result: { archived: true } })
  expect(confirmOperation).toHaveBeenCalledExactlyOnceWith({ title: '归档团队', subject: '线索跟进团队', message: '归档后不再接新的工作。' })
  // The first request went out unconfirmed whatever the tool call claimed.
  expect(sent.map((command) => command.confirmed)).toEqual([false, true])
})

it('does nothing when the person declines or no window can ask', async () => {
  for (const window of [{ confirmOperation: async () => false }, {}]) {
    const { sent, call } = await client(asksFirst, window)
    const declined = await call('workspace_apply', { operation: archive })
    expect(declined.result?.status).toBe('declined')
    expect(sent.map((command) => command.confirmed)).toEqual([false])
  }
})

it('drops a yes that arrives after the account or session changed', async () => {
  let identity = 'alice@org', resolve!: (value: boolean) => void
  const confirmOperation = vi.fn(() => new Promise<boolean>((yes) => { resolve = yes }))
  const { sent, call } = await client(asksFirst, { confirmOperation }, async () => identity)
  const pending = call('workspace_apply', { operation: archive })
  await vi.waitFor(() => expect(confirmOperation).toHaveBeenCalledOnce())
  identity = 'alice@other-org'
  bridge!.invalidateAccount()
  resolve(true)
  expect((await pending).ok).toBe(false)
  expect(sent).toHaveLength(1)
})

it('takes a secret from the window only, and keeps it out of the result and the session record', async () => {
  const requestSecret = vi.fn(async () => 'private-window-value')
  const save = { kind: 'repository_save', name: '订单服务', enter: ['git_token'], git_token: 'conversation-value' }
  const { sent, call } = await client((command) => command.secrets?.git_token ? { status: 'done', result: { name: '订单服务', has_access_token: true } } : { status: 'needs_input', secrets: [{ field: 'git_token', label: '代码仓库的访问令牌' }], forge_session: false }, { requestSecret })
  const saved = await call('workspace_apply', { operation: save, secrets: { git_token: 'conversation-value' } })
  expect(saved.result?.status).toBe('done')
  expect(requestSecret).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ label: '代码仓库的访问令牌' }))
  expect(sent.map((command) => command.secrets)).toEqual([{}, { git_token: 'private-window-value' }])
  expect(JSON.stringify(saved)).not.toContain('private-window-value')
  for (const entry of readdirSync(directory!, { recursive: true, withFileTypes: true })) if (entry.isFile()) expect(readFileSync(join(entry.parentPath, entry.name), 'utf8')).not.toContain('private-window-value')
})

it('does not submit when a secret is not filled in', async () => {
  const { sent, call } = await client(() => ({ status: 'needs_input', secrets: [{ field: 'app_secret', label: '飞书应用密钥' }, { field: 'verification_token', label: '飞书事件校验令牌' }] }), { requestSecret: async (prompt) => prompt.label === '飞书应用密钥' ? 'first' : undefined })
  const declined = await call('workspace_apply', { operation: { kind: 'feishu_save', enter: ['app_secret', 'verification_token'] } })
  expect(declined.result?.status).toBe('declined')
  expect(JSON.stringify(declined)).not.toContain('first')
  expect(sent).toHaveLength(1)
})

it('supplies the Forge sign-in when Weave asks for it, once', async () => {
  const { sent, call } = await client((command) => command.forgeSession ? { status: 'done', result: { refreshed: true } } : { status: 'needs_input', secrets: [], forge_session: true })
  expect((await call('workspace_apply', { operation: { kind: 'catalog_refresh' } })).result?.status).toBe('done')
  expect(sent.map((command) => command.forgeSession)).toEqual([false, true])
  const refused = await client(() => ({ status: 'needs_input', secrets: [], forge_session: true }))
  expect((await refused.call('workspace_apply', { operation: { kind: 'catalog_refresh' } })).ok).toBe(false)
  expect(refused.sent).toHaveLength(2)
})

it('hands a secret the operation produced to the window and never to the conversation', async () => {
  const reveal = [{ label: '接入令牌', value: 'private-node-token' }]
  const revealSecrets = vi.fn(() => true)
  const shown = await client(() => ({ status: 'done', result: { added: '研发一号机' }, reveal }), { revealSecrets })
  const added = await shown.call('workspace_apply', { operation: { kind: 'node_add', name: '研发一号机' } })
  expect(revealSecrets).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ values: reveal }))
  expect(added.result).toMatchObject({ status: 'done', result: { added: '研发一号机' } })
  expect(JSON.stringify(added)).not.toContain('private-node-token')
  for (const entry of readdirSync(directory!, { recursive: true, withFileTypes: true })) if (entry.isFile()) expect(readFileSync(join(entry.parentPath, entry.name), 'utf8')).not.toContain('private-node-token')
  // With no window to show it the secret is lost, and the result says so instead of carrying it.
  const hidden = await client(() => ({ status: 'done', result: { added: '研发一号机' }, reveal }), {})
  const lost = await hidden.call('workspace_apply', { operation: { kind: 'node_add', name: '研发一号机' } })
  expect(lost.result?.message).toContain('没能显示')
  expect(JSON.stringify(lost)).not.toContain('private-node-token')
})

it('sends the operation as an interactive caller and adds the Forge session only when asked', async () => {
  const write = vi.fn(async (_path: string, _method: string, body?: unknown) => ({ body }))
  const read = vi.fn(async (path: string) => path)
  const forge = () => 'forge-session'
  expect(await teamWorkspaceRequest({ action: 'workspace-guide' }, read, write, forge)).toBe('/v1/development/workspace-operations')
  expect(await teamWorkspaceRequest({ action: 'workspace-guide', topic: 'node' }, read, write, forge)).toBe('/v1/development/workspace-operations/node')
  expect(await teamWorkspaceRequest({ action: 'workspace-apply', operation: { kind: 'node_list' } }, read, write, forge)).toEqual({ operation: { kind: 'node_list' }, confirmed: false, interactive: true })
  expect(await teamWorkspaceRequest({ action: 'workspace-apply', operation: { kind: 'catalog_refresh' }, confirmed: true, secrets: { git_token: 'value' }, forgeSession: true }, read, write, forge))
    .toEqual({ operation: { kind: 'catalog_refresh' }, confirmed: true, interactive: true, secrets: { git_token: 'value' }, forge_token: 'forge-session' })
  expect(write).toHaveBeenCalledWith('/v1/development/workspace-operations', 'POST', expect.anything())
})
