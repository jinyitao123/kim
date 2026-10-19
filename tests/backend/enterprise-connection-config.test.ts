import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEnterpriseService, initializeEnterpriseService, ENTERPRISE_CONNECTION_FILENAME, MAX_ENTERPRISE_CONNECTION_BYTES, parseEnterpriseConnectionConfig } from '../../electron/main/enterprise/connection-config'

const directories: string[] = []
const config = { version: 1, forgeOrigin: 'http://forge.example.test:8080', weaveOrigin: 'https://weave.example.test' }
const environment = {}
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'workbench-connection-'))
  directories.push(path)
  return path
}
async function installed(value: unknown = config) {
  const path = await directory()
  await writeFile(join(path, ENTERPRISE_CONNECTION_FILENAME), JSON.stringify(value), { mode: 0o600 })
  return path
}
const health = () => vi.fn(async () => Response.json({ status: 'ok' })) as unknown as typeof fetch
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('managed enterprise connection', () => {
  it('initializes the complete signed-out service without network activity or persistent credentials', async () => {
    const path = await installed(), fetch = health()
    const { enterprise, accountScope } = await initializeEnterpriseService(path, { environment, fetch })
    expect(accountScope).toBeUndefined()
    expect(await enterprise.getSession()).toMatchObject({ status: 'signed-out', environment: { origin: config.forgeOrigin } })
    expect(fetch).not.toHaveBeenCalled()
    expect(await readdir(path)).toEqual([ENTERPRISE_CONNECTION_FILENAME])
    expect(JSON.parse(await readFile(join(path, ENTERPRISE_CONNECTION_FILENAME), 'utf8'))).toEqual(config)
  })
  it('reconstructs both service addresses after restart without persisting a login or environment', async () => {
    const path = await installed(), before = await readFile(join(path, ENTERPRISE_CONNECTION_FILENAME), 'utf8')
    for (let restart = 0; restart < 2; restart++) {
      const fetch = health(), service = await createEnterpriseService(path, { environment, fetch })
      expect(fetch).not.toHaveBeenCalled()
      expect(await service.getSession()).toMatchObject({ status: 'signed-out', environment: { origin: config.forgeOrigin, secure: false } })
      expect((await service.getStatus()).map(item => item.url)).toEqual([config.forgeOrigin, config.weaveOrigin])
    }
    expect(await readFile(join(path, ENTERPRISE_CONNECTION_FILENAME), 'utf8')).toBe(before)
    expect(await readdir(path)).toEqual([ENTERPRISE_CONNECTION_FILENAME])
  })
  it('keeps the existing local development defaults only when no selected configuration exists', async () => {
    const path = await directory(), fetch = health()
    const service = await createEnterpriseService(path, { environment, fetch })
    expect(fetch).not.toHaveBeenCalled()
    expect((await service.getStatus()).map(item => item.url)).toEqual(['http://127.0.0.1:3000', 'http://127.0.0.1:8080'])
    expect(await readdir(path)).toEqual([])
  })
  it('uses an explicit environment pair as one development override without rewriting the installed file', async () => {
    const path = await installed(), before = await readFile(join(path, ENTERPRISE_CONNECTION_FILENAME), 'utf8')
    const service = await createEnterpriseService(path, { environment: { WORKBENCH_FORGE_URL: ' https://dev-forge.example.test/ ', WORKBENCH_WEAVE_URL: 'http://dev-weave.example.test' }, fetch: health() })
    expect((await service.getStatus()).map(item => item.url)).toEqual(['https://dev-forge.example.test', 'http://dev-weave.example.test'])
    expect(await readFile(join(path, ENTERPRISE_CONNECTION_FILENAME), 'utf8')).toBe(before)
    const override = await installed({ version: 99 })
    await expect((await createEnterpriseService(override, { environment: { WORKBENCH_FORGE_URL: config.forgeOrigin, WORKBENCH_WEAVE_URL: config.weaveOrigin } })).getSession()).resolves.toMatchObject({ status: 'signed-out' })
  })
  it('treats a whitespace-only environment pair as absent while rejecting either partial pair', async () => {
    const path = await installed()
    expect((await (await createEnterpriseService(path, { environment: { WORKBENCH_FORGE_URL: ' ', WORKBENCH_WEAVE_URL: '\t' }, fetch: health() })).getStatus()).map(item => item.url)).toEqual([config.forgeOrigin, config.weaveOrigin])
    for (const partial of [{ WORKBENCH_FORGE_URL: config.forgeOrigin }, { WORKBENCH_WEAVE_URL: config.weaveOrigin }, { WORKBENCH_FORGE_URL: config.forgeOrigin, WORKBENCH_WEAVE_URL: ' ' }]) {
      await expect(createEnterpriseService(path, { environment: partial })).rejects.toThrow('必须同时设置')
    }
  })
  it.each([
    null, [], {}, { ...config, version: '1' }, { ...config, version: 2 },
    { version: 1, forgeOrigin: config.forgeOrigin }, { ...config, weaveOrigin: '' }, { ...config, token: 'DO-NOT-EXPOSE' },
  ])('fails closed for malformed, partial or unknown-version file data %#', async value => {
    await expect(createEnterpriseService(await installed(value), { environment })).rejects.toThrow('部署连接配置无效')
  })
  it.each(['file:///tmp/config', 'http://name:DO-NOT-EXPOSE@forge.example.test', 'http://forge.example.test/api', 'http://forge.example.test/api/..', 'http://forge.example.test\\', 'http://forge.example.test?token=DO-NOT-EXPOSE', 'http://forge.example.test/#DO-NOT-EXPOSE'])('rejects unsafe origins without exposing the supplied value %#', async value => {
    const path = await installed({ ...config, forgeOrigin: value })
    for (const action of [() => createEnterpriseService(path, { environment }), () => createEnterpriseService(path, { environment: { WORKBENCH_FORGE_URL: value, WORKBENCH_WEAVE_URL: config.weaveOrigin } })]) {
      const error = await action().catch(error => error as Error)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).not.toContain('DO-NOT-EXPOSE')
      expect((error as Error).message).not.toContain(value)
    }
  })
  it('normalizes valid origins without paths and rejects non-string fields', () => {
    expect(parseEnterpriseConnectionConfig({ ...config, forgeOrigin: 'HTTP://FORGE.EXAMPLE.TEST:80/' })).toEqual({ ...config, forgeOrigin: 'http://forge.example.test' })
    expect(() => parseEnterpriseConnectionConfig({ ...config, forgeOrigin: 42 })).toThrow('部署连接配置无效')
  })
  it('rejects malformed JSON, invalid UTF-8 and oversized files', async () => {
    const path = await installed(), file = join(path, ENTERPRISE_CONNECTION_FILENAME)
    for (const bytes of [Buffer.from('{invalid'), Buffer.from([0xff]), Buffer.alloc(MAX_ENTERPRISE_CONNECTION_BYTES + 1, 0x20)]) {
      await writeFile(file, bytes)
      await expect(createEnterpriseService(path, { environment })).rejects.toThrow('部署连接配置无效')
    }
  })
  it('rejects directories instead of treating them as absent configuration', async () => {
    const path = await directory()
    await mkdir(join(path, ENTERPRISE_CONNECTION_FILENAME))
    await expect(createEnterpriseService(path, { environment })).rejects.toThrow('部署连接配置无效')
  })
  it.skipIf(process.platform === 'win32')('rejects symlinked and unreadable managed configuration', async () => {
    const path = await directory(), target = join(path, 'target.json'), file = join(path, ENTERPRISE_CONNECTION_FILENAME)
    await writeFile(target, JSON.stringify(config), { mode: 0o600 })
    await symlink(target, file)
    await expect(createEnterpriseService(path, { environment })).rejects.toThrow('部署连接配置无效')
    await rm(file)
    await writeFile(file, JSON.stringify(config), { mode: 0o600 })
    await chmod(file, 0o000)
    try { await expect(createEnterpriseService(path, { environment })).rejects.toThrow('部署连接配置无效') }
    finally { await chmod(file, 0o600) }
  })
})
