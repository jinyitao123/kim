import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { digest, HandoffStore, submissionUUID } from '../../electron/main/enterprise/handoff-store'

describe('durable frozen handoff', () => {
  it('uses an RFC 9562 UUID and isolates account and intent', () => {
    expect(submissionUUID('account:turn:team')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(submissionUUID('account:turn:team')).toBe(submissionUUID('account:turn:team'))
    expect(submissionUUID('other:turn:team')).not.toBe(submissionUUID('account:turn:team'))
  })

  it('persists exact JSON privately, restores the request, and refuses changed content', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'handoff-store-'))
    const key = 'account-1:request'
    try {
      const first = new HandoffStore({ directory })
      const body = { task: '合同正文原版', sourceMessages: [{ messageId: 'employee-1', sha256: 'audit' }] }
      await first.freeze(key, 'original', async () => body)

      const files = await readdir(directory)
      expect(files).toEqual([`${digest(key)}.json`])
      expect(JSON.parse((await readFile(join(directory, files[0]!))).toString('utf8'))).toEqual({ fingerprint: 'original', value: body })
      if (process.platform !== 'win32') {
        expect((await stat(directory)).mode & 0o777).toBe(0o700)
        expect((await stat(join(directory, files[0]!))).mode & 0o777).toBe(0o600)
      }

      const reopened = new HandoffStore({ directory }),
        prepare = vi.fn(async () => ({ task: 'changed' }))
      expect(await reopened.freeze(key, 'original', prepare)).toEqual(body)
      expect(await reopened.recover(digest(key))).toEqual(body)
      expect(prepare).not.toHaveBeenCalled()
      await expect(reopened.freeze(key, 'changed', prepare)).rejects.toThrow('已冻结')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('persists revision upload and receipt checkpoints across store recreation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'handoff-checkpoint-'))
    try {
      const first = new HandoffStore({ directory })
      await first.checkpoint('revision:round-1', 'fixed-package', { phase: 'uploaded', fileIds: ['primary', 'attachment'] })
      const reopened = new HandoffStore({ directory })
      expect(await reopened.inspect('revision:round-1')).toEqual({ fingerprint: 'fixed-package', value: { phase: 'uploaded', fileIds: ['primary', 'attachment'] } })
      await reopened.checkpoint('revision:round-1', 'fixed-package', { phase: 'receipt', state: 'resume_unknown' })
      const recovered = await new HandoffStore({ directory }).inspect('revision:round-1')
      expect(recovered).toEqual({ fingerprint: 'fixed-package', value: { phase: 'receipt', state: 'resume_unknown' } })
      await expect(reopened.checkpoint('revision:round-1', 'changed-package', { phase: 'request_started' })).rejects.toThrow('已冻结')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('serializes concurrent phase checkpoints in call order', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'handoff-checkpoint-order-'))
    try {
      const store = new HandoffStore({ directory })
      await Promise.all([
        store.checkpoint('revision:round-2', 'fixed-package', { phase: 'upload_started' }),
        store.checkpoint('revision:round-2', 'fixed-package', { phase: 'uploaded' }),
        store.checkpoint('revision:round-2', 'fixed-package', { phase: 'request_started' }),
      ])
      expect(await new HandoffStore({ directory }).inspect('revision:round-2')).toEqual({
        fingerprint: 'fixed-package',
        value: { phase: 'request_started' },
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('does not treat an old encrypted record as absent or remove it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'handoff-legacy-'))
    const key = 'account-1:legacy-request'
    const legacyPath = join(directory, `${digest(key)}.bin`)
    const legacyBytes = Buffer.from('old encrypted record')
    const prepare = vi.fn(async () => ({ task: 'duplicate' }))
    try {
      await writeFile(legacyPath, legacyBytes, { mode: 0o600 })
      const store = new HandoffStore({ directory })
      await expect(store.freeze(key, 'original', prepare)).rejects.toThrow('旧版加密交接记录')
      await expect(store.recover(digest(key))).rejects.toThrow('旧版加密交接记录')
      expect(prepare).not.toHaveBeenCalled()
      expect(await readdir(directory)).toEqual([`${digest(key)}.bin`])
      expect(await readFile(legacyPath)).toEqual(legacyBytes)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each(['{"fingerprint":', '{}'])('fails closed on damaged JSON %s', async (contents) => {
    const directory = await mkdtemp(join(tmpdir(), 'handoff-corrupt-'))
    const key = 'account-1:corrupt-request'
    const path = join(directory, `${digest(key)}.json`)
    const prepare = vi.fn(async () => ({ task: 'duplicate' }))
    try {
      await writeFile(path, contents, { mode: 0o600 })
      const store = new HandoffStore({ directory })
      await expect(store.freeze(key, 'original', prepare)).rejects.toThrow('无法读取原交接记录')
      await expect(store.inspect(key)).rejects.toThrow('无法读取原交接记录')
      expect(prepare).not.toHaveBeenCalled()
      expect(await readdir(directory)).toEqual([`${digest(key)}.json`])
      expect(await readFile(path, 'utf8')).toBe(contents)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
