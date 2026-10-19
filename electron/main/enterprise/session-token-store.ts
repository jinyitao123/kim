import { constants } from 'node:fs'
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

// Keeps the one thing a restart needs to sign in again without the browser:
// the native session token, in a user-private file bound to the Forge it came
// from. The account, organization and permissions are read again from that session.

export interface SessionTokenStore {
  read(): Promise<string | undefined>
  write(token: string): Promise<void>
  clear(): Promise<void>
}

const FILE = 'enterprise-session.json'
const MAX_BYTES = 8192

/** Login persistence uses only the app's private files, never the system keychain. */
export function createSessionTokenStore(directory: string, forgeOrigin: string): SessionTokenStore {
  const path = join(directory, FILE)
  const clear = () => rm(path, { force: true })
  return {
    async read() {
      let saved: unknown
      try {
        const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
        try {
          const info = await file.stat()
          if (!info.isFile() || info.size > MAX_BYTES || (process.platform !== 'win32' && (info.mode & 0o077 || info.uid !== process.getuid?.()))) throw new Error('Invalid private session file')
          const bytes = Buffer.alloc(MAX_BYTES + 1)
          let length = 0
          while (length < bytes.length) {
            const read = await file.read(bytes, length, bytes.length - length, null)
            if (!read.bytesRead) break
            length += read.bytesRead
          }
          if (length > MAX_BYTES) throw new Error('Session file exceeds its limit')
          saved = JSON.parse(bytes.subarray(0, length).toString('utf8'))
        } finally { await file.close() }
      } catch (error) {
        // A missing file is the ordinary signed-out state; anything unreadable is discarded.
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') await clear().catch(() => undefined)
        return undefined
      }
      const entry = saved as { version?: unknown; origin?: unknown; token?: unknown }
      if (entry?.version !== 1 || entry.origin !== forgeOrigin || typeof entry.token !== 'string' || !entry.token) {
        await clear().catch(() => undefined)
        return undefined
      }
      return entry.token
    },
    async write(token) {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await chmod(directory, 0o700)
      const data = JSON.stringify({ version: 1, origin: forgeOrigin, token })
      if (!token || Buffer.byteLength(data) > MAX_BYTES) throw new Error('Invalid session token')
      const temporary = `${path}.${randomUUID()}.tmp`
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
      try {
        await file.writeFile(data)
        await file.sync()
        await file.close()
        await rename(temporary, path)
      } finally {
        await file.close().catch(() => undefined)
        await rm(temporary, { force: true })
      }
    },
    clear,
  }
}
