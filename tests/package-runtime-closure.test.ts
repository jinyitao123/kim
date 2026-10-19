import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, rmdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { createPackage } from '@electron/asar'
import { expect, test, vi } from 'vitest'
import { selectTraversalCollector } from '../scripts/release/electron-builder.mjs'
import { startupRuntimeModules, verifyRuntimeModules } from '../scripts/release/verify-runtime-modules.mjs'

test('selects the shipped traversal collector and preserves its project and temporary directory arguments', () => {
  const original = vi.fn((_manager: string, _root: string, _temporary: string) => ({ collector: 'fixture' }))
  const factory = { PM: { TRAVERSAL: 'traversal' }, getCollectorByPackageManager: original }
  selectTraversalCollector(factory)
  expect(factory.getCollectorByPackageManager('npm', '/project', '/temporary')).toEqual({ collector: 'fixture' })
  expect(original).toHaveBeenCalledWith('traversal', '/project', '/temporary')
  expect(() => selectTraversalCollector({})).toThrow('collector API is unavailable')
})

test('extracts actual startup imports without turning ordinary from text or builtins into packages', () => {
  const source = `import {app} from "electron";
import {readFile} from "node:fs";
import {ModelRegistry} from "prime-agent/model-registry";
import updater from "electron-updater";
const explanation="choose from ' in c && (c.kind === '";
import duplicate from "electron-updater";`
  expect(startupRuntimeModules(source)).toEqual(['electron-updater', 'prime-agent/model-registry'])
})

test.skipIf(process.platform !== 'darwin')('rejects a packaged missing transitive dependency and imports the repaired archive outside the checkout', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'weave-package-closure-test-'))
  const payload = join(directory, 'payload'), archive = join(directory, 'candidate.asar')
  const write = (path: string, value: string) => { mkdirSync(join(payload, path, '..'), { recursive: true }); writeFileSync(join(payload, path), value) }
  try {
    write('package.json', JSON.stringify({ name: 'closure-fixture', version: '1.0.0' }))
    write('node_modules/electron-updater/package.json', JSON.stringify({ name: 'electron-updater', version: '1.0.0', main: 'index.js' }))
    write('node_modules/electron-updater/index.js', "module.exports=require('fs-extra')")
    await createPackage(payload, archive)
    const electronExecutable = createRequire(import.meta.url)('electron') as string
    expect(() => verifyRuntimeModules({ asar: archive, electronExecutable, modules: ['electron-updater'] })).toThrow("Cannot find module 'fs-extra'")
    write('node_modules/fs-extra/package.json', JSON.stringify({ name: 'fs-extra', version: '1.0.0', main: 'index.js' }))
    write('node_modules/fs-extra/index.js', "module.exports=require('node:fs')")
    const repaired = join(directory, 'repaired.asar')
    await createPackage(payload, repaired)
    expect(verifyRuntimeModules({ asar: repaired, electronExecutable, modules: ['electron-updater'] })).toEqual(['electron-updater'])
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test.skipIf(process.platform !== 'darwin')('preserves existing custom QA output and refuses cross-platform custom output that cannot be verified', () => {
  const releaseRoot = resolve('release')
  const createdReleaseRoot = !existsSync(releaseRoot)
  mkdirSync(releaseRoot, { recursive: true })
  let parent: string | undefined
  let cleanupError: unknown
  try {
    parent = mkdtempSync(join(releaseRoot, 'closure-output-parent-'))
    const directory = join(parent, 'output')
    mkdirSync(directory)
    const args = ['scripts/release/package.mjs', '--qa', '--dry-run', '--output-directory', directory]
    const existing = spawnSync(process.execPath, [...args, '--platform', 'mac'], { encoding: 'utf8' })
    expect(existing.status).not.toBe(0)
    expect(existing.stderr).toContain('existing QA artifacts are preserved')
    const unsupported = spawnSync(process.execPath, [...args, '--platform', 'win'], { encoding: 'utf8' })
    expect(unsupported.status).not.toBe(0)
    expect(unsupported.stderr).toContain('macOS packaging only')
  } finally {
    if (parent) rmSync(parent, { recursive: true, force: true })
    if (createdReleaseRoot) {
      try { rmdirSync(releaseRoot) } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) cleanupError = error
      }
    }
  }
  if (cleanupError !== undefined) throw cleanupError
})
