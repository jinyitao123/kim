import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { EnterpriseConnectionImportResult } from '../../../src/types/api'
import type { EnterpriseService } from '../enterprise'
import { ENTERPRISE_CONNECTION_FILENAME, readEnterpriseConnectionFile, type EnterpriseConnectionConfig } from './connection-config'

interface ImportOptions {
  selectFile(): Promise<string | undefined>
  confirm(config: EnterpriseConnectionConfig): Promise<boolean>
  isSignedOut(): Promise<boolean>
  environment?: NodeJS.ProcessEnv
  activeConnection?: { forgeOrigin: string; weaveOrigin: string }
}

export async function importEnterpriseConnection(directory: string, options: ImportOptions): Promise<EnterpriseConnectionImportResult> {
  const requireSignedOut = async () => { if (!await options.isSignedOut()) throw new Error('请先退出企业账号，再导入组织连接。') }
  await requireSignedOut()
  const file = await options.selectFile()
  if (!file) return { status: 'cancelled' }
  const config = await readEnterpriseConnectionFile(file)
  if (!config) throw new Error('连接文件不存在，请重新选择。')
  await requireSignedOut()
  if (!await options.confirm(config)) return { status: 'cancelled' }
  await requireSignedOut()
  const environment = options.environment ?? process.env
  const environmentOverride = Boolean(environment.WORKBENCH_FORGE_URL?.trim() || environment.WORKBENCH_WEAVE_URL?.trim())
  const restartRequired = !environmentOverride && (options.activeConnection?.forgeOrigin !== config.forgeOrigin || options.activeConnection?.weaveOrigin !== config.weaveOrigin)
  const target = join(directory, ENTERPRISE_CONNECTION_FILENAME)
  const previous = await readEnterpriseConnectionFile(target)
  if (previous?.forgeOrigin === config.forgeOrigin && previous.weaveOrigin === config.weaveOrigin) {
    return { status: 'unchanged', config, environmentOverride, restartRequired }
  }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const parent = await lstat(directory)
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('应用连接目录不可用。')
  const temporary = join(directory, `.enterprise-connection-${randomUUID()}.tmp`)
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(`${JSON.stringify(config)}\n`, 'utf8'); await handle.sync() }
    finally { await handle.close() }
    await requireSignedOut()
    await rename(temporary, target)
    return { status: 'saved', config, environmentOverride, restartRequired }
  } catch {
    throw new Error('组织连接保存失败，原连接未被修改。')
  } finally { await unlink(temporary).catch(() => undefined) }
}

let importing = false
export async function importConnectionForApp(directory: string, enterprise: EnterpriseService): Promise<EnterpriseConnectionImportResult> {
  if (importing) throw new Error('正在导入组织连接，请稍后重试。')
  importing = true
  try {
    const { dialog } = await import('electron')
    return await importEnterpriseConnection(directory, {
      isSignedOut: async () => (await enterprise.getSession()).status !== 'signed-in',
      activeConnection: enterprise.connectionOrigins(),
      selectFile: async () => {
        const result = await dialog.showOpenDialog({ title: '导入组织连接', properties: ['openFile'], filters: [{ name: '组织连接', extensions: ['json'] }] })
        return result.canceled ? undefined : result.filePaths[0]
      },
      confirm: async (config) => (await dialog.showMessageBox({ type: 'question', title: '确认组织连接', message: '保存此组织连接？',
        detail: `Forge：${config.forgeOrigin}\nWeave：${config.weaveOrigin}\n保存后需重新启动应用。`, buttons: ['取消', '保存'], defaultId: 0, cancelId: 0 })).response === 1,
    })
  } finally { importing = false }
}

export async function restartConnectionForApp(enterprise: EnterpriseService): Promise<void> {
  if (importing || (await enterprise.getSession()).status === 'signed-in') throw new Error('请先结束连接导入并退出企业账号。')
  const { app } = await import('electron')
  app.relaunch()
  app.quit()
}
