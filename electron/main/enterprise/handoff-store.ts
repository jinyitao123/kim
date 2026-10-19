import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}
export function submissionUUID(seed: string): string {
  const bytes = createHash('sha256').update(seed).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x80
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
export interface HandoffStorage {
  directory: string
}
interface StoredValue {
  fingerprint: string
  value: unknown
}

const STORAGE_DIRECTORY_REQUIRED = '本地交接存储目录未配置，无法固定交接内容。恢复目录配置前不会上传材料或创建团队运行。'
const LEGACY_FORMAT_UNREADABLE = '检测到旧版加密交接记录；当前版本无法读取，原文件未修改。请先核对原工作状态，勿重复创建工作。'
const RECORD_UNREADABLE = '无法读取原交接记录，请勿重新创建重复工作'

/** Per-account immutable checkpoints. Callers persist local intent before network preparation. */
export class HandoffStore {
  private readonly memory = new Map<string, StoredValue>()
  private readonly pending = new Map<string, Promise<unknown>>()
  private readonly checkpointQueues = new Map<string, Promise<void>>()
  constructor(private readonly storage?: HandoffStorage) {}

  async freeze<T>(key: string, fingerprint: string, prepare: () => Promise<T>): Promise<T> {
    const prior = this.pending.get(key)
    if (prior) {
      await prior
      return this.freeze(key, fingerprint, prepare)
    }
    const operation = this.loadOrPrepare(key, fingerprint, prepare)
    this.pending.set(key, operation)
    try {
      return await operation
    } finally {
      this.pending.delete(key)
    }
  }

  async recover<T>(recoveryKey: string): Promise<T> {
    if (!/^[0-9a-f]{64}$/.test(recoveryKey)) throw new Error('交接恢复凭据无效')
    for (const [key, saved] of this.memory) if (digest(key) === recoveryKey) return structuredClone(saved.value) as T
    if (!this.storage?.directory) throw new Error(STORAGE_DIRECTORY_REQUIRED)
    const saved = await this.readSavedByFilename(recoveryKey)
    if (!saved) throw new Error(RECORD_UNREADABLE)
    return structuredClone(saved.value) as T
  }

  async inspect<T>(key: string): Promise<{ fingerprint: string; value: T } | undefined> {
    const pending = this.pending.get(key)
    if (pending) await pending
    const checkpointPending = this.checkpointQueues.get(key)
    if (checkpointPending) await checkpointPending
    const saved = await this.loadSaved(key)
    if (!saved) return undefined
    this.memory.set(key, saved)
    return { fingerprint: saved.fingerprint, value: structuredClone(saved.value) as T }
  }

  async checkpoint<T>(key: string, fingerprint: string, value: T): Promise<T> {
    const prior = this.checkpointQueues.get(key)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const operation = prior ? prior.then(() => gate) : gate
    this.checkpointQueues.set(key, operation)
    try {
      if (prior) await prior
      return await this.writeCheckpoint(key, fingerprint, value)
    } finally {
      release()
      if (this.checkpointQueues.get(key) === operation) this.checkpointQueues.delete(key)
    }
  }

  private async loadSaved(key: string): Promise<StoredValue | undefined> {
    const saved = this.memory.get(key)
    if (saved) return saved
    if (!this.storage?.directory) return undefined
    return this.readSavedByFilename(digest(key))
  }

  private async readSavedByFilename(filename: string): Promise<StoredValue | undefined> {
    if (!this.storage?.directory) return undefined
    const path = join(this.storage.directory, `${filename}.json`)
    let contents: Buffer
    try {
      contents = await readFile(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(RECORD_UNREADABLE)
      await this.rejectLegacyRecord(filename)
      return undefined
    }

    try {
      const parsed: unknown = JSON.parse(contents.toString('utf8'))
      if (!isStoredValue(parsed)) throw new Error('invalid handoff record')
      return parsed
    } catch {
      throw new Error(RECORD_UNREADABLE)
    }
  }

  private async rejectLegacyRecord(filename: string): Promise<void> {
    if (!this.storage?.directory) return
    try {
      await stat(join(this.storage.directory, `${filename}.bin`))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw new Error(RECORD_UNREADABLE)
    }
    throw new Error(LEGACY_FORMAT_UNREADABLE)
  }

  private async writeCheckpoint<T>(key: string, fingerprint: string, value: T): Promise<T> {
    const existing = await this.loadSaved(key)
    if (existing && existing.fingerprint !== fingerprint) throw new Error('本轮交接内容已冻结；目标或材料变化后请由员工发起新一轮交接')
    const saved = { fingerprint, value: structuredClone(value) }
    if (this.storage?.directory) await this.writeSaved(key, saved)
    this.memory.set(key, saved)
    return structuredClone(saved.value) as T
  }

  private async loadOrPrepare<T>(key: string, fingerprint: string, prepare: () => Promise<T>): Promise<T> {
    const saved = await this.loadSaved(key)
    if (saved) {
      if (saved.fingerprint !== fingerprint) throw new Error('本轮交接内容已冻结；目标或材料变化后请由员工发起新一轮交接')
      this.memory.set(key, saved)
      return structuredClone(saved.value) as T
    }
    const value = await prepare()
    const next = { fingerprint, value: structuredClone(value) }
    if (this.storage?.directory) await this.writeSaved(key, next)
    this.memory.set(key, next)
    return structuredClone(value)
  }

  private async writeSaved(key: string, saved: StoredValue): Promise<void> {
    const directory = this.storage?.directory
    if (!directory) throw new Error(STORAGE_DIRECTORY_REQUIRED)
    const filename = digest(key)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    const path = join(directory, `${filename}.json`)
    const temp = join(directory, `${filename}.${randomUUID()}.tmp`)
    try {
      await writeFile(temp, JSON.stringify(saved), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await rename(temp, path)
    } catch (error) {
      try {
        await unlink(temp)
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanupError
      }
      throw error
    }
  }
}

function isStoredValue(value: unknown): value is StoredValue {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && typeof (value as StoredValue).fingerprint === 'string' && Object.hasOwn(value, 'value'))
}
