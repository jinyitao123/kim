import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  buildRoot, entries, isolatedEnv, loomBinaryName, outputRoot, parseArgs, readLock, run,
  runtimeSource, verifyTree, withoutLoom,
} from './lib.mjs'

function rpcCatalog(file, args, { cwd, env, extraArgs = ['--no-session', '--offline'] }) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args, '--mode', 'rpc', ...extraArgs], {
      cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
    let pending = '', bytes = 0, outcome, error, settled = false
    const stop = failure => {
      if (settled) return
      settled = true
      error = failure
      clearTimeout(timer)
      child.kill('SIGTERM')
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 2000)
      killTimer.unref()
    }
    const timer = setTimeout(() => stop(new Error('Offline RPC catalog timed out')), 30_000)
    child.once('error', failure => { clearTimeout(timer); reject(failure) })
    child.stdout.on('data', chunk => {
      bytes += chunk.length
      if (bytes > 8_000_000) return stop(new Error('Offline RPC output exceeded its bound'))
      pending += chunk.toString('utf8')
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        let value
        try { value = JSON.parse(line) } catch { continue }
        if (value?.id !== 'runtime-catalog' || value.type !== 'response' || value.command !== 'get_available_models') continue
        if (value.success !== true || !Array.isArray(value.data?.models)) return stop(new Error('Offline RPC did not return a valid model catalog'))
        outcome = value.data.models.length
        stop()
      }
    })
    child.stderr.on('data', chunk => {
      bytes += chunk.length
      if (bytes > 8_000_000) stop(new Error('Offline RPC output exceeded its bound'))
    })
    child.stdin.on('error', () => { /* child close determines outcome */ })
    child.once('close', () => {
      clearTimeout(timer)
      if (error) reject(error)
      else if (outcome === undefined) reject(new Error('Offline RPC exited before returning its catalog'))
      else resolve(outcome)
    })
    // Do not end stdin: these CLIs treat EOF as disconnect before processing.
    child.stdin.write(`${JSON.stringify({ id: 'runtime-catalog', type: 'get_available_models' })}\n`)
  })
}

export async function executeProbes(root, lock, platform, arch) {
  if (platform !== process.platform || arch !== process.arch) throw new Error('Execution verification requires a native target runner')
  const parent = path.join(buildRoot, 'runtime-probe')
  await fs.mkdir(parent, { recursive: true })
  const work = await fs.mkdtemp(path.join(parent, `${platform}-${arch}-`))
  // Stay outside a source checkout: both CLIs intentionally discover project
  // instructions by walking cwd ancestors. This probe has no project context.
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'weave-runtime-cwd-'))
  const log = path.join(work, 'guard.log')
  try {
    const bin = path.join(root, 'bin')
    const env = await isolatedEnv(path.join(work, 'profile'), bin)
    const node = path.join(bin, platform === 'win32' ? 'node.exe' : 'node')
    const guard = path.join(runtimeSource, 'probe-guard.cjs')
    Object.assign(env, {
      PI_CODING_AGENT_DIR: path.join(work, 'pi'),
      PRIME_AGENT_CODING_AGENT_DIR: path.join(work, 'prime'),
      WEAVE_DISABLE_SHARED_PRIME_AUTH: '1',
      // Pi's provider discovery otherwise probes the shared gcloud ADC path.
      GOOGLE_APPLICATION_CREDENTIALS: path.join(work, 'google', 'application_default_credentials.json'),
      AWS_SHARED_CREDENTIALS_FILE: path.join(work, 'aws', 'credentials'),
      AWS_CONFIG_FILE: path.join(work, 'aws', 'config'),
      AWS_EC2_METADATA_DISABLED: 'true',
      PI_OFFLINE: '1',
      WEAVE_RUNTIME_PROBE_LOG: log,
      WEAVE_RUNTIME_PROBE_WORK: work,
      WEAVE_RUNTIME_PROBE_SOURCE: runtimeSource,
      WEAVE_RUNTIME_PROBE_RUNTIME: root,
      NODE_OPTIONS: `--require=${JSON.stringify(guard)}`,
    })
    // Prove the guard intercepts before touching any shared file, then clear
    // only its own negative-control log. HOME/USERPROFILE are never rewritten.
    let denied = false
    try {
      await run(node, ['-e', 'require("node:fs").readFileSync(require("node:path").join(require("node:os").homedir(),".pi","agent","auth.json"))'], { cwd, env, quiet: true })
    } catch { denied = true }
    if (!denied || !(await fs.readFile(log, 'utf8')).includes('shared-config')) throw new Error('Runtime isolation guard negative control failed')
    await fs.writeFile(log, '')
    const invocation = name => platform === 'win32'
      ? { file: node, args: [path.join(bin, 'node_modules', entries[name])] }
      : { file: path.join(bin, name), args: [] }
    const version = await run(node, ['--version'], { cwd, env, quiet: true })
    if (version !== `v${lock.node.version}`) throw new Error('Bundled Node version mismatch')
    const versions = { node: version }
    for (const [name, packageName] of [['pi', '@earendil-works/pi-coding-agent'], ['prime-agent', 'prime-agent'], ['npm', 'npm']]) {
      env.WEAVE_RUNTIME_PROBE_LABEL = name
      const call = invocation(name)
      const result = await run(call.file, [...call.args, '--version'], { cwd, env, quiet: true, includeStderr: true, timeoutMs: 30_000 })
      if (result !== lock.packages[packageName].version) throw new Error(`Bundled ${name} version mismatch`)
      versions[name] = result
    }
    env.WEAVE_RUNTIME_PROBE_LABEL = 'pi'
    const pi = invocation('pi')
    const piModels = await rpcCatalog(pi.file, pi.args, { cwd, env })
    env.WEAVE_RUNTIME_PROBE_LABEL = 'prime-agent'
    const prime = JSON.parse(await run(node, [
      path.join(runtimeSource, 'probe-prime-catalog.mjs'), path.join(bin, 'node_modules/prime-agent'),
    ], { cwd, env, quiet: true, timeoutMs: 30_000 }))
    if (prime.mode !== 'public-sdk' || !Number.isSafeInteger(prime.models) || prime.models <= 0 || prime.available !== 0) throw new Error('Invalid Prime catalog probe result')
    if ((await fs.readFile(log, 'utf8')).trim()) throw new Error('Runtime probe attempted a shared-config, network, or subprocess operation')
    const catalogs = { pi: { mode: 'rpc', models: piModels }, prime }
    if (lock.loom) {
      // Loom is a native executable outside the Node guard; it reads only its
      // private configuration directory, empty here, so it lists no models.
      const loom = path.join(bin, loomBinaryName(platform))
      const loomEnv = { ...env, NODE_OPTIONS: undefined, LOOM_AGENT_DIR: path.join(work, 'loom'), LOOM_SESSION_DIR: path.join(work, 'loom-sessions') }
      const loomVersion = await run(loom, ['--version'], { cwd, env: loomEnv, quiet: true, timeoutMs: 30_000 })
      if (loomVersion !== `loom ${lock.loom.commit.slice(0, 12)}`) throw new Error('Bundled Loom version mismatch')
      versions.loom = loomVersion
      catalogs.loom = { mode: 'rpc', models: await rpcCatalog(loom, ['agent'], { cwd, env: loomEnv, extraArgs: [] }) }
    }
    return { versions, catalogs, sharedConfigurationAccess: 'guarded-none', modelRequest: false }
  } catch (error) {
    const violations = (await fs.readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)
    if (violations.length) throw new Error(`${error.message}; isolation guard: ${[...new Set(violations)].join(', ')}`)
    throw error
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
    await fs.rm(work, { recursive: true, force: true })
  }
}

export async function verify(options) {
  const { lock, lockSha256 } = await readLock()
  const root = options.root ? path.resolve(options.root) : outputRoot(options.platform, options.arch)
  const manifest = await verifyTree(root, {
    lock, lockSha256, platform: options.platform, arch: options.arch,
    expectedManifest: options['expected-manifest'],
    allowLoomOmission: withoutLoom(options),
  })
  let probes
  if (options.execute) probes = await executeProbes(root, manifest.loomOmitted ? { ...lock, loom: undefined } : lock, options.platform, options.arch)
  console.log(JSON.stringify({ ok: true, target: manifest.target, files: manifest.files.length, ...(probes ? { probes } : {}) }))
  return manifest
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2), ['root', 'expected-manifest', 'execute', 'without-loom'])
    if (options.help) console.log('verify.mjs [--platform PLATFORM] [--arch ARCH] [--root resources/runtime] [--expected-manifest FILE] [--execute] [--without-loom]')
    else await verify(options)
  } catch (error) { console.error(`Runtime verification failed: ${error.message}`); process.exitCode = 1 }
}
