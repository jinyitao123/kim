import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AutomationService, type AutomationServiceOptions } from '../../electron/main/schedules/service'
import { defaultSettings, JsonStateStore, type PersistedProject } from '../../electron/main/store'
import type { AutomationScheduleRecord, ScheduleTarget } from '../../src/types/api'

const dirs: string[] = []
const stores: JsonStateStore[] = []
const ownerA = 'a'.repeat(64)
const ownerB = 'b'.repeat(64)
const execution = { model: 'auto', thinking: 'auto', speed: 'normal' } as const
const targetA: ScheduleTarget = { kind: 'project', projectId: 'project-a' }
const targetB: ScheduleTarget = { kind: 'project', projectId: 'project-b' }
const onceAt = (at: string) => ({ kind: 'once' as const, at })

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.beginShutdown()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function project(id: string, accountScope?: string): PersistedProject {
  return {
    id, harness: 'prime', name: id, path: `/tmp/${id}`, folders: [`/tmp/${id}`], primaryFolder: `/tmp/${id}`,
    pinned: false, createdAt: '2029-01-01T00:00:00.000Z', lastOpenedAt: '2029-01-01T00:00:00.000Z', accountScope,
  }
}

function stateFile(raw?: unknown): { dir: string; path: string; store: JsonStateStore } {
  const dir = mkdtempSync(join(tmpdir(), 'gooeypi-schedule-account-scope-'))
  dirs.push(dir)
  const path = join(dir, 'state.json')
  if (raw !== undefined) writeFileSync(path, JSON.stringify(raw))
  return { dir, path, store: trackedStore(path) }
}

function trackedStore(path: string): JsonStateStore {
  const store = new JsonStateStore(path)
  stores.push(store)
  return store
}

function serviceFor(store: JsonStateStore, initialOwnerScope: string | null, run: AutomationServiceOptions['run'] = async () => ({}), now = () => new Date('2030-01-01T00:00:00.000Z'), accountScopeDrainTimeoutMs = 30_000) {
  return new AutomationService(store, {
    initialOwnerScope, accountScopeDrainTimeoutMs,
    validateTarget: async () => undefined,
    validateExecution: async () => undefined,
    run,
    now,
  })
}

async function eventually(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    try { assertion(); return } catch { await new Promise((resolve) => setTimeout(resolve, 10)) }
  }
  assertion()
}

describe('scheduled task account ownership', () => {
  it('keeps A and B list, detail, management, and due execution in the verified active scope', async () => {
    const { store } = stateFile()
    await store.update((state) => { state.projects.push(project('project-a', ownerA), project('project-b', ownerB)) })
    let now = new Date('2030-01-01T00:00:00.000Z')
    let activeScope = ownerA
    const executions: Array<{ id: string; ownerScope: string | null }> = []
    const run = vi.fn(async (task: AutomationScheduleRecord) => { executions.push({ id: task.id, ownerScope: activeScope }); return {} })
    const service = serviceFor(store, ownerA, run, () => now)
    await service.start()
    const taskA = await service.create({ prompt: 'A plan', target: targetA, timing: onceAt('2030-01-02T00:00:00Z'), execution })
    expect(taskA.ownerMigrationState).toBe('bound')
    expect(taskA).not.toHaveProperty('ownerScope')
    expect(service.list().map(({ id }) => id)).toEqual([taskA.id])

    expect(await service.beginAccountScopeTransition()).toBe(true)
    activeScope = ownerB
    await service.completeAccountScopeTransition(ownerB)
    expect(service.list()).toEqual([])
    expect(() => service.get(taskA.id)).toThrow('not found')
    await expect(service.pause(taskA.id)).rejects.toThrow('not found')
    await expect(service.update(taskA.id, { revision: taskA.revision, title: 'B edits A' })).rejects.toThrow('not found')
    await expect(service.runNow(taskA.id)).rejects.toThrow('not found')
    await expect(service.delete(taskA.id)).rejects.toThrow('not found')

    const taskB = await service.create({ prompt: 'B plan', target: targetB, timing: onceAt('2030-01-02T00:00:00Z'), execution })
    expect(service.list().map(({ id }) => id)).toEqual([taskB.id])
    now = new Date('2030-01-02T00:00:15.000Z')
    await (service as unknown as { processDue(): Promise<void> }).processDue()
    await eventually(() => expect(executions.map(({ id }) => id)).toContain(taskB.id))
    expect(executions).toEqual([{ id: taskB.id, ownerScope: ownerB }])
    expect(store.snapshot().schedules.find(({ id }) => id === taskA.id)?.runs).toEqual([])

    expect(await service.beginAccountScopeTransition()).toBe(true)
    activeScope = ownerA
    await service.completeAccountScopeTransition(ownerA)
    await (service as unknown as { processDue(): Promise<void> }).processDue()
    await eventually(() => expect(executions.map(({ id }) => id)).toContain(taskA.id))
    expect(executions).toEqual([{ id: taskB.id, ownerScope: ownerB }, { id: taskA.id, ownerScope: ownerA }])
    await service.stop()
  })

  it('reads the same A-owned plan after restart without exposing it to B', async () => {
    const { path, store } = stateFile()
    await store.update((state) => { state.projects.push(project('project-a', ownerA)) })
    const first = serviceFor(store, ownerA)
    await first.start()
    const created = await first.create({ prompt: 'Persistent A plan', target: targetA, timing: onceAt('2040-01-01T00:00:00Z'), execution })
    await first.stop()

    const reopenedStore = trackedStore(path)
    const reopened = serviceFor(reopenedStore, ownerB)
    await reopened.start()
    expect(reopened.list()).toEqual([])
    expect(() => reopened.get(created.id)).toThrow('not found')
    expect(reopenedStore.snapshot().scheduleOwnerships).toContainEqual({ scheduleId: created.id, ownerScope: ownerA, state: 'bound' })

    expect(await reopened.beginAccountScopeTransition()).toBe(true)
    await reopened.completeAccountScopeTransition(ownerA)
    expect(reopened.get(created.id)).toMatchObject({ id: created.id, prompt: 'Persistent A plan', ownerMigrationState: 'bound' })
    await reopened.stop()
  })

  it('migrates only an exact persisted target owner and preserves unresolved schedule records for review', async () => {
    const legacyA: AutomationScheduleRecord = {
      schemaVersion: 1, id: 'legacy-a', harness: 'prime', revision: 3, title: 'A legacy plan', prompt: 'A private prompt',
      target: { kind: 'project', projectId: 'project-a' }, timing: onceAt('2030-01-02T00:00:00Z'), execution,
      status: 'active', createdBy: 'user', createdAt: '2029-01-01T00:00:00.000Z', updatedAt: '2029-01-02T00:00:00.000Z',
      nextRunAt: '2030-01-02T00:00:00.000Z', runs: [],
    }
    const orphan: AutomationScheduleRecord = { ...legacyA, id: 'legacy-orphan', title: 'Unowned plan', target: { kind: 'project', projectId: 'legacy-unscoped' } }
    const ambiguous: AutomationScheduleRecord = { ...legacyA, id: 'legacy-ambiguous', title: 'Ambiguous plan', target: { kind: 'project', projectId: 'duplicate-id' } }
    const sourceSchedules = structuredClone([legacyA, orphan, ambiguous])
    const raw = {
      version: 4, projects: [project('project-a', ownerA), project('legacy-unscoped'), project('duplicate-id', ownerB), project('duplicate-id')],
      settings: defaultSettings(), archivedSessions: [], dismissedProjectPaths: [], schedules: sourceSchedules,
    }
    const { store } = stateFile(raw)
    const service = serviceFor(store, ownerB)
    await service.start()

    const persisted = store.snapshot()
    expect(persisted.version).toBe(6)
    expect(persisted.schedules).toEqual(sourceSchedules)
    expect(persisted.scheduleOwnerships).toEqual([
      { scheduleId: 'legacy-a', ownerScope: ownerA, state: 'migrated' },
      { scheduleId: 'legacy-orphan', ownerScope: null, state: 'needs_review', originalStatus: 'active' },
      { scheduleId: 'legacy-ambiguous', ownerScope: null, state: 'needs_review', originalStatus: 'active' },
    ])
    expect(service.list()).toEqual([])
    await (service as unknown as { processDue(): Promise<void> }).processDue()
    expect(service.list()).toEqual([])

    expect(await service.beginAccountScopeTransition()).toBe(true)
    await service.completeAccountScopeTransition(undefined)
    const review = service.list().find(({ id }) => id === orphan.id)
    expect(review).toMatchObject({ status: 'blocked', ownerMigrationState: 'needs_review', blockedReason: expect.stringContaining('不会自动运行') })
    expect(review).toEqual(expect.not.objectContaining({ ownerScope: expect.anything() }))
    await expect(service.runNow(orphan.id)).rejects.toThrow('账号归属无法核验')
    await (service as unknown as { processDue(): Promise<void> }).processDue()
    expect(store.snapshot().schedules).toEqual(sourceSchedules)
    await service.stop()
  })

  it('keeps queued A runs dormant across B and applies a bounded drain before scope replacement', async () => {
    const { store } = stateFile()
    await store.update((state) => { state.projects.push(project('project-a', ownerA)) })
    let activeScope = ownerA
    const releases: Array<() => void> = []
    const run = vi.fn((task: AutomationScheduleRecord) => new Promise<Record<string, never>>((resolve) => {
      const capturedScope = activeScope
      releases.push(() => { expect(activeScope).toBe(capturedScope); resolve({}) })
      if (task.ownerMigrationState) throw new Error('internal migration state leaked to execution')
    }))
    const service = serviceFor(store, ownerA, run, () => new Date('2030-01-01T00:00:00.000Z'), 10)
    await service.start()
    const task = await service.create({ prompt: 'Queued A plan', target: targetA, timing: onceAt('2040-01-01T00:00:00Z'), execution })
    await service.runNow(task.id); await service.runNow(task.id); await service.runNow(task.id)
    await eventually(() => expect(run).toHaveBeenCalledTimes(2))

    expect(await service.beginAccountScopeTransition()).toBe(false)
    releases[0](); releases[1]()
    expect(await service.waitForAccountScopeDrain(1_000)).toBe(true)
    activeScope = ownerB
    await service.completeAccountScopeTransition(ownerB)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(run).toHaveBeenCalledTimes(2)

    expect(await service.beginAccountScopeTransition()).toBe(true)
    activeScope = ownerA
    await service.completeAccountScopeTransition(ownerA)
    await eventually(() => expect(run).toHaveBeenCalledTimes(3))
    releases[2]()
    await eventually(() => expect(service.get(task.id).runs.filter(({ status }) => status === 'succeeded')).toHaveLength(3))
    expect(run.mock.calls.map(([scheduledTask]) => scheduledTask.id)).toEqual([task.id, task.id, task.id])
    await service.stop()
  })

  it('bounds shutdown waiting and marks an unfinished persisted run interrupted after reopen', async () => {
    const { path, store } = stateFile()
    await store.update((state) => { state.projects.push(project('project-a', ownerA)) })
    const run = vi.fn(() => new Promise<Record<string, never>>(() => undefined))
    const service = serviceFor(store, ownerA, run, () => new Date('2030-01-01T00:00:00.000Z'), 10)
    await service.start()
    const task = await service.create({ prompt: 'Long A plan', target: targetA, timing: onceAt('2040-01-01T00:00:00Z'), execution })
    await service.runNow(task.id)
    await eventually(() => expect(run).toHaveBeenCalledOnce())

    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await service.stop()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('marked interrupted on next launch.'))
    expect(store.snapshot().schedules.find(({ id }) => id === task.id)?.runs[0].status).toBe('running')
    log.mockRestore()

    const reopened = serviceFor(trackedStore(path), ownerA)
    await reopened.start()
    expect(reopened.get(task.id).runs[0]).toMatchObject({ status: 'interrupted', error: 'GooeyPi quit before this run could finish.' })
    await reopened.stop()
  })
})
