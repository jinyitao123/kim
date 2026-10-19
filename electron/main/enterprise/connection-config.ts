import { constants, type Stats } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'
import { EnterpriseService } from '../enterprise'
import { createSessionTokenStore } from './session-token-store'

export const ENTERPRISE_CONNECTION_FILENAME = 'enterprise-connection.json'
export const MAX_ENTERPRISE_CONNECTION_BYTES = 8192
export interface EnterpriseConnectionConfig { version: 1; forgeOrigin: string; weaveOrigin: string }
interface FactoryOptions {
  environment?: NodeJS.ProcessEnv
  fetch?: typeof fetch
  /** Hidden automated runs can keep their sign-in only for the current process. */
  persistSession?: boolean
  openExternal?(url: string): Promise<void>
}

function invalidConfig(): never {
  throw new Error('部署连接配置无效或不可读取，请由管理员检查 enterprise-connection.json。')
}
function origin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) return invalidConfig()
  const text = value.trim()
  // Check the supplied syntax as well as URL's normalized result: dot paths
  // and backslashes must not become an apparently valid origin by normalization.
  if (!/^https?:\/\/[^\s/?#\\]+\/?$/i.test(text)) return invalidConfig()
  try {
    const url = new URL(text)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) return invalidConfig()
    return url.origin
  } catch { return invalidConfig() }
}
export function parseEnterpriseConnectionConfig(value: unknown): EnterpriseConnectionConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidConfig()
  const input = value as Record<string, unknown>
  if (input.version !== 1 || Object.keys(input).length !== 3
    || Object.keys(input).some(key => !['version', 'forgeOrigin', 'weaveOrigin'].includes(key))) return invalidConfig()
  return { version: 1, forgeOrigin: origin(input.forgeOrigin), weaveOrigin: origin(input.weaveOrigin) }
}
export async function readEnterpriseConnectionFile(path: string): Promise<EnterpriseConnectionConfig | undefined> {
  let entry: Stats
  try { entry = await lstat(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    return invalidConfig()
  }
  if (!entry.isFile() || entry.size > MAX_ENTERPRISE_CONNECTION_BYTES
    || (process.platform !== 'win32' && (entry.mode & 0o444) === 0)) return invalidConfig()
  // No symlink following or FIFO blocking if the path is replaced after lstat.
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  const file = await open(path, flags).catch(() => invalidConfig())
  try {
    const actual = await file.stat()
    if (!actual.isFile() || actual.size > MAX_ENTERPRISE_CONNECTION_BYTES) return invalidConfig()
    const bytes = Buffer.alloc(MAX_ENTERPRISE_CONNECTION_BYTES + 1)
    let length = 0
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, null)
      if (!read.bytesRead) break
      length += read.bytesRead
    }
    if (length > MAX_ENTERPRISE_CONNECTION_BYTES) return invalidConfig()
    return parseEnterpriseConnectionConfig(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))))
  } catch { return invalidConfig() }
  finally { await file.close() }
}

/** Connection selection and service creation stay together in this lazy chunk.
 * Deployment addresses are configuration; the sign-in is kept only as a
 * private session file bound to the Forge it was issued by. */
export async function createEnterpriseService(userDataDirectory: string, options: FactoryOptions = {}): Promise<EnterpriseService> {
  const environment = options.environment ?? process.env
  const forge = environment.WORKBENCH_FORGE_URL?.trim() || undefined
  const weave = environment.WORKBENCH_WEAVE_URL?.trim() || undefined
  if (Boolean(forge) !== Boolean(weave)) {
    throw new Error('开发连接覆盖必须同时设置 Forge 与 Weave 地址，不能与部署配置混用。')
  }
  const config = forge && weave
    ? parseEnterpriseConnectionConfig({ version: 1, forgeOrigin: forge, weaveOrigin: weave })
    : await readEnterpriseConnectionFile(join(userDataDirectory, ENTERPRISE_CONNECTION_FILENAME))
  const tokenStore = config && options.persistSession !== false ? createSessionTokenStore(userDataDirectory, config.forgeOrigin) : undefined
  return new EnterpriseService({ fetch: options.fetch, openExternal: options.openExternal, tokenStore, environment: {
    ...environment,
    WORKBENCH_FORGE_URL: config?.forgeOrigin,
    WORKBENCH_WEAVE_URL: config?.weaveOrigin,
  } })
}

export async function initializeEnterpriseService(userDataDirectory: string, options: FactoryOptions = {}) {
  const enterprise = await createEnterpriseService(userDataDirectory, options)
  // Nothing is listening for account changes yet: the restored account is the one the app starts in.
  const session = await enterprise.restoreSession()
  const accountScope = session.status === 'signed-in' ? enterprise.accountKeyForSession(session) : undefined
  return { enterprise, accountScope, connectionImport: {
    importEnterpriseConnection: async () => (await import('./connection-import')).importConnectionForApp(userDataDirectory, enterprise),
    restartEnterpriseConnection: async () => (await import('./connection-import')).restartConnectionForApp(enterprise),
  } }
}
