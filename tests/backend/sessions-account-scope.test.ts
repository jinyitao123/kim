import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionService, type SessionServiceOptions, type SessionWatcher } from '../../electron/main/sessions'
import { JsonStateStore } from '../../electron/main/store'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

function writeSession(file: string, cwd: string, id: string): Promise<void> {
  return writeFile(file, [
    JSON.stringify({ type: 'session', id, cwd, timestamp: '2025-01-01T00:00:00.000Z' }),
    JSON.stringify({ type: 'message', id: `${id}-message`, parentId: null, message: { role: 'user', content: id, timestamp: '2025-01-01T00:00:00.000Z' } }),
    '',
  ].join('\n'))
}

describe('SessionService account scope', () => {
  it('moves the catalog to the new account root and rejects the prior root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gooeypi-session-account-scope-')); dirs.push(dir)
    const rootA = join(dir, 'accounts', 'a', 'sessions')
    const rootB = join(dir, 'accounts', 'b', 'sessions')
    const project = join(dir, 'project')
    await Promise.all([mkdir(rootA, { recursive: true }), mkdir(rootB, { recursive: true }), mkdir(project)])
    const fileA = join(rootA, 'same-session.jsonl')
    const fileB = join(rootB, 'same-session.jsonl')
    await Promise.all([writeSession(fileA, project, 'employee-a'), writeSession(fileB, project, 'employee-b')])

    const watchers: Array<{ path: string; listener: (eventType: string, filename: string | Buffer | null) => void; watcher: SessionWatcher }> = []
    const watchDirectory: NonNullable<SessionServiceOptions['watchDirectory']> = (path, _options, listener) => {
      let watcher: SessionWatcher
      watcher = { close: vi.fn(), on: () => watcher }
      watchers.push({ path, listener, watcher })
      return watcher
    }
    const service = new SessionService(new JsonStateStore(join(dir, 'state.json')), null, undefined, { sessionRoot: rootA, watchDirectory })
    const stopped: string[] = []
    service.bindRuntimeHooks({
      get: () => undefined,
      all: () => [{ sessionFile: fileA, isStreaming: true }],
      stop: async (path) => { stopped.push(path) },
      rename: async () => false,
    })

    expect(await service.list()).toMatchObject([{ id: 'employee-a' }])
    const changed: unknown[] = []
    const unsubscribe = service.onDidChange((event) => changed.push(event))
    await service.setSessionRoot(rootB)
    expect(service.sessionRoot).toBe(await realpath(rootB))
    expect(stopped).toEqual([await realpath(fileA)])
    expect(await service.list()).toMatchObject([{ id: 'employee-b', status: 'idle' }])
    expect((await service.read(fileB)).at(-1)?.parts).toEqual([{ type: 'text', text: 'employee-b' }])
    await expect(service.read(fileA)).rejects.toThrow('outside the')
    await expect(service.followUp(fileA, 'must not reach the prior account')).rejects.toThrow('outside the')
    await expect(service.rename(fileA, 'must not rename the prior account')).rejects.toThrow('outside the')
    await expect(service.archive(fileA)).rejects.toThrow('outside the')
    expect(watchers.map(({ path }) => path)).toEqual([rootA, await realpath(rootB)])
    expect(watchers[0]?.watcher.close).toHaveBeenCalledOnce()

    // A late event from the retired account root must not announce the new account's catalog.
    watchers[0]?.listener('change', 'same-session.jsonl')
    await new Promise((resolveWait) => setTimeout(resolveWait, 150))
    expect(changed).toEqual([])
    unsubscribe()
  })
})
