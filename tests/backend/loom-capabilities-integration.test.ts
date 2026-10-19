import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TeamDevelopmentAgentBridge } from '../../electron/main/development/agent-bridge'
import { loomCapabilityExtensions } from '../../electron/main/loom-capability-extensions'
import { LoomCapabilityHost, type CapabilityExtension } from '../../electron/main/loom-capabilities'

/**
 * Drives a real `loom agent` against the capability host: a scripted model
 * calls ask_user (answered through extension_ui_response, as the desktop
 * does) and then a collaboration tool backed by a fake bridge; the turn's
 * prompt reaches the extensions before the first model request. Runs only when
 * LOOM_BINARY names a loom executable.
 */
const loomBinary = process.env.LOOM_BINARY

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)))
}

describe.runIf(loomBinary)('Loom with the capability host', () => {
  it('answers a questionnaire and calls a desktop bridge through MCP', async () => {
    const bridgeCalls: string[] = []
    const bridge = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => { body += chunk })
      request.on('end', () => {
        bridgeCalls.push((JSON.parse(body) as { method: string }).method)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true, result: { sessions: [{ title: 'Other work' }] } }))
      })
    })
    const bridgeUrl = await listen(bridge)
    cleanups.push(() => new Promise<void>((resolve) => bridge.close(() => resolve())))

    // A scripted OpenAI-compatible model: ask_user, then the session list, then an answer.
    let round = 0
    let teamLists = 0
    const toolsSeen: string[][] = []
    const model = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => { body += chunk })
      request.on('end', () => {
        const parsed = JSON.parse(body) as { tools?: Array<{ function: { name: string } }> }
        toolsSeen.push((parsed.tools ?? []).map((tool) => tool.function.name))
        round++
        const delta = round === 1
          ? { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ questions: [{ question: 'Which report?', options: ['Sales', 'Costs'] }] }) } }] }
          : round === 2
            ? { tool_calls: [{ index: 0, id: 'c2', type: 'function', function: { name: 'gooeypi_session_list', arguments: '{}' } }] }
            : round === 3
              ? { tool_calls: [{ index: 0, id: 'c3', type: 'function', function: { name: 'gooeypi_team_development_list', arguments: '{}' } }] }
              : { content: 'Done.' }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: round < 4 ? 'tool_calls' : 'stop' }] })}\n\n`)
        response.end('data: [DONE]\n\n')
      })
    })
    const modelUrl = await listen(model)
    cleanups.push(() => new Promise<void>((resolve) => model.close(() => resolve())))

    const root = mkdtempSync(join(tmpdir(), 'loom-capability-e2e-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { local: { baseUrl: `${modelUrl}/v1`, api: 'openai-completions', apiKey: 'x', models: [{ id: 'm' }] } } }))
    const host = new LoomCapabilityHost({ directory: join(root, 'capabilities') })
    await host.start()
    cleanups.push(() => host.stop())
    // Records each turn's prompt and how many model requests preceded it.
    const turns: Array<{ prompt: string; round: number }> = []
    const turnProbe: CapabilityExtension = {
      id: 'turn-probe',
      register: (pi) => { pi.on('before_agent_start', (event) => { turns.push({ prompt: event.prompt, round }) }) },
    }
    const development = new TeamDevelopmentAgentBridge({
      accountKey: async () => 'developer-proof', developer: async () => ({ accountId: 'developer-proof' }),
      teams: async () => { teamLists++; return [{ id: 'team-proof', name: 'Proof team' }] },
      team: async () => { throw new Error('unused') }, workspace: async () => { throw new Error('unused') },
      catalog: async () => ({ version: '1', provider: { id: 'forge', name: 'Forge', status: 'available' }, capabilities: [], refreshedAt: '' }),
      extensionPath: '/app/team-development.ts',
    })
    await development.start()
    cleanups.push(() => development.stop())
    const config = host.openRuntime([...loomCapabilityExtensions({ askUser: true }), turnProbe], {
      GOOEYPI_COLLABORATION_URL: `${bridgeUrl}/`, GOOEYPI_COLLABORATION_TOKEN: 'token',
      ...development.environmentFor({ cwd: root, harness: 'loom' }),
    })

    const child = spawn(loomBinary!, ['agent', '--mode', 'rpc', '--cwd', root, '--mcp-config', config], {
      env: { ...process.env, LOOM_AGENT_DIR: agentDir, LOOM_SESSION_DIR: join(root, 'sessions') },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    cleanups.push(() => { child.kill() })
    const events: Array<Record<string, unknown>> = []
    const settled = new Promise<void>((resolve, reject) => {
      let buffer = ''
      const timer = setTimeout(() => reject(new Error(`timed out; events: ${events.map((e) => e.type).join(',')}`)), 30_000)
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
          const line = buffer.slice(0, index)
          buffer = buffer.slice(index + 1)
          const event = JSON.parse(line) as Record<string, unknown>
          events.push(event)
          if (event.type === 'extension_ui_request') {
            // The questionnaire marker rides in the first option, as the desktop expects.
            const options = event.options as string[]
            expect(options[0]).toMatch(/^__prime_ask_user__/)
            child.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id: event.id, value: 'Costs' })}\n`)
          }
          if (event.type === 'agent_settled') { clearTimeout(timer); resolve() }
        }
      })
    })
    child.stdin.write(`${JSON.stringify({ id: '1', type: 'prompt', message: 'Show me the report' })}\n`)
    await settled

    expect(toolsSeen[0]).toEqual(expect.arrayContaining(['read', 'ask_user', 'gooeypi_session_list']))
    const results = events.filter((event) => event.type === 'tool_execution_end')
    expect(results.map((event) => event.toolName)).toEqual(['ask_user', 'gooeypi_session_list', 'gooeypi_team_development_list'])
    const askText = ((results[0].result as { content: Array<{ text: string }> }).content[0]).text
    expect(askText).toContain('Costs')
    expect(bridgeCalls).toEqual(['list'])
    expect(teamLists).toBe(1)
    expect(turns).toEqual([{ prompt: 'Show me the report', round: 0 }])
  }, 60_000)
})
