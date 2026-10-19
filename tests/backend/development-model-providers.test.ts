import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TeamDevelopmentAgentBridge } from '../../electron/main/development/agent-bridge'
import type { TeamWorkspaceCommand } from '../../src/types/team-workspace'

let bridge: TeamDevelopmentAgentBridge | undefined
let directory: string | undefined
afterEach(async () => { await bridge?.stop(); bridge = undefined; if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined })
const params = { provider: 'organization', name: 'Organization model', base_url: 'https://models.example.test/v1', models: ['model'] }
async function client(requestSecret: () => Promise<string | undefined>, accountKey = () => Promise.resolve('alice@org')) {
  directory = mkdtempSync(join(tmpdir(), 'development-model-test-'))
  const workspace = vi.fn(async (_command: TeamWorkspaceCommand) => ({ models: ['model'], providers: [{ id: 'organization', name: 'Organization model', models: ['model'] }] }))
  bridge = new TeamDevelopmentAgentBridge({ accountKey, developer: async () => ({ accountId: 'alice' }), teams: async () => [], team: async () => { throw new Error('unused') }, workspace, requestSecret, catalog: async () => ({ version: '1', provider: { id: 'forge', name: 'Forge', status: 'available' }, capabilities: [], refreshedAt: '' }), extensionPath: '/extension', storage: { directory } })
  await bridge.start()
  const env = bridge.environmentFor({ cwd: '/work', harness: 'pi', sessionPath: join(directory, 'session.jsonl') })
  bridge.bindRuntime(env.GOOEYPI_TEAM_DEVELOPMENT_TOKEN, 'runtime', join(directory, 'session.jsonl'))
  const call = async (method: string, arguments_: Record<string, unknown>) => {
    const response = await fetch(env.GOOEYPI_TEAM_DEVELOPMENT_URL!, { method: 'POST', headers: { authorization: `Bearer ${env.GOOEYPI_TEAM_DEVELOPMENT_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ method, params: arguments_ }) })
    return response.json() as Promise<{ ok: boolean; result?: unknown; error?: string }>
  }
  return { workspace, call }
}

it('uses only the app prompt key and excludes it from tool results and persisted session state', async () => {
  const prompt = vi.fn(async () => 'private-window-value')
  const { workspace, call } = await client(prompt)
  const result = await call('configure_model', { ...params, api_key: 'conversation-value' })
  expect(result.ok).toBe(true)
  expect(prompt).toHaveBeenCalledOnce()
  expect(workspace).toHaveBeenCalledWith(expect.objectContaining({ action: 'configure-model-provider', apiKey: 'private-window-value', accountId: 'alice' }))
  expect(JSON.stringify(result)).not.toMatch(/private-window-value|conversation-value/)
  for (const entry of readdirSync(directory!, { recursive: true, withFileTypes: true })) if (entry.isFile()) expect(readFileSync(join(entry.parentPath, entry.name), 'utf8')).not.toMatch(/private-window-value|conversation-value/)
})

it('does not submit when the prompt is cancelled, unavailable or expired', async () => {
  const { workspace, call } = await client(async () => undefined)
  expect((await call('configure_model', params)).ok).toBe(false)
  expect(workspace).not.toHaveBeenCalled()
})

it('retains the key without asking for or passing another secret', async () => {
  const prompt = vi.fn(async () => 'unused')
  const { workspace, call } = await client(prompt)
  expect((await call('configure_model', { ...params, keep_key: true })).ok).toBe(true)
  expect(prompt).not.toHaveBeenCalled()
  expect(workspace).toHaveBeenCalledWith(expect.objectContaining({ apiKey: undefined }))
})

it('rejects an answered prompt after the identity or runtime capability changes', async () => {
  let identity = 'alice@org', resolve!: (value: string) => void
  const prompt = vi.fn(() => new Promise<string>((yes) => { resolve = yes }))
  const { workspace, call } = await client(prompt, async () => identity)
  const pending = call('configure_model', params)
  await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce())
  identity = 'alice@other-org'
  bridge!.invalidateAccount()
  resolve('late-private-value')
  expect((await pending).ok).toBe(false)
  expect(workspace).not.toHaveBeenCalled()
})
