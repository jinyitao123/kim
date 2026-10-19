import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PACKAGE_SIZE_BUDGETS } from '../release/size-budgets.mjs'

/** @typedef {{version: string, integrity: string}} PackagePin
 * @typedef {{file: string, directory: string, sha256: string}} DistributionPin
 * @typedef {{schemaVersion: number, node: {version: string, baseUrl: string, shasumsSha256: string, distributions: Record<string, DistributionPin>}, npmVendor: string, packages: Record<string, PackagePin>, vendors: Record<string, {sha256: string, bytes: number}>, closure: {packageSha256: string, lockSha256: string}, loom?: {repository: string, commit: string, goVersion: string}}} RuntimeLock
 */

export const desktopRoot = fileURLToPath(new URL('../../', import.meta.url))
export const runtimeSource = path.join(desktopRoot, 'scripts/runtime')
export const buildRoot = path.join(desktopRoot, '.build')
export const manifestName = 'runtime-manifest.json'
export const sourceMapPolicy = 'json-source-map-v3-and-empty-gitkeep-v1'
export const entries = Object.freeze({
  pi: '@earendil-works/pi-coding-agent/dist/bundle/cli.js',
  'prime-agent': 'prime-agent/dist/bundle/cli.js',
  npm: 'npm/bin/npm-cli.js',
  npx: 'npm/bin/npx-cli.js',
})

export function parseArgs(argv, allowed = []) {
  const out = { platform: process.platform, arch: process.arch }
  const booleans = new Set(['execute', 'rebuild', 'without-loom', 'help'])
  const names = new Set(['platform', 'arch', ...allowed, 'help'])
  for (let i = 0; i < argv.length; i++) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i])
    if (!match || !names.has(match[1])) throw new Error(`Unknown runtime option: ${argv[i]}`)
    const key = match[1]
    if (Object.hasOwn(out, key) && key !== 'platform' && key !== 'arch') throw new Error(`Duplicate runtime option: ${key}`)
    if (booleans.has(key)) {
      if (match[2] !== undefined) throw new Error(`Option ${key} does not take a value`)
      out[key] = true
    } else {
      const value = match[2] ?? argv[++i]
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`)
      out[key] = value
    }
  }
  return out
}

export function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex') }
export async function fileHash(file) { return sha256(await fs.readFile(file)) }
export function stableJson(value) { return `${JSON.stringify(value, null, 2)}\n` }

export async function assertHash(file, expected, label = path.basename(file)) {
  if (!/^[0-9a-f]{64}$/.test(expected) || await fileHash(file) !== expected) {
    throw new Error(`SHA256 mismatch: ${label}`)
  }
}

export async function readLock() {
  const bytes = await fs.readFile(path.join(desktopRoot, 'runtime-lock.json'))
  /** @type {RuntimeLock} */
  const lock = JSON.parse(bytes.toString('utf8'))
  if (lock.schemaVersion !== 1) throw new Error('Unsupported runtime lock schema')
  await assertHash(path.join(runtimeSource, 'package.json'), lock.closure.packageSha256)
  await assertHash(path.join(runtimeSource, 'package-lock.json'), lock.closure.lockSha256)
  for (const [name, pin] of Object.entries(lock.vendors)) {
    if (path.basename(name) !== name) throw new Error('Invalid runtime vendor path')
    await assertHash(path.join(desktopRoot, 'vendor', name), pin.sha256, name)
  }
  const npmLock = JSON.parse(await fs.readFile(path.join(runtimeSource, 'package-lock.json'), 'utf8'))
  if (npmLock.lockfileVersion !== 3) throw new Error('Runtime requires npm lock v3')
  for (const [name, pkg] of Object.entries(npmLock.packages)) {
    if (!name) continue
    if (pkg.link) throw new Error(`Runtime lock cannot use workspace links: ${name}`)
    if (pkg.inBundle && !pkg.resolved) continue
    if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(pkg.integrity ?? '')) throw new Error(`Missing package SRI: ${name}`)
    const local = /^file:vendor\/([^/]+)$/.exec(pkg.resolved ?? '')
    if (local) {
      if (!lock.vendors[local[1]]) throw new Error(`Unpinned vendor: ${name}`)
    } else if (!String(pkg.resolved).startsWith('https://registry.npmjs.org/')) {
      throw new Error(`Unexpected package source: ${name}`)
    }
  }
  return { lock, lockSha256: sha256(bytes), npmLock }
}

export function loomBinaryName(platform) { return platform === 'win32' ? 'loom.exe' : 'loom' }

/**
 * Whether a runtime is prepared without Loom: --without-loom, or
 * GOOEYPI_RUNTIME_WITHOUT_LOOM=1 for CI packaging that has no access to the
 * private Loom source. The manifest then records loomOmitted; public release
 * packaging refuses such a runtime.
 */
export function withoutLoom(options = {}, env = process.env) {
  return Boolean(options['without-loom']) || env.GOOEYPI_RUNTIME_WITHOUT_LOOM === '1'
}

/**
 * Builds the Loom executable for a target from a source tree at the locked
 * commit with the locked Go toolchain. -trimpath and an empty build id keep
 * the output reproducible for the same source and toolchain.
 */
export async function buildLoom(lock, sourceDir, output, { platform, arch, env }) {
  const pin = lock.loom
  const goarch = arch === 'x64' ? 'amd64' : arch
  const goos = platform === 'win32' ? 'windows' : platform
  // The Go build reads only public module sources; it uses the caller's PATH
  // and Go caches, never the isolated npm profile.
  const goEnv = { ...env, PATH: process.env.PATH, CGO_ENABLED: '0', GOOS: goos, GOARCH: goarch, GOTOOLCHAIN: 'local', GOFLAGS: '-mod=readonly' }
  for (const key of ['HOME', 'GOPATH', 'GOCACHE', 'GOMODCACHE', 'GOPROXY', 'LOCALAPPDATA', 'APPDATA']) if (process.env[key] && !goEnv[key]) goEnv[key] = process.env[key]
  const version = (await run('go', ['env', 'GOVERSION'], { cwd: sourceDir, env: goEnv })).trim()
  if (version !== pin.goVersion) throw new Error(`Loom must be built with ${pin.goVersion}, found ${version || 'no Go toolchain'}`)
  await run('go', ['build', '-trimpath', '-ldflags', `-s -w -buildid= -X main.version=${pin.commit.slice(0, 12)}`, '-o', output, './cmd/loom'], { cwd: sourceDir, env: goEnv, timeoutMs: 900_000 })
  if (platform !== 'win32') await fs.chmod(output, 0o755)
}

/** Confirms a Loom checkout sits exactly at the locked commit with no local changes. */
export async function assertLoomSource(lock, sourceDir, env) {
  const head = (await run('git', ['-C', sourceDir, 'rev-parse', 'HEAD'], { env })).trim()
  if (head !== lock.loom.commit) throw new Error(`Loom source is at ${head}, the lock pins ${lock.loom.commit}`)
  const dirty = (await run('git', ['-C', sourceDir, 'status', '--porcelain', '--untracked-files=no'], { env })).trim()
  if (dirty) throw new Error('Loom source has local changes')
}

export function targetPin(lock, platform, arch) {
  const target = `${platform}-${arch}`
  const pin = lock.node.distributions[target]
  if (!pin) throw new Error(`Unsupported runtime target: ${target}`)
  return { target, pin }
}

export function outputRoot(platform, arch) { return path.join(buildRoot, 'runtime', `${platform}-${arch}`) }

export function launcher(name, platform) {
  const entry = entries[name]
  if (!entry) throw new Error('Unknown runtime launcher')
  if (platform === 'win32') return `@echo off\r\nsetlocal\r\nset "PATH=%~dp0;%PATH%"\r\n"%~dp0node.exe" "%~dp0node_modules\\${entry.replaceAll('/', '\\')}" %*\r\nexit /b %errorlevel%\r\n`
  return `#!/bin/sh\nbasedir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1\nPATH="$basedir:$PATH"\nexport PATH\nexec "$basedir/node" "$basedir/node_modules/${entry}" "$@"\n`
}

// The child inherits no provider credentials, NODE_OPTIONS, npmrc location, or
// globally installed CLI PATH. HOME itself is preserved for normal OS behavior.
export async function isolatedEnv(work, bin = path.dirname(process.execPath)) {
  await fs.mkdir(work, { recursive: true })
  const userConfig = path.join(work, 'user.npmrc')
  const globalConfig = path.join(work, 'global.npmrc')
  await Promise.all([fs.writeFile(userConfig, ''), fs.writeFile(globalConfig, '')])
  const env = {}
  for (const key of ['HOME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  const systemPath = process.platform === 'win32'
    ? [path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'), process.env.SystemRoot ?? 'C:\\Windows']
    : ['/usr/bin', '/bin', '/usr/sbin', '/sbin']
  Object.assign(env, {
    PATH: [bin, ...systemPath].join(path.delimiter),
    NPM_CONFIG_USERCONFIG: userConfig,
    NPM_CONFIG_GLOBALCONFIG: globalConfig,
    NPM_CONFIG_CACHE: path.join(work, 'npm-cache'),
    NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',
    CI: 'true',
  })
  return env
}

/** @param {string} file
 * @param {string[]} args
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, maxBytes?: number, quiet?: boolean, includeStderr?: boolean}} [options]
 * @returns {Promise<string>}
 */
export function run(file, args, { cwd, env, timeoutMs = 120_000, maxBytes = 2_000_000, quiet = false, includeStderr = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', size = 0, expired = false
    const timer = setTimeout(() => { expired = true; child.kill('SIGKILL') }, timeoutMs)
    /** @type {[import('node:stream').Readable, (value: string) => void][]} */
    const streams = [[child.stdout, x => { stdout += x }], [child.stderr, x => { stderr += x }]]
    for (const [stream, collect] of streams) {
      stream.on('data', bytes => {
        size += bytes.length
        if (size > maxBytes) { expired = true; child.kill('SIGKILL'); return }
        collect(bytes.toString())
      })
    }
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => {
      clearTimeout(timer)
      if (expired || code !== 0) {
        // Build output contains only public package metadata. Probes suppress all
        // child output because an unexpected provider must never leak a secret.
        reject(new Error(`${path.basename(file)} ${expired ? 'exceeded its bound' : `exited ${code}`}${quiet ? '' : `\n${stderr.slice(-4000)}`}`))
      } else resolve((includeStderr ? stdout + stderr : stdout).trim())
    })
  })
}

function within(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

export async function inventory(root) {
  const rows = []
  const realRoot = await fs.realpath(root)
  async function visit(relative) {
    const directory = path.join(root, relative)
    const names = (await fs.readdir(directory)).sort()
    for (const name of names) {
      const item = path.join(relative, name)
      if (item === manifestName) continue
      const file = path.join(root, item)
      const stat = await fs.lstat(file)
      const key = item.split(path.sep).join('/')
      if (stat.isSymbolicLink()) {
        const target = await fs.readlink(file)
        if (path.isAbsolute(target) || !within(realRoot, await fs.realpath(file))) throw new Error(`Runtime symlink escapes package: ${key}`)
        rows.push({ path: key, type: 'symlink', target: target.split(path.sep).join('/') })
      } else if (stat.isDirectory()) await visit(item)
      else if (stat.isFile()) rows.push({ path: key, type: 'file', bytes: stat.size, sha256: await fileHash(file) })
      else throw new Error(`Unsupported runtime file: ${key}`)
    }
  }
  await visit('')
  return rows.sort((a, b) => a.path.localeCompare(b.path, 'en'))
}

/** Remove debug Source Map v3 and empty Git placeholders; retain other data. */
export async function pruneSourceMaps(root) {
  const removed = []
  for (const item of await inventory(root)) {
    if (item.type !== 'file') continue
    if (path.basename(item.path) === '.gitkeep' && item.bytes === 0) {
      await fs.unlink(path.join(root, item.path))
      removed.push(item)
      continue
    }
    if (!item.path.endsWith('.map')) continue
    const file = path.join(root, item.path)
    let value
    try { value = JSON.parse(await fs.readFile(file, 'utf8')) } catch { continue }
    if (value?.version !== 3 || !(Array.isArray(value.sources) && typeof value.mappings === 'string' || Array.isArray(value.sections))) continue
    await fs.unlink(file)
    removed.push(item)
  }
  return { policy: sourceMapPolicy, files: removed.length, bytes: removed.reduce((sum, item) => sum + (item.bytes ?? 0), 0), removedInventorySha256: sha256(stableJson(removed)) }
}

export async function binaryTarget(file) {
  const handle = await fs.open(file, 'r')
  try {
    const data = Buffer.alloc(4096)
    await handle.read(data, 0, data.length, 0)
    if (data.readUInt32LE(0) === 0xfeedfacf) {
      const cpu = data.readUInt32LE(4)
      return { platform: 'darwin', arch: cpu === 0x100000c ? 'arm64' : cpu === 0x1000007 ? 'x64' : 'unknown' }
    }
    if (data.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
      const cpu = data.readUInt16LE(18)
      return { platform: 'linux', arch: cpu === 183 ? 'arm64' : cpu === 62 ? 'x64' : 'unknown' }
    }
    if (data.subarray(0, 2).toString() === 'MZ') {
      const offset = data.readUInt32LE(60)
      const header = Buffer.alloc(6)
      await handle.read(header, 0, 6, offset)
      const cpu = header.readUInt16LE(4)
      if (header.readUInt32LE(0) !== 0x00004550) throw new Error('Invalid PE binary')
      return { platform: 'win32', arch: cpu === 0xaa64 ? 'arm64' : cpu === 0x8664 ? 'x64' : 'unknown' }
    }
    throw new Error('Unsupported runtime Node binary')
  } finally { await handle.close() }
}

/** @param {string} root
 * @param {{lock: RuntimeLock, lockSha256: string, platform: string, arch: string, expectedManifest?: string, allowLoomOmission?: boolean}} options
 */
export async function verifyTree(root, { lock, lockSha256, platform, arch, expectedManifest, allowLoomOmission = false }) {
  const { target, pin } = targetPin(lock, platform, arch)
  const bytes = await fs.readFile(path.join(root, manifestName))
  if (expectedManifest && !bytes.equals(await fs.readFile(expectedManifest))) throw new Error('Packaged runtime differs from prepared manifest')
  const manifest = JSON.parse(bytes.toString('utf8'))
  if (lock.loom && manifest.loomOmitted === true && !allowLoomOmission) throw new Error('Runtime omits required Loom; rebuild without --without-loom or GOOEYPI_RUNTIME_WITHOUT_LOOM')
  if (manifest.pruning?.policy !== sourceMapPolicy) throw new Error('Runtime pruning policy changed; rebuild the prepared runtime')
  if (manifest.schemaVersion !== 1 || manifest.target !== target || manifest.runtimeLockSha256 !== lockSha256 || manifest.nodeVersion !== lock.node.version || manifest.nodeArchiveSha256 !== pin.sha256 || manifest.npmLockSha256 !== lock.closure.lockSha256 || stableJson(manifest.packages) !== stableJson(lock.packages)) throw new Error('Runtime manifest source or target mismatch')
  const actual = await inventory(root)
  if (stableJson(actual) !== stableJson(manifest.files) || sha256(stableJson(actual)) !== manifest.filesSha256) throw new Error('Runtime file inventory mismatch (missing, added, or changed file)')
  const contentBytes = actual.reduce((sum, item) => sum + (item.type === 'file' ? (item.bytes ?? 0) : 0), bytes.length)
  if (contentBytes > PACKAGE_SIZE_BUDGETS.runtimeBytes) throw new Error(`Runtime exceeds its independent content budget: ${contentBytes} > ${PACKAGE_SIZE_BUDGETS.runtimeBytes}`)
  const node = path.join(root, 'bin', platform === 'win32' ? 'node.exe' : 'node')
  const binary = await binaryTarget(node)
  if (binary.platform !== platform || binary.arch !== arch) throw new Error('Runtime Node architecture mismatch')
  for (const [name, entry] of Object.entries(entries)) {
    const file = path.join(root, 'bin', platform === 'win32' ? `${name}.cmd` : name)
    if (await fs.readFile(file, 'utf8') !== launcher(name, platform)) throw new Error(`Runtime launcher mismatch: ${name}`)
    if (!(await fs.stat(path.join(root, 'bin/node_modules', entry))).isFile()) throw new Error(`Missing runtime CLI: ${name}`)
    if (platform !== 'win32' && !((await fs.stat(file)).mode & 0o111)) throw new Error(`Runtime launcher is not executable: ${name}`)
  }
  for (const [name, pin] of Object.entries(lock.packages)) {
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'bin/node_modules', name, 'package.json'), 'utf8'))
    if (pkg.version !== pin.version) throw new Error(`Runtime package version mismatch: ${name}`)
  }
  if (platform !== 'win32' && !((await fs.stat(node)).mode & 0o111)) throw new Error('Runtime Node is not executable')
  if (lock.loom && manifest.loomOmitted === true) {
    if (manifest.loom || await fs.stat(path.join(root, 'bin', loomBinaryName(platform))).catch(() => null)) throw new Error('Runtime prepared without Loom contains Loom')
  } else if (lock.loom) {
    const loom = path.join(root, 'bin', loomBinaryName(platform))
    if (manifest.loom?.commit !== lock.loom.commit || manifest.loom?.goVersion !== lock.loom.goVersion) throw new Error('Runtime Loom source mismatch')
    if (await fileHash(loom) !== manifest.loom.sha256) throw new Error('Runtime Loom executable changed')
    const loomBinary = await binaryTarget(loom)
    if (loomBinary.platform !== platform || loomBinary.arch !== arch) throw new Error('Runtime Loom architecture mismatch')
    if (platform !== 'win32' && !((await fs.stat(loom)).mode & 0o111)) throw new Error('Runtime Loom is not executable')
  }
  return manifest
}
