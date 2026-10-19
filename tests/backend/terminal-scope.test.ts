import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mockPty = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node-pty', () => ({ spawn: mockPty.spawn }))

import { TerminalService } from '../../electron/main/terminal'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('TerminalService account-scope barrier', () => {
  it('waits for a terminal create to register before killing it and blocks new creates', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'gooeypi-terminal-scope-')); dirs.push(cwd)
    let entered!: () => void
    let release!: () => void
    let exit!: (event: { exitCode: number; signal?: number }) => void
    const admissionEntered = new Promise<void>((resolve) => { entered = resolve })
    const admissionGate = new Promise<void>((resolve) => { release = resolve })
    const fakeTerminal = {
      pid: 2_147_000_000,
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onExit: vi.fn((listener: typeof exit) => { exit = listener; return { dispose: vi.fn() } }),
      write: vi.fn(), resize: vi.fn(),
      kill: vi.fn(() => exit?.({ exitCode: 0, signal: 0 })),
    }
    mockPty.spawn.mockReset().mockReturnValue(fakeTerminal)
    const owner = { id: 63, isDestroyed: () => false, send: vi.fn() } as unknown as WebContents
    const service = new TerminalService(async () => cwd, () => '/bin/sh', async (path) => path, async () => {
      entered()
      await admissionGate
      return { release: () => undefined }
    })

    const creating = service.create(owner, { cwd, shell: '/bin/sh', cols: 80, rows: 24 })
    await admissionEntered
    let quiesced = false
    const quiesce = service.pauseCreationsAndKillAll().then(() => { quiesced = true })
    await expect(service.create(owner, { cwd, shell: '/bin/sh', cols: 80, rows: 24 })).rejects.toThrow('paused while the account is changing')
    expect(quiesced).toBe(false)

    release()
    const oldTerminal = await creating
    await quiesce
    expect(fakeTerminal.kill).toHaveBeenCalled()
    await expect(service.kill(owner, oldTerminal.terminalId)).resolves.toBe(false)

    service.resumeCreations()
    await service.create(owner, { cwd, shell: '/bin/sh', cols: 80, rows: 24 })
    expect(mockPty.spawn).toHaveBeenCalledTimes(2)
  })
})
