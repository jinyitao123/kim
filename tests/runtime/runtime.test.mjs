import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  assertHash, binaryTarget, entries, inventory, isolatedEnv, launcher, manifestName,
  parseArgs, pruneSourceMaps, readLock, run, runtimeSource, sha256, sourceMapPolicy, stableJson, targetPin, verifyTree, withoutLoom,
} from '../../scripts/runtime/lib.mjs'

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'weave-runtime-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const pin = 'a'.repeat(64)
  const lock = { node: { version: '24.19.0', distributions: { 'darwin-arm64': { sha256: pin } } }, closure: { lockSha256: pin }, packages: {} }
  const bin = path.join(root, 'bin')
  await fs.mkdir(bin)
  const macho = Buffer.alloc(64)
  macho.writeUInt32LE(0xfeedfacf)
  macho.writeUInt32LE(0x100000c, 4)
  await fs.writeFile(path.join(bin, 'node'), macho, { mode: 0o755 })
  for (const [name, entry] of Object.entries(entries)) {
    const file = path.join(bin, 'node_modules', entry)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '// test CLI\n')
    await fs.writeFile(path.join(bin, name), launcher(name, 'darwin'), { mode: 0o755 })
  }
  const options = { lock, lockSha256: pin, platform: 'darwin', arch: 'arm64' }
  const seal = async () => {
    const files = await inventory(root)
    await fs.writeFile(path.join(root, manifestName), stableJson({
      schemaVersion: 1, target: 'darwin-arm64', runtimeLockSha256: pin,
      nodeVersion: lock.node.version, nodeArchiveSha256: pin, npmLockSha256: pin,
      packages: {}, pruning: { policy: sourceMapPolicy }, filesSha256: sha256(stableJson(files)), files,
    }))
  }
  await seal()
  return { root, options, seal }
}

test('runtime source uses reviewed vendor bytes and npm SRI throughout its closure', async () => {
  const { lock, npmLock } = await readLock()
  assert.equal(npmLock.packages['node_modules/@earendil-works/pi-ai'].version, '0.84.3')
  assert.equal(npmLock.packages['node_modules/prime-agent/node_modules/@earendil-works/pi-ai'].version, '0.7.0-gooeypi.1')
  assert.equal(lock.packages['prime-agent'].version, '0.7.0-gooeypi.2')
  assert.equal(Object.keys(lock.node.distributions).length, 5)
})

test('Git checkout preserves pinned runtime JSON bytes with Windows autocrlf enabled', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'weave runtime git checkout-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const emptyConfig = path.join(root, 'empty-config')
  await fs.writeFile(emptyConfig, '')
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig }
  const git = args => run('git', ['-c', 'core.autocrlf=true', '-c', 'core.eol=crlf', '-c', `core.attributesFile=${emptyConfig}`, ...args], { cwd: root, env })
  const { lock } = await readLock()
  const files = { 'package.json': lock.closure.packageSha256, 'package-lock.json': lock.closure.lockSha256 }
  for (const name of Object.keys(files)) await fs.copyFile(path.join(runtimeSource, name), path.join(root, name))
  await git(['init', '--quiet'])
  await git(['add', '--', ...Object.keys(files)])
  await git(['checkout-index', '--all', '--prefix=without-attributes/'])
  for (const [name, digest] of Object.entries(files)) {
    const unchecked = path.join(root, 'without-attributes', name)
    assert.ok((await fs.readFile(unchecked)).includes(Buffer.from('\r\n')))
    await assert.rejects(assertHash(unchecked, digest), /SHA256 mismatch/)
  }

  await fs.copyFile(path.join(runtimeSource, '.gitattributes'), path.join(root, '.gitattributes'))
  await git(['add', '--', '.gitattributes'])
  await git(['checkout-index', '--all', '--prefix=with-attributes/'])
  for (const [name, digest] of Object.entries(files)) {
    const checked = path.join(root, 'with-attributes', name)
    await assertHash(checked, digest)
    assert.ok(!(await fs.readFile(checked)).includes(Buffer.from('\r\n')))
    await fs.appendFile(checked, ' ')
    await assert.rejects(assertHash(checked, digest), /SHA256 mismatch/)
  }
})

test('unknown CLI options and unsupported targets fail before preparation', () => {
  assert.throws(() => parseArgs(['--root', '/elsewhere']), /Unknown/)
  assert.throws(() => parseArgs(['--arch']), /Missing/)
  assert.throws(() => targetPin({ node: { distributions: {} } }, 'linux', '../outside'), /Unsupported/)
  assert.deepEqual(parseArgs(['--platform=win32', '--arch', 'x64']), { platform: 'win32', arch: 'x64' })
})

test('packaged closure detects deleted, changed and added files', async t => {
  for (const mutation of ['deleted', 'changed', 'added']) {
    await t.test(mutation, async sub => {
      const { root, options } = await fixture(sub)
      await verifyTree(root, options)
      const entry = path.join(root, 'bin/node_modules', entries.pi)
      if (mutation === 'deleted') await fs.unlink(entry)
      if (mutation === 'changed') await fs.appendFile(entry, 'tamper')
      if (mutation === 'added') await fs.writeFile(path.join(root, 'unexpected'), 'extra')
      await assert.rejects(verifyTree(root, options), /inventory mismatch/)
    })
  }
})

test('a runtime prepared without Loom must say so and contain no Loom', async t => {
  assert.equal(withoutLoom({}, {}), false)
  assert.equal(withoutLoom({ 'without-loom': true }, {}), true)
  assert.equal(withoutLoom({}, { GOOEYPI_RUNTIME_WITHOUT_LOOM: '1' }), true)
  const { root, options } = await fixture(t)
  const lock = { ...options.lock, loom: { repository: 'https://github.com/example/loom', commit: 'b'.repeat(40), goVersion: 'go1.26.1' } }
  const pin = options.lockSha256
  const sealWith = async (extra) => {
    await fs.rm(path.join(root, manifestName), { force: true })
    const files = await inventory(root)
    await fs.writeFile(path.join(root, manifestName), stableJson({
      schemaVersion: 1, target: 'darwin-arm64', runtimeLockSha256: pin,
      nodeVersion: lock.node.version, nodeArchiveSha256: pin, npmLockSha256: pin,
      packages: {}, ...extra, pruning: { policy: sourceMapPolicy }, filesSha256: sha256(stableJson(files)), files,
    }))
  }
  await sealWith({})
  await assert.rejects(verifyTree(root, { ...options, lock }), /Loom source mismatch/)
  await sealWith({ loomOmitted: true })
  await assert.rejects(verifyTree(root, { ...options, lock }), /required Loom/)
  await verifyTree(root, { ...options, lock, allowLoomOmission: true })
  await fs.writeFile(path.join(root, 'bin', 'loom'), 'binary', { mode: 0o755 })
  await sealWith({ loomOmitted: true })
  await assert.rejects(verifyTree(root, { ...options, lock, allowLoomOmission: true }), /without Loom contains Loom/)
})

test('packaged manifest must match the externally retained preparation proof', async t => {
  const { root, options, seal } = await fixture(t)
  const proof = `${root}.manifest`
  t.after(() => fs.rm(proof, { force: true }))
  await fs.copyFile(path.join(root, manifestName), proof)
  await fs.writeFile(path.join(root, 'extra'), 'tamper then reseal')
  await seal()
  await assert.rejects(verifyTree(root, { ...options, expectedManifest: proof }), /differs from prepared/)
})

test('escaping symlinks and the wrong Node architecture are rejected', async t => {
  const { root, options, seal } = await fixture(t)
  await fs.symlink('../outside', path.join(root, 'escape'))
  await assert.rejects(inventory(root))
  await fs.unlink(path.join(root, 'escape'))
  const file = path.join(root, 'bin/node')
  const data = await fs.readFile(file)
  data.writeUInt32LE(0x1000007, 4)
  await fs.writeFile(file, data)
  await seal()
  assert.deepEqual(await binaryTarget(file), { platform: 'darwin', arch: 'x64' })
  await assert.rejects(verifyTree(root, options), /architecture mismatch/)
})

test('build isolation preserves HOME without inheriting global CLIs or provider variables', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'weave-runtime-env-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const env = await isolatedEnv(root, path.join(root, 'bin'))
  assert.equal(env.HOME, process.env.HOME)
  assert.equal(env.USERPROFILE, process.env.USERPROFILE)
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.NODE_OPTIONS, undefined)
  assert.notEqual(env.NPM_CONFIG_USERCONFIG, env.NPM_CONFIG_GLOBALCONFIG)
  assert.equal(await fs.readFile(env.NPM_CONFIG_USERCONFIG, 'utf8'), '')
  assert.equal(env.PATH.split(path.delimiter)[0], path.join(root, 'bin'))
  assert.ok(!env.PATH.includes('homebrew'))
})

test('Windows wrappers require adjacent Node and match the public bundled JS entries', () => {
  for (const name of Object.keys(entries)) {
    const wrapper = launcher(name, 'win32')
    assert.match(wrapper, /"%~dp0node\.exe"/)
    assert.ok(wrapper.includes(entries[name].replaceAll('/', '\\')))
    assert.doesNotMatch(wrapper, /(?:^|\n)node(?: |\.exe)/)
    assert.doesNotMatch(wrapper, /(?:HOME|USERPROFILE)=/)
  }
})

test('platform validation reads Linux and Windows architecture from the actual executable', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'weave-runtime-arch-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'node')
  const elf = Buffer.alloc(64)
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(elf)
  elf.writeUInt16LE(183, 18)
  await fs.writeFile(file, elf)
  assert.deepEqual(await binaryTarget(file), { platform: 'linux', arch: 'arm64' })
  const pe = Buffer.alloc(512)
  pe.write('MZ')
  pe.writeUInt32LE(256, 60)
  pe.writeUInt32LE(0x00004550, 256)
  pe.writeUInt16LE(0x8664, 260)
  await fs.writeFile(file, pe)
  assert.deepEqual(await binaryTarget(file), { platform: 'win32', arch: 'x64' })
})

test('version metadata can use stderr without changing failure handling', async () => {
  assert.equal(await run(process.execPath, ['-e', 'process.stderr.write("0.7.0-test\\n")'], { includeStderr: true }), '0.7.0-test')
  await assert.rejects(run(process.execPath, ['-e', 'process.stderr.write("bad");process.exit(2)'], { includeStderr: true, quiet: true }), /exited 2/)
})


test('runtime pruning removes Source Map v3 and empty Git placeholders only', async t => {
  const { root } = await fixture(t)
  await fs.writeFile(path.join(root, 'debug.js.map'), JSON.stringify({ version: 3, sources: ['source.ts'], mappings: 'AAAA' }))
  await fs.writeFile(path.join(root, 'data.map'), 'runtime data, not a source map')
  await fs.writeFile(path.join(root, 'fake.map'), JSON.stringify({ version: 3, data: 'required' }))
  await fs.writeFile(path.join(root, 'entry.js'), 'export const value = 1')
  await fs.writeFile(path.join(root, 'entry.d.ts'), 'export declare const value: number')
  await fs.writeFile(path.join(root, '.gitkeep'), '')
  await fs.mkdir(path.join(root, 'nonempty'))
  await fs.writeFile(path.join(root, 'nonempty/.gitkeep'), 'retain this data')
  const result = await pruneSourceMaps(root)
  assert.equal(result.policy, sourceMapPolicy)
  assert.equal(result.files, 2)
  assert.ok(result.bytes > 0)
  await assert.rejects(fs.stat(path.join(root, 'debug.js.map')), { code: 'ENOENT' })
  await assert.rejects(fs.stat(path.join(root, '.gitkeep')), { code: 'ENOENT' })
  for (const file of ['nonempty/.gitkeep', 'data.map', 'fake.map', 'entry.js', 'entry.d.ts']) assert.ok((await fs.stat(path.join(root, file))).isFile())
})


test('probe guard logs inside a protected root without recursion and still denies shared files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'weave-guard-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, '.codex'))
  await fs.mkdir(path.join(root, '.pi', 'agent'), { recursive: true })
  const secret = path.join(root, '.pi', 'agent', 'auth.json')
  await fs.writeFile(secret, 'synthetic-credential-must-not-be-read')
  const log = path.join(root, '.codex', 'guard.log')
  const program = `require('node:os').homedir = () => process.env.PROBE_TEST_HOME;
    require(process.env.PROBE_GUARD);
    try { require('node:fs').readFileSync(${JSON.stringify(secret)}) } catch (error) {
      if (error.code === 'WEAVE_RUNTIME_PROBE_FORBIDDEN') process.exit(0);
      throw error;
    }
    process.exit(1);`
  await run(process.execPath, ['-e', program], { env: { ...process.env,
    PROBE_TEST_HOME: root, PROBE_GUARD: path.join(runtimeSource, 'probe-guard.cjs'), WEAVE_RUNTIME_PROBE_LOG: log,
  } })
  assert.match(await fs.readFile(log, 'utf8'), /control:shared-config/)
  assert.equal(await fs.readFile(secret, 'utf8'), 'synthetic-credential-must-not-be-read')
})

test('probe roots inside .codex stay readable without allowing sibling shared credentials', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'weave-guard-roots-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const work = path.join(root, '.codex', 'probe')
  await fs.mkdir(work, { recursive: true })
  await fs.writeFile(path.join(work, 'models.json'), '{}')
  const secret = path.join(root, '.codex', 'auth.json')
  await fs.writeFile(secret, 'synthetic-credential-must-not-be-read')
  const log = path.join(work, 'guard.log')
  const program = `require('node:os').homedir = () => process.env.PROBE_TEST_HOME;
    require(process.env.PROBE_GUARD);
    const fs = require('node:fs');
    if (fs.readFileSync(${JSON.stringify(path.join(work, 'models.json'))}, 'utf8') !== '{}') process.exit(2);
    try { fs.readFileSync(${JSON.stringify(secret)}) } catch (error) {
      if (error.code === 'WEAVE_RUNTIME_PROBE_FORBIDDEN') process.exit(0);
      throw error;
    }
    process.exit(1);`
  await run(process.execPath, ['-e', program], { env: { ...process.env,
    PROBE_TEST_HOME: root, PROBE_GUARD: path.join(runtimeSource, 'probe-guard.cjs'),
    WEAVE_RUNTIME_PROBE_LOG: log, WEAVE_RUNTIME_PROBE_WORK: work,
  } })
  assert.match(await fs.readFile(log, 'utf8'), /control:shared-config/)
})
