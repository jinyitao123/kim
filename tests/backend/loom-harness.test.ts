import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LOOM_CAPABILITY_MCP_CONFIG, LOOM_RPC_ADAPTER } from '../../electron/main/agent-rpc'
import type { HarnessStartArgsInput } from '../../electron/main/agent-rpc/harness-adapter'
import type { LoomModelConfig } from '../../electron/main/providers'
import { LoomModelCatalogService } from '../../electron/main/providers-loom'
import { runtimeProfile } from '../../electron/main/runtime-profiles'
import { loomSessionServiceOptions } from '../../electron/main/sessions/loom'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'loom-harness-'))
  dirs.push(dir)
  return dir
}

const baseInput: HarnessStartArgsInput = { cwd: '/work/project', environment: {} }

describe('Loom RPC adapter', () => {
  it('starts loom agent in rpc mode with an explicit working directory', () => {
    expect(LOOM_RPC_ADAPTER.buildStartArgs(baseInput)).toEqual(['agent', '--mode', 'rpc', '--cwd', '/work/project'])
    expect(LOOM_RPC_ADAPTER.spawnsInCwd).toBeFalsy()
    expect(LOOM_RPC_ADAPTER.buildServiceTierCommand).toBeUndefined()
  })

  it('passes the session, model, thinking level, computer-use skill and capability servers', () => {
    const args = LOOM_RPC_ADAPTER.buildStartArgs({
      ...baseInput,
      sessionPath: '/sessions/--work-project--/2026-10-17T00-00-00-000Z_abc.jsonl',
      providerId: 'deepseek', modelId: 'deepseek-chat', thinking: 'high',
      environment: {
        GOOEYPI_COMPUTER_USE_SKILL_PATH: '/skills/gooeypi-computer-use/SKILL.md',
        PRIME_WORK_SCHEDULE_SKILL_PATH: '/skills/prime-work-schedules',
        [LOOM_CAPABILITY_MCP_CONFIG]: '/runtime/mcp.json',
      },
    })
    expect(args).toEqual([
      'agent', '--mode', 'rpc', '--cwd', '/work/project',
      '--session', '/sessions/--work-project--/2026-10-17T00-00-00-000Z_abc.jsonl',
      '--provider', 'deepseek', '--model', 'deepseek-chat', '--thinking', 'high',
      '--skill', '/skills/gooeypi-computer-use/SKILL.md',
      '--mcp-config', '/runtime/mcp.json',
    ])
  })

  it('rejects option-like values and Prime daemon commands', () => {
    expect(() => LOOM_RPC_ADAPTER.buildStartArgs({ ...baseInput, modelId: '--resume' })).toThrow('Invalid model')
    expect(() => LOOM_RPC_ADAPTER.buildStartArgs({ ...baseInput, cwd: '--cwd' })).toThrow('Invalid working directory')
    expect(() => LOOM_RPC_ADAPTER.translateCommand({ type: 'send_message', targetActiveSessionId: 'x', message: 'hi' })).toThrow('not supported by the Loom harness')
    const prompt = { type: 'prompt', message: 'hi', streamingBehavior: 'steer' }
    expect(LOOM_RPC_ADAPTER.translateCommand(prompt)).toEqual(prompt)
  })
})

describe('Loom runtime profile and sessions', () => {
  it('points Loom at a private configuration and session directory', () => {
    const root = tempDir()
    const profile = runtimeProfile(root, 'loom', { DEEPSEEK_API_KEY: 'inherited', PATH: '/bin' })
    expect(profile.environment.LOOM_AGENT_DIR).toBe(profile.agentDir)
    expect(profile.environment.LOOM_SESSION_DIR).toBe(join(root, 'agent-sessions', 'accounts', 'signed-out', 'loom'))
    expect(profile.environment.DEEPSEEK_API_KEY).toBeUndefined()
  })

  it('reads Loom sessions with the bucketed version-3 layout', () => {
    const root = tempDir()
    const options = loomSessionServiceOptions(root)
    expect(options.harness).toBe('loom')
    expect(options.isSessionPathAuthorized?.(root, join(root, '--work-project--', '2026-10-17T01-02-03-004Z_0f0e.jsonl'))).toBe(true)
    expect(options.isSessionPathAuthorized?.(root, join(root, '2026-10-17T01-02-03-004Z_0f0e.jsonl'))).toBe(false)
    expect(options.catalogNameTimestamp?.('2026-10-17T01-02-03-004Z_0f0e.jsonl')).toBe(Date.parse('2026-10-17T01:02:03.004Z'))
  })
})

const modelConfig: LoomModelConfig = {
  models: { providers: { deepseek: { baseUrl: 'https://api.deepseek.com/v1', api: 'openai-completions', models: [
    { id: 'deepseek-chat', name: 'DeepSeek Chat', api: 'openai-completions', baseUrl: 'https://api.deepseek.com/v1', reasoning: false, input: ['text'], contextWindow: 128_000, maxTokens: 8_192, cost: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0 } },
    { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', api: 'openai-completions', baseUrl: 'https://api.deepseek.com/v1', reasoning: true, input: ['text'], contextWindow: 128_000, maxTokens: 32_768, cost: { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0 } },
  ] } } },
  auth: { deepseek: { type: 'api_key', key: 'private-fixture-key' } },
}

/** Fake loom: checks argv and the synced models.json, then answers the catalog probe from it. */
function fakeLoom(): string {
  const executable = join(tempDir(), 'fake-loom.cjs')
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path')
if (process.argv[2] === '--version') { process.stdout.write('loom 0.9.0\\n'); process.exit(0) }
if (process.argv.slice(2).join(' ') !== 'agent --mode rpc') process.exit(2)
const dir = process.env.LOOM_AGENT_DIR
const models = JSON.parse(fs.readFileSync(path.join(dir, 'models.json'), 'utf8'))
const auth = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'))
if (auth.deepseek.key !== 'private-fixture-key') process.exit(5)
let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk
  if (!buffer.includes('\\n')) return
  const request = JSON.parse(buffer.slice(0, buffer.indexOf('\\n')))
  if (request.type !== 'get_available_models') process.exit(3)
  const list = Object.entries(models.providers).flatMap(([provider, p]) => p.models.map((m) => ({ ...m, provider, api: p.api })))
  process.stdout.write(JSON.stringify({ type: 'response', id: request.id, command: 'get_available_models', success: true, data: { models: list } }) + '\\n')
})
`)
  chmodSync(executable, 0o755)
  return executable
}

describe('Loom model catalog', () => {
  it('writes private model and key files from the connected providers, then lists Loom models', async () => {
    const root = tempDir()
    const profile = runtimeProfile(root, 'loom')
    const service = new LoomModelCatalogService(fakeLoom(), { environment: profile.environment, agentDir: profile.agentDir, modelConfig: async () => modelConfig })
    const catalog = await service.catalog(true)

    expect(catalog.warning).toBeUndefined()
    expect(catalog.primeVersion).toBe('0.9.0')
    expect(catalog.models.map((model) => model.key)).toEqual(['deepseek/deepseek-chat', 'deepseek/deepseek-reasoner'])
    expect(catalog.models[0].availableThinkingLevels).toEqual(['off'])
    expect(catalog.models[1].availableThinkingLevels).toEqual(['off', 'minimal', 'low', 'medium', 'high'])
    const authPath = join(profile.agentDir, 'auth.json')
    expect(JSON.parse(readFileSync(authPath, 'utf8'))).toEqual(modelConfig.auth)
    if (process.platform !== 'win32') expect(statSync(authPath).mode & 0o777).toBe(0o600)

    const written = statSync(authPath).mtimeMs
    await service.syncModelConfig()
    expect(statSync(authPath).mtimeMs).toBe(written)
  })

  it('reports a missing loom executable instead of a catalog', async () => {
    const service = new LoomModelCatalogService(null, { agentDir: tempDir(), modelConfig: async () => modelConfig })
    const catalog = await service.catalog(true)
    expect(catalog.models).toEqual([])
    expect(catalog.warning).toContain('Loom is not installed')
  })
})
