import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { importEnterpriseConnection } from '../../electron/main/enterprise/connection-import'
import { ENTERPRISE_CONNECTION_FILENAME } from '../../electron/main/enterprise/connection-config'

const roots: string[] = []
const failure = vi.hoisted(() => ({ rename: false }))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, rename: (...args: Parameters<typeof fs.rename>) => {
    if (failure.rename) return Promise.reject(Object.assign(new Error('fixture disk failure'), { code: 'EIO' }))
    return fs.rename(...args)
  } }
})
const config = { version: 1 as const, forgeOrigin: 'https://forge.example.test', weaveOrigin: 'http://weave.example.test:8080' }
async function fixture(value: unknown = config) {
  const root = await mkdtemp(join(tmpdir(), 'weave-connection-import-')); roots.push(root)
  const file = join(root, 'organization.json')
  await writeFile(file, JSON.stringify(value))
  const options = { selectFile: vi.fn(async () => file as string | undefined), confirm: vi.fn(async () => true), isSignedOut: vi.fn(async () => true), environment: {} }
  return { root, file, directory: join(root, 'app'), options }
}
afterEach(async () => { failure.rename = false; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('organization connection import', () => {
  it('confirms normalized origins, writes a restricted file and requires restart without logging in', async () => {
    const f = await fixture({ ...config, forgeOrigin: config.forgeOrigin + '/' })
    const result = await importEnterpriseConnection(f.directory, f.options)
    expect(f.options.confirm).toHaveBeenCalledWith(config)
    expect(result).toEqual({ status: 'saved', config, environmentOverride: false, restartRequired: true })
    const target = join(f.directory, ENTERPRISE_CONNECTION_FILENAME)
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual(config)
    if (process.platform !== 'win32') expect((await stat(target)).mode & 0o777).toBe(0o600)
    expect(await readdir(f.directory)).toEqual([ENTERPRISE_CONNECTION_FILENAME])
  })
  it('does not rewrite identical normalized configuration or create backup files', async () => {
    const f = await fixture()
    await importEnterpriseConnection(f.directory, f.options)
    const target = join(f.directory, ENTERPRISE_CONNECTION_FILENAME), before = await stat(target)
    expect(await importEnterpriseConnection(f.directory, { ...f.options, activeConnection: config })).toMatchObject({ status: 'unchanged', restartRequired: false })
    expect((await stat(target)).mtimeMs).toBe(before.mtimeMs)
    expect(await readdir(f.directory)).toEqual([ENTERPRISE_CONNECTION_FILENAME])
  })
  it.each(['picker', 'confirmation'])('leaves no changes after cancellation at %s', async (stage) => {
    const f = await fixture()
    if (stage === 'picker') f.options.selectFile.mockResolvedValue(undefined)
    else f.options.confirm.mockResolvedValue(false)
    expect(await importEnterpriseConnection(f.directory, f.options)).toEqual({ status: 'cancelled' })
    await expect(stat(f.directory)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it.each([{ ...config, password: 'must-not-be-accepted' }, { ...config, weaveOrigin: 'https://example.test/path' }, { ...config, forgeOrigin: 'https://u:p@example.test' }])('refuses an invalid document without replacing existing configuration', async (invalid) => {
    const f = await fixture(); await importEnterpriseConnection(f.directory, f.options)
    const target = join(f.directory, ENTERPRISE_CONNECTION_FILENAME), before = await readFile(target)
    await writeFile(f.file, JSON.stringify(invalid))
    await expect(importEnterpriseConnection(f.directory, f.options)).rejects.toThrow('配置无效')
    expect(await readFile(target)).toEqual(before)
  })
  it('refuses oversize and symlink inputs', async () => {
    const f = await fixture()
    await writeFile(f.file, ' '.repeat(8193))
    await expect(importEnterpriseConnection(f.directory, f.options)).rejects.toThrow('配置无效')
    await writeFile(f.file, JSON.stringify(config))
    const link = join(f.root, 'link.json')
    if (process.platform !== 'win32') {
      await symlink(f.file, link); f.options.selectFile.mockResolvedValue(link)
      await expect(importEnterpriseConnection(f.directory, f.options)).rejects.toThrow('配置无效')
    }
  })
  it('refuses signed-in calls and a login race before saving', async () => {
    const f = await fixture(); f.options.isSignedOut.mockResolvedValue(false)
    await expect(importEnterpriseConnection(f.directory, f.options)).rejects.toThrow('退出企业账号')
    expect(f.options.selectFile).not.toHaveBeenCalled()
    f.options.isSignedOut.mockResolvedValue(true)
    f.options.confirm.mockImplementation(async () => { f.options.isSignedOut.mockResolvedValue(false); return true })
    await expect(importEnterpriseConnection(f.directory, f.options)).rejects.toThrow('退出企业账号')
    await expect(stat(f.directory)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('reports developer overrides instead of claiming the saved origin is active', async () => {
    const f = await fixture()
    expect(await importEnterpriseConnection(f.directory, { ...f.options, environment: { WORKBENCH_FORGE_URL: 'https://dev-forge.example.test', WORKBENCH_WEAVE_URL: 'https://dev-weave.example.test' } })).toMatchObject({ status: 'saved', environmentOverride: true, restartRequired: false })
  })
  it('keeps the old valid file and removes the temporary file when atomic replacement fails', async () => {
    const f = await fixture(); await importEnterpriseConnection(f.directory, f.options)
    const target = join(f.directory, ENTERPRISE_CONNECTION_FILENAME), original = await readFile(target)
    await writeFile(f.file, JSON.stringify({ ...config, forgeOrigin: 'https://other.example.test' }))
    failure.rename = true
    await expect(importEnterpriseConnection(f.directory, f.options)).rejects.toThrow('保存失败')
    expect(await readFile(target)).toEqual(original)
    expect(await readdir(f.directory)).toEqual([ENTERPRISE_CONNECTION_FILENAME])
  })
})
