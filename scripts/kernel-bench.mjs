#!/usr/bin/env node
// Measures agent kernels (Pi, Prime, Loom) under the same conditions: a local
// OpenAI-compatible model server that answers instantly, so the numbers show
// kernel overhead rather than model or network latency.
//
//   node scripts/kernel-bench.mjs --runtime .build/runtime/darwin-arm64 [--harness pi,prime] [--runs 5] [--concurrency 5]
//   node scripts/kernel-bench.mjs --harness loom --loom /path/to/loom [--runs 5]
//
// Reported per kernel: time from spawn to the first get_state response, time
// from prompt to the first text delta and to agent_end, resident memory of
// the kernel process tree when idle and after one turn, and the same for
// --concurrency kernels started together. macOS and Linux only (uses ps).

import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const { values: options } = parseArgs({
  options: {
    runtime: { type: 'string' },
    loom: { type: 'string' },
    harness: { type: 'string', default: 'pi,prime' },
    runs: { type: 'string', default: '5' },
    concurrency: { type: 'string', default: '5' },
    json: { type: 'boolean', default: false },
  },
})
const runs = Number(options.runs)
const concurrency = Number(options.concurrency)
const MODEL = 'bench-model'
const PROVIDER = 'bench'
const TIMEOUT_MS = 60_000

function startModelServer() {
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      if (request.method === 'GET' && request.url?.endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model' }] }))
        return
      }
      const stream = (() => { try { return JSON.parse(body).stream === true } catch { return false } })()
      const base = { id: 'bench', object: 'chat.completion.chunk', created: 0, model: MODEL }
      if (!stream) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ id: 'bench', object: 'chat.completion', created: 0, model: MODEL, choices: [{ index: 0, message: { role: 'assistant', content: '好的。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const send = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`)
      send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
      for (const piece of ['好', '的', '。']) send({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      send({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })
      response.end('data: [DONE]\n\n')
    })
  })
  return new Promise((resolveServer) => server.listen(0, '127.0.0.1', () => resolveServer(server)))
}

function modelsConfig(port) {
  return {
    providers: {
      [PROVIDER]: {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        api: 'openai-completions',
        apiKey: 'bench',
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{ id: MODEL, name: 'Bench', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096 }],
      },
    },
  }
}

// Each kernel gets a private agent directory so user configuration never leaks in.
function prepareHarness(name, root, port) {
  const agentDir = join(root, name, 'agent')
  const sessions = join(root, name, 'sessions')
  const cwd = join(root, name, 'project')
  for (const dir of [agentDir, sessions, cwd]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify(modelsConfig(port), null, 2))
  const env = { ...process.env }
  if (name === 'pi') {
    if (!options.runtime) throw new Error('--runtime is required for pi')
    env.PI_CODING_AGENT_DIR = agentDir
    return { command: join(resolve(options.runtime), 'bin', 'pi'), args: ['--mode', 'rpc', '--session-dir', sessions, '--provider', PROVIDER, '--model', MODEL], env, cwd }
  }
  if (name === 'prime') {
    if (!options.runtime) throw new Error('--runtime is required for prime')
    Object.assign(env, { PRIME_AGENT_CODING_AGENT_DIR: agentDir, PRIME_AGENT_SESSION_DIR: sessions, PRIME_AGENT_CODING_AGENT_SESSION_DIR: sessions, WEAVE_DISABLE_SHARED_PRIME_AUTH: '1' })
    return { command: join(resolve(options.runtime), 'bin', 'prime-agent'), args: ['--mode', 'rpc', '--cwd', cwd, '--provider', PROVIDER, '--model', MODEL], env, cwd }
  }
  if (name === 'loom') {
    if (!options.loom) throw new Error('--loom is required for loom')
    Object.assign(env, { LOOM_AGENT_DIR: agentDir, LOOM_SESSION_DIR: sessions })
    return { command: resolve(options.loom), args: ['agent', '--mode', 'rpc', '--provider', PROVIDER, '--model', MODEL], env, cwd }
  }
  throw new Error(`unknown harness ${name}`)
}

// Strict JSONL reader: split on LF only, strip an optional CR.
class Kernel {
  constructor(spec) {
    this.started = performance.now()
    this.child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.buffer = ''
    this.waiters = []
    this.stderr = ''
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk
      for (let index = this.buffer.indexOf('\n'); index >= 0; index = this.buffer.indexOf('\n')) {
        const line = this.buffer.slice(0, index).replace(/\r$/, '')
        this.buffer = this.buffer.slice(index + 1)
        if (!line.trim()) continue
        let event
        try { event = JSON.parse(line) } catch { continue }
        const at = performance.now()
        const matched = this.waiters.filter((waiter) => waiter.match(event))
        this.waiters = this.waiters.filter((waiter) => !matched.includes(waiter))
        for (const waiter of matched) waiter.resolve(at)
      }
    })
    this.child.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk).slice(-4000) })
    this.exited = new Promise((resolveExit) => this.child.on('exit', (code, signal) => resolveExit({ code, signal })))
  }

  send(command) { this.child.stdin.write(`${JSON.stringify(command)}\n`) }

  waitFor(match, label) {
    return new Promise((resolveWait, rejectWait) => {
      const timer = setTimeout(() => rejectWait(new Error(`timed out waiting for ${label}; stderr: ${this.stderr.trim()}`)), TIMEOUT_MS)
      this.exited.then(({ code, signal }) => rejectWait(new Error(`kernel exited (${code ?? signal}) while waiting for ${label}; stderr: ${this.stderr.trim()}`)))
      this.waiters.push({ match, resolve: (at) => { clearTimeout(timer); resolveWait(at) } })
    })
  }

  async ready() {
    const waiting = this.waitFor((event) => event.type === 'response' && event.id === 'bench-state', 'get_state')
    this.send({ id: 'bench-state', type: 'get_state' })
    return (await waiting) - this.started
  }

  async turn() {
    const sent = performance.now()
    const firstText = this.waitFor((event) => event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta', 'first text delta')
    const end = this.waitFor((event) => event.type === 'agent_end', 'agent_end')
    this.send({ id: 'bench-prompt', type: 'prompt', message: '回复“好的”。' })
    return { firstText: (await firstText) - sent, end: (await end) - sent }
  }

  async stop() {
    this.child.stdin.end()
    this.child.kill('SIGTERM')
    await Promise.race([this.exited, new Promise((resolveWait) => setTimeout(resolveWait, 3000))])
    if (this.child.exitCode === null) this.child.kill('SIGKILL')
  }
}

function processTable() {
  return execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,time='], { encoding: 'utf8' })
    .trim().split('\n').map((line) => line.trim().split(/\s+/))
    .map(([pid, ppid, rss, time]) => ({ pid: Number(pid), ppid: Number(ppid), rss: Number(rss), cpu: cpuSeconds(time) }))
}

// Kernels that detach a daemon (Prime) leave it reparented to init; find such
// processes by their working directory inside the benchmark root.
function detachedPids(benchRoot) {
  const root = realpathSync(benchRoot)
  const kernelNames = new Set(['node', 'pi', 'prime-agent', 'loom'])
  // Only look up the working directory of kernel-named orphans; launchd alone has hundreds of children.
  const candidates = execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' }).trim().split('\n')
    .map((line) => line.trim().split(/\s+/)).filter(([, ppid, comm]) => ppid === '1' && kernelNames.has(comm.split('/').pop()))
    .map(([pid]) => Number(pid))
  return candidates.filter((pid) => {
    try {
      const cwd = execFileSync('lsof', ['-a', '-d', 'cwd', '-p', String(pid), '-Fn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split('\n').find((line) => line.startsWith('n'))?.slice(1)
      return Boolean(cwd && (cwd === root || cwd.startsWith(`${root}/`)))
    } catch { return false }
  })
}

function killDetached(benchRoot) {
  for (const pid of detachedPids(benchRoot)) { try { process.kill(pid, 'SIGKILL') } catch {} }
}

// Resident memory (KiB) and CPU seconds of the given processes and all their descendants.
function treeUsage(rootPids) {
  const table = processTable()
  const included = new Set(rootPids)
  let grew = true
  while (grew) {
    grew = false
    for (const row of table) if (!included.has(row.pid) && included.has(row.ppid)) { included.add(row.pid); grew = true }
  }
  const rows = table.filter((row) => included.has(row.pid))
  return { rssKiB: rows.reduce((sum, row) => sum + row.rss, 0), cpuSeconds: rows.reduce((sum, row) => sum + row.cpu, 0) }
}

function cpuSeconds(time) {
  const [clock, fraction = '0'] = time.split('.')
  const parts = clock.split(':').map(Number)
  const seconds = parts.reduce((total, part) => total * 60 + part, 0)
  return seconds + Number(`0.${fraction}`)
}

const median = (values) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)] }
const summary = (values) => ({ median: median(values), min: Math.min(...values), max: Math.max(...values) })

async function benchHarness(name, root, port) {
  mkdirSync(root, { recursive: true })
  try { return await measureHarness(name, root, port) } finally { killDetached(root) }
}

async function measureHarness(name, root, port) {
  const single = []
  for (let run = 0; run < runs; run += 1) {
    const kernel = new Kernel(prepareHarness(name, join(root, `run-${run}`), port))
    try {
      const ready = await kernel.ready()
      await new Promise((resolveWait) => setTimeout(resolveWait, 500))
      const idle = treeUsage([kernel.child.pid, ...detachedPids(root)])
      const turn = await kernel.turn()
      await new Promise((resolveWait) => setTimeout(resolveWait, 500))
      const after = treeUsage([kernel.child.pid, ...detachedPids(root)])
      single.push({ ready, firstText: turn.firstText, turn: turn.end, idleRssKiB: idle.rssKiB, afterTurnRssKiB: after.rssKiB, cpuSeconds: after.cpuSeconds })
    } finally {
      await kernel.stop()
      killDetached(root)
    }
  }

  const started = performance.now()
  const kernels = Array.from({ length: concurrency }, (_, index) => new Kernel(prepareHarness(name, join(root, `parallel-${index}`), port)))
  let parallel
  try {
    await Promise.all(kernels.map((kernel) => kernel.ready()))
    const allReady = performance.now() - started
    await Promise.all(kernels.map((kernel) => kernel.turn()))
    const allTurned = performance.now() - started
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
    const usage = treeUsage([...kernels.map((kernel) => kernel.child.pid), ...detachedPids(root)])
    parallel = { kernels: concurrency, allReady, allTurned, totalRssKiB: usage.rssKiB, totalCpuSeconds: usage.cpuSeconds }
  } finally {
    await Promise.all(kernels.map((kernel) => kernel.stop()))
  }

  const pick = (key) => summary(single.map((row) => row[key]))
  return {
    harness: name,
    runs,
    readyMs: pick('ready'),
    firstTextMs: pick('firstText'),
    turnMs: pick('turn'),
    idleRssKiB: pick('idleRssKiB'),
    afterTurnRssKiB: pick('afterTurnRssKiB'),
    cpuSecondsPerSession: pick('cpuSeconds'),
    parallel,
  }
}

const server = await startModelServer()
const port = server.address().port
const root = mkdtempSync(join(tmpdir(), 'kernel-bench-'))
const results = []
try {
  for (const name of options.harness.split(',').map((value) => value.trim()).filter(Boolean)) {
    try {
      results.push(await benchHarness(name, join(root, name), port))
    } catch (error) {
      results.push({ harness: name, error: error instanceof Error ? error.message : String(error) })
    }
  }
} finally {
  server.close()
  rmSync(root, { recursive: true, force: true })
}

if (options.json) {
  console.log(JSON.stringify({ platform: `${process.platform}-${process.arch}`, runs, concurrency, results }, null, 2))
} else {
  const ms = (value) => `${Math.round(value)} ms`
  const mib = (kib) => `${(kib / 1024).toFixed(1)} MiB`
  for (const result of results) {
    if (result.error) { console.log(`${result.harness}: failed — ${result.error}`); continue }
    console.log(`${result.harness} (${result.runs} runs, median [min–max])`)
    console.log(`  spawn → ready       ${ms(result.readyMs.median)} [${ms(result.readyMs.min)}–${ms(result.readyMs.max)}]`)
    console.log(`  prompt → first text ${ms(result.firstTextMs.median)} [${ms(result.firstTextMs.min)}–${ms(result.firstTextMs.max)}]`)
    console.log(`  prompt → agent_end  ${ms(result.turnMs.median)} [${ms(result.turnMs.min)}–${ms(result.turnMs.max)}]`)
    console.log(`  idle memory         ${mib(result.idleRssKiB.median)}`)
    console.log(`  memory after turn   ${mib(result.afterTurnRssKiB.median)}`)
    console.log(`  CPU per session     ${result.cpuSecondsPerSession.median.toFixed(2)} s`)
    console.log(`  ${result.parallel.kernels} together: all ready ${ms(result.parallel.allReady)}, all turned ${ms(result.parallel.allTurned)}, memory ${mib(result.parallel.totalRssKiB)}, CPU ${result.parallel.totalCpuSeconds.toFixed(2)} s`)
  }
}
