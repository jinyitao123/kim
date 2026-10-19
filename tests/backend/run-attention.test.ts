import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EnterpriseWorkAttention, SessionRecord } from '../../src/types/api'
import { digest } from '../../electron/main/enterprise/handoff-store'
import { RunAttentionService } from '../../electron/main/enterprise/run-attention'
import { diffRunWatch, runAttentionKind, sessionReferenceMatches } from '../../electron/main/enterprise/run-watcher'
import type { WorkbenchRunLookup } from '../../electron/main/enterprise/work-sources'

const run = (runId: string, status: string, extra: Partial<WorkbenchRunLookup> = {}): WorkbenchRunLookup => ({
  runId, status, inputRevisionID: `input-${runId}`, workbenchSessionID: `workbench-u-${'a'.repeat(24)}-work`, isCurrent: true, ...extra,
})

describe('run attention kinds', () => {
  it('maps run state and business results to the employee-facing reason', () => {
    expect(runAttentionKind({ status: 'succeeded' })).toBe('succeeded')
    expect(runAttentionKind({ status: 'succeeded', businessResult: 'needs_input' })).toBe('needs_input')
    expect(runAttentionKind({ status: 'succeeded', businessResult: 'action_unknown' })).toBe('action_check')
    expect(runAttentionKind({ status: 'failed' })).toBe('failed')
    expect(runAttentionKind({ status: 'parked' })).toBe('waiting')
    expect(runAttentionKind({ status: 'running' })).toBeUndefined()
    expect(runAttentionKind({ status: 'cancelled' })).toBeUndefined()
  })
})

describe('run watch diff', () => {
  it('seeds runs seen for the first time without notifying', () => {
    const { state, attentions } = diffRunWatch({}, [run('r1', 'succeeded'), run('r2', 'running')])
    expect(attentions).toEqual([])
    expect(state).toEqual({ r1: 'succeeded', r2: 'active' })
  })

  it('notifies once when an active run needs attention, including across a restart', () => {
    const first = diffRunWatch({ r1: 'active' }, [run('r1', 'succeeded')])
    expect(first.attentions).toEqual([{ runId: 'r1', kind: 'succeeded', sessionReference: run('r1', 'x').workbenchSessionID }])
    expect(diffRunWatch(first.state, [run('r1', 'succeeded')]).attentions).toEqual([])
  })

  it('notifies again when a waiting run later finishes, but not for cancelled or superseded runs', () => {
    expect(diffRunWatch({ r1: 'waiting' }, [run('r1', 'succeeded')]).attentions.map((item) => item.kind)).toEqual(['succeeded'])
    expect(diffRunWatch({ r1: 'active' }, [run('r1', 'cancelled')]).attentions).toEqual([])
    expect(diffRunWatch({ r1: 'active' }, [run('r1', 'succeeded', { isCurrent: false })]).attentions).toEqual([])
  })

  it('matches the session key the hand-off embedded in workbench_session_id', () => {
    const key = 'b'.repeat(24)
    expect(sessionReferenceMatches(`workbench-user-${key}-0190-work`, key)).toBe(true)
    expect(sessionReferenceMatches(`workbench-user-${'c'.repeat(24)}-work`, key)).toBe(false)
    expect(sessionReferenceMatches(`workbench-user-${key}-work`, 'short')).toBe(false)
  })
})

describe('run attention service', () => {
  const directories: string[] = []
  afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })

  it('returns a finished run to the conversation that handed it over', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'kim-run-attention-'))
    directories.push(stateDirectory)
    const filePath = join(stateDirectory, 'sessions', 'video.jsonl')
    const session = { id: 's1', harness: 'pi', filePath, projectPath: stateDirectory, title: '第1集短片', createdAt: '', updatedAt: '', status: 'idle', depth: 0 } as SessionRecord
    const sessionReference = `workbench-u-${digest(filePath).slice(0, 24)}-work`
    let status = 'running'
    const sent: Array<{ channel: string; target: EnterpriseWorkAttention }> = []
    const notifications: Array<{ title: string; body: string; onClick(): void }> = []
    const service = new RunAttentionService({
      stateDirectory,
      listRecentRunIds: async () => ['r1'],
      lookupRuns: async () => ({ runs: [run('r1', status, { workbenchSessionID: sessionReference })], missing: [] }),
      listSessions: async () => [session],
      sendToRenderer: (channel, target) => { sent.push({ channel, target }); return true },
      isWindowFocused: () => false,
      revealWindow: async () => undefined,
      showSystemNotification: (notification) => { notifications.push(notification) },
      intervalMs: 60_000,
    })
    service.setAccount('account-1')
    // The first read seeds the running run without a notice.
    await vi.waitFor(async () => expect(await readdir(stateDirectory)).toContainEqual(expect.stringMatching(/\.json$/)))
    expect(sent).toEqual([])
    await service.resolveSession(sessionReference).then((target) => expect(target).toEqual({ id: 's1', harness: 'pi', filePath }))

    status = 'succeeded'
    service.pollSoon()
    await vi.waitFor(() => expect(notifications).toHaveLength(1))
    expect(notifications[0]).toMatchObject({ title: '团队工作已完成', body: '「第1集短片」· 回到对话查看' })
    expect(sent[0]).toMatchObject({ channel: 'enterprise:work-attention', target: { runId: 'r1', kind: 'succeeded', session: { id: 's1' } } })

    notifications[0]!.onClick()
    await vi.waitFor(() => expect(sent.at(-1)?.channel).toBe('enterprise:open-work-session'))
    expect(service.takePendingOpen()).toMatchObject({ runId: 'r1', session: { id: 's1' } })
    expect(service.takePendingOpen()).toBeUndefined()
    service.stop()
  })
})
