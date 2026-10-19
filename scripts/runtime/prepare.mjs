import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  assertHash, assertLoomSource, buildLoom, buildRoot, desktopRoot, entries, fileHash, inventory, isolatedEnv, launcher,
  loomBinaryName, withoutLoom, manifestName, outputRoot, parseArgs, pruneSourceMaps, readLock, run, runtimeSource, sha256,
  stableJson, targetPin, verifyTree,
} from './lib.mjs'

/**
 * Places the Loom executable in the runtime: a prebuilt --loom-binary, or a
 * build from --loom-source / LOOM_SOURCE_DIR (a clean checkout at the locked
 * commit), or from the locked commit's source archive. The repository is
 * private: with LOOM_READ_TOKEN set the archive comes from the GitHub API
 * with that token, which never appears on a command line.
 */
async function addLoom(lock, bin, stage, cache, options, env) {
  const output = path.join(bin, loomBinaryName(options.platform))
  if (options['loom-binary']) {
    await fs.copyFile(path.resolve(options['loom-binary']), output)
    if (options.platform !== 'win32') await fs.chmod(output, 0o755)
  } else {
    let source = options['loom-source'] ?? process.env.LOOM_SOURCE_DIR
    if (source) await assertLoomSource(lock, path.resolve(source), process.env)
    else {
      const { repository, commit } = lock.loom
      const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)$/.exec(repository)
      if (!match) throw new Error('Loom repository must be a GitHub https URL')
      const archive = path.join(cache, `loom-${commit}.tar.gz`)
      if (!(await fs.stat(archive).catch(() => null))) {
        console.log(`Fetching Loom source at ${commit.slice(0, 12)}`)
        const token = process.env.LOOM_READ_TOKEN
        if (token) await fetchLoomArchive(`https://api.github.com/repos/${match[1]}/${match[2]}/tarball/${commit}`, token, `${archive}.partial`)
        else await run(process.platform === 'win32' ? 'curl.exe' : 'curl', ['--fail', '--location', '--proto', '=https', '--tlsv1.2', '--retry', '2', '--silent', '--show-error', '--output', `${archive}.partial`, `https://codeload.github.com/${match[1]}/${match[2]}/tar.gz/${commit}`], { env, timeoutMs: 600_000 })
        await fs.rename(`${archive}.partial`, archive)
      }
      const extracted = path.join(stage, 'loom-source')
      await fs.mkdir(extracted)
      await run('tar', ['-xzf', archive, '-C', extracted], { env, timeoutMs: 120_000 })
      // The public archive unpacks to <repo>-<commit>, the API one to
      // <owner>-<repo>-<short commit>; either way it is the only directory.
      const tops = (await fs.readdir(extracted, { withFileTypes: true })).filter((entry) => entry.isDirectory())
      if (tops.length !== 1) throw new Error('Unexpected Loom source archive layout')
      source = path.join(extracted, tops[0].name)
    }
    console.log(`Building Loom ${lock.loom.commit.slice(0, 12)} for ${options.platform}-${options.arch}`)
    await buildLoom(lock, path.resolve(source), output, { platform: options.platform, arch: options.arch, env })
  }
  return { commit: lock.loom.commit, goVersion: lock.loom.goVersion, sha256: await fileHash(output) }
}

/** Downloads a private repository archive; redirects drop the token. */
async function fetchLoomArchive(url, token, destination) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    redirect: 'follow',
    signal: AbortSignal.timeout(600_000),
  })
  if (!response.ok) throw new Error(`Loom source download failed: HTTP ${response.status}`)
  await fs.writeFile(destination, Buffer.from(await response.arrayBuffer()))
}

async function download(url, destination, expected, env) {
  try { await assertHash(destination, expected); return } catch { /* absent or incomplete cache */ }
  const partial = `${destination}.partial`
  await fs.rm(partial, { force: true })
  await run(process.platform === 'win32' ? 'curl.exe' : 'curl', [
    '--fail', '--location', '--proto', '=https', '--tlsv1.2', '--retry', '2',
    '--connect-timeout', '30', '--max-time', '600', '--silent', '--show-error',
    '--output', partial, url,
  ], { env, timeoutMs: 1_830_000 })
  await assertHash(partial, expected)
  await fs.rename(partial, destination)
}

export async function prepare(options) {
  const { lock, lockSha256 } = await readLock()
  const { platform, arch } = options
  const { target, pin } = targetPin(lock, platform, arch)
  const allowLoomOmission = withoutLoom(options)
  const destination = outputRoot(platform, arch)
  if (!options.rebuild) {
    try {
      await fs.access(destination)
    } catch { /* no previous output */ }
    if (await fs.stat(destination).catch(() => null)) {
      await verifyTree(destination, { lock, lockSha256, platform, arch, allowLoomOmission })
      console.log(`Runtime already verified: ${target}`)
      return destination
    }
  }
  const stageParent = path.join(buildRoot, 'runtime-stage')
  await fs.mkdir(stageParent, { recursive: true })
  const stage = await fs.mkdtemp(path.join(stageParent, `${target}-`))
  try {
    const env = await isolatedEnv(path.join(stage, 'profile'))
    // A shared download cache contains public archives only. npm user config is
    // kept in this build's private staging directory and never taken from HOME.
    const cache = path.join(buildRoot, 'runtime-cache')
    await fs.mkdir(cache, { recursive: true })
    env.NPM_CONFIG_CACHE = path.join(cache, 'npm')
    const archive = options['node-archive'] ? path.resolve(options['node-archive']) : path.join(cache, pin.file)
    if (options['node-archive']) await assertHash(archive, pin.sha256)
    else {
      const sums = path.join(cache, `node-v${lock.node.version}-SHASUMS256.txt`)
      await download(`${lock.node.baseUrl}/SHASUMS256.txt`, sums, lock.node.shasumsSha256, env)
      const rows = (await fs.readFile(sums, 'utf8')).split(/\r?\n/)
      if (!rows.some(row => row === `${pin.sha256}  ${pin.file}`)) throw new Error('Node archive is absent from the pinned official checksum list')
      console.log(`Fetching verified Node distribution: ${target}`)
      await download(`${lock.node.baseUrl}/${pin.file}`, archive, pin.sha256, env)
    }
    const extracted = path.join(stage, 'node')
    await fs.mkdir(extracted)
    await run('tar', ['-xf', archive, '-C', extracted], { env, timeoutMs: 120_000 })
    const nodeDirectory = path.join(extracted, pin.directory)
    const runtime = path.join(stage, 'runtime')
    const bin = path.join(runtime, 'bin')
    await fs.mkdir(bin, { recursive: true })
    const nodeName = platform === 'win32' ? 'node.exe' : 'node'
    await fs.copyFile(path.join(nodeDirectory, platform === 'win32' ? nodeName : `bin/${nodeName}`), path.join(bin, nodeName))
    if (platform !== 'win32') await fs.chmod(path.join(bin, nodeName), 0o755)
    await fs.copyFile(path.join(nodeDirectory, 'LICENSE'), path.join(runtime, 'NODE-LICENSE'))

    // Bootstrap npm from the same reviewed tarball shipped in the package.
    const npm = path.join(stage, 'bootstrap-npm')
    await fs.mkdir(npm)
    await run('tar', ['-xf', path.join(desktopRoot, 'vendor', lock.npmVendor), '-C', npm], { env })
    const install = path.join(stage, 'install')
    await fs.mkdir(path.join(install, 'vendor'), { recursive: true })
    for (const file of ['package.json', 'package-lock.json']) await fs.copyFile(path.join(runtimeSource, file), path.join(install, file))
    for (const name of Object.keys(lock.vendors)) await fs.copyFile(path.join(desktopRoot, 'vendor', name), path.join(install, 'vendor', name))
    console.log(`Installing locked runtime closure: ${target}`)
    await run(process.execPath, [path.join(npm, 'package/bin/npm-cli.js'), 'ci',
      '--ignore-scripts', '--omit=dev', '--include=optional', '--bin-links=false',
      '--no-audit', '--no-fund', `--os=${platform}`, `--cpu=${arch}`,
    ], { cwd: install, env, timeoutMs: 1_200_000 })
    await fs.rename(path.join(install, 'node_modules'), path.join(bin, 'node_modules'))
    for (const name of Object.keys(entries)) {
      const file = path.join(bin, platform === 'win32' ? `${name}.cmd` : name)
      await fs.writeFile(file, launcher(name, platform), { mode: 0o755 })
    }
    const omitLoom = Boolean(lock.loom) && allowLoomOmission
    if (omitLoom) console.log('Preparing the runtime without Loom')
    const loom = lock.loom && !omitLoom ? await addLoom(lock, bin, stage, cache, options, env) : undefined
    const pruning = await pruneSourceMaps(runtime)
    const files = await inventory(runtime)
    const manifest = {
      schemaVersion: 1, target, runtimeLockSha256: lockSha256,
      nodeVersion: lock.node.version, nodeArchiveSha256: pin.sha256,
      npmLockSha256: lock.closure.lockSha256,
      packages: lock.packages, ...(loom ? { loom } : {}), ...(omitLoom ? { loomOmitted: true } : {}), pruning, filesSha256: sha256(stableJson(files)), files,
    }
    await fs.writeFile(path.join(runtime, manifestName), stableJson(manifest))
    await verifyTree(runtime, { lock, lockSha256, platform, arch, allowLoomOmission })
    await fs.mkdir(path.dirname(destination), { recursive: true })
    // Only this script's fixed, ignored output can be replaced. --root is a
    // read-only verifier option, never an arbitrary deletion destination.
    await fs.rm(destination, { recursive: true, force: true })
    await fs.rename(runtime, destination)
    console.log(`Runtime prepared and verified: ${target} (${files.length} files; removed ${pruning.files} debug maps or empty Git placeholders / ${pruning.bytes} bytes)`)
    return destination
  } finally { await fs.rm(stage, { recursive: true, force: true }) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2), ['node-archive', 'rebuild', 'loom-source', 'loom-binary', 'without-loom'])
    if (options.help) console.log('prepare.mjs [--platform darwin|linux|win32] [--arch arm64|x64] [--node-archive FILE] [--loom-source DIR | --loom-binary FILE | --without-loom] [--rebuild]')
    else await prepare(options)
  } catch (error) { console.error(`Runtime preparation failed: ${error.message}`); process.exitCode = 1 }
}
