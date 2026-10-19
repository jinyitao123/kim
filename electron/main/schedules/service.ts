import { randomUUID } from 'node:crypto'
import { PRIME_THINKING_LEVELS } from '../../../src/types/api'
import type {
  PrimeThinkingLevel,
  ScheduleChangeEvent,
  ScheduleExecution,
  ScheduleInput,
  SchedulePatch,
  SchedulePreview,
  AutomationScheduleRecord, 
  ScheduleRunRecord,
  ScheduleTarget,
  ScheduleTiming,
  HarnessId,
} from '../../../src/types/api'
import type { JsonStateStore, PersistedSchedule } from '../store'
import type { PersistedScheduleOwnership } from './ownership'
import { findScheduleOwnership, isScheduleBoundToScope, migrateLegacyScheduleOwnerships, OWNER_SCOPE_PATTERN, publicSchedule, REVIEW_REQUIRED_REASON } from './ownership'
import { rejectUnknownKeys, requireId, requireRecord, requireString } from '../validation'
import {
  countMissedOccurrences,
  nextScheduleOccurrence,
  previewScheduleOccurrences,
  validateScheduleTiming,
} from './recurrence'

const MAX_TASKS = 500
const MAX_CONCURRENT_RUNS = 2
const DUE_GRACE_MS = 60_000
const THINKING_LEVELS: ReadonlySet<string> = new Set(['auto', ...PRIME_THINKING_LEVELS])

function isSupportedSchedule(task: PersistedSchedule): task is PersistedSchedule & { harness: HarnessId } {
  return task.harness !== 'omp'
}

export class ScheduleBlockedError extends Error {}

export interface ScheduleRunResult {
  sessionId?: string
  sessionFile?: string
}

export interface AutomationServiceOptions {
  /** Trusted scope supplied by the main process from the verified EnterpriseService session. */
  initialOwnerScope?: string | null
  /** Graceful account change; after this bound, the main process stops runtimes and waits once more. */
  accountScopeDrainTimeoutMs?: number
  validateTarget(target: ScheduleTarget, harness: HarnessId): Promise<void>
  validateExecution(execution: ScheduleExecution, harness: HarnessId): Promise<void>
  validatePrompt?(prompt: string, harness: HarnessId): void
  run(task: AutomationScheduleRecord): Promise<ScheduleRunResult>
  now?: () => Date
}

function titleFromPrompt(prompt: string): string {
  return prompt.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Scheduled task'
}

function parseTarget(value: unknown): ScheduleTarget {
  const target = requireRecord(value, 'target')
  const kind = requireString(target.kind, 'target.kind', { min: 1, max: 16 })
  if (kind === 'project') {
    rejectUnknownKeys(target, ['kind', 'projectId'], 'target')
    return { kind, projectId: requireId(target.projectId, 'target.projectId') }
  }
  if (kind === 'session') {
    rejectUnknownKeys(target, ['kind', 'projectId', 'sessionId'], 'target')
    return { kind, projectId: requireId(target.projectId, 'target.projectId'), sessionId: requireId(target.sessionId, 'target.sessionId') }
  }
  throw new TypeError('Invalid schedule target')
}

function parseExecution(value: unknown): ScheduleExecution {
  const execution = requireRecord(value, 'execution')
  rejectUnknownKeys(execution, ['model', 'thinking', 'speed'], 'execution')
  const model = requireString(execution.model, 'execution.model', { min: 1, max: 512, trim: true })
  const thinking = requireString(execution.thinking, 'execution.thinking', { min: 1, max: 16, trim: true })
  if (!THINKING_LEVELS.has(thinking)) throw new TypeError('Invalid scheduled reasoning level')
  if (execution.speed !== 'normal' && execution.speed !== 'fast') throw new TypeError('Invalid scheduled speed')
  return { model, thinking: thinking as 'auto' | PrimeThinkingLevel, speed: execution.speed }
}

function parseTiming(value: unknown, now: Date): ScheduleTiming {
  const timing = requireRecord(value, 'timing')
  if (timing.kind === 'once') {
    rejectUnknownKeys(timing, ['kind', 'at'], 'timing')
    return validateScheduleTiming({ kind: 'once', at: requireString(timing.at, 'timing.at', { min: 1, max: 64, trim: true }) }, { now })
  }
  if (timing.kind === 'rrule') {
    rejectUnknownKeys(timing, ['kind', 'dtstartLocal', 'timeZone', 'rrule'], 'timing')
    return validateScheduleTiming({
      kind: 'rrule',
      dtstartLocal: requireString(timing.dtstartLocal, 'timing.dtstartLocal', { min: 1, max: 64, trim: true }),
      timeZone: requireString(timing.timeZone, 'timing.timeZone', { min: 1, max: 128, trim: true }),
      rrule: requireString(timing.rrule, 'timing.rrule', { min: 1, max: 2_048, trim: true }),
    }, { now })
  }
  throw new TypeError('Invalid schedule timing')
}

function parseInput(value: unknown, now: Date): Omit<ScheduleInput, 'createdBy'> {
  const input = requireRecord(value, 'schedule')
  rejectUnknownKeys(input, ['title', 'prompt', 'target', 'timing', 'execution'], 'schedule')
  const prompt = requireString(input.prompt, 'prompt', { min: 1, max: 1024 * 1024, trim: true })
  const title = input.title === undefined ? undefined : requireString(input.title, 'title', { min: 1, max: 200, trim: true })
  return { title, prompt, target: parseTarget(input.target), timing: parseTiming(input.timing, now), execution: parseExecution(input.execution) }
}

function parsePatch(value: unknown, now: Date): SchedulePatch {
  const patch = requireRecord(value, 'schedule patch')
  rejectUnknownKeys(patch, ['revision', 'title', 'prompt', 'target', 'timing', 'execution'], 'schedule patch')
  if (!Number.isSafeInteger(patch.revision) || Number(patch.revision) < 1) throw new TypeError('Invalid schedule revision')
  return {
    revision: Number(patch.revision),
    title: patch.title === undefined ? undefined : requireString(patch.title, 'title', { min: 1, max: 200, trim: true }),
    prompt: patch.prompt === undefined ? undefined : requireString(patch.prompt, 'prompt', { min: 1, max: 1024 * 1024, trim: true }),
    target: patch.target === undefined ? undefined : parseTarget(patch.target),
    timing: patch.timing === undefined ? undefined : parseTiming(patch.timing, now),
    execution: patch.execution === undefined ? undefined : parseExecution(patch.execution),
  }
}

function cloneTask(task: AutomationScheduleRecord): AutomationScheduleRecord { return structuredClone(task) }

interface QueuedRun {
  task: AutomationScheduleRecord
  runId: string
  ownerScope: string | null
}

export class AutomationService {
  private readonly listeners = new Set<(event: ScheduleChangeEvent) => void>()
  private readonly now: () => Date
  private timer: NodeJS.Timeout | null = null
  private closed = false
  private activeRuns = 0
  private readonly idleWaiters = new Set<() => void>()
  private readonly pending: QueuedRun[] = []
  private ownerScope: string | null
  private ownerScopeRevision = 0
  private ownerScopeReady = true
  private readonly accountScopeDrainTimeoutMs: number

  constructor(private readonly store: JsonStateStore, private readonly options: AutomationServiceOptions) {
    this.now = options.now ?? (() => new Date())
    this.ownerScope = options.initialOwnerScope ?? null
    this.accountScopeDrainTimeoutMs = options.accountScopeDrainTimeoutMs ?? 30_000
  }

  private assertOwnerScopeReady(): void {
    if (this.closed || !this.ownerScopeReady) throw new Error('账号正在切换，计划暂不可用。')
  }

  private requireBoundOwnership(state: ReturnType<JsonStateStore['snapshot']>, scheduleId: string, ownerScope = this.ownerScope): PersistedScheduleOwnership {
    this.assertOwnerScopeReady()
    const ownership = findScheduleOwnership(state.scheduleOwnerships, scheduleId)
    if (!ownership || ownership.state === 'needs_review' || ownership.ownerScope !== ownerScope) {
      throw new Error(ownership?.state === 'needs_review' ? REVIEW_REQUIRED_REASON : 'Scheduled task was not found')
    }
    return ownership
  }

  private assertScopeRevision(expectedRevision: number, expectedOwnerScope: string | null): void {
    if (!this.ownerScopeReady || this.ownerScopeRevision !== expectedRevision || this.ownerScope !== expectedOwnerScope) {
      throw new Error('账号切换中，请稍后重试。')
    }
  }

  private waitForActiveRuns(timeoutMs: number): Promise<boolean> {
    if (this.activeRuns === 0) return Promise.resolve(true)
    return new Promise((resolveWait) => {
      let settled = false
      let timer: NodeJS.Timeout | undefined
      const finish = (result: boolean) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        this.idleWaiters.delete(onIdle)
        resolveWait(result)
      }
      const onIdle = () => finish(true)
      this.idleWaiters.add(onIdle)
      if (Number.isFinite(timeoutMs)) timer = setTimeout(() => finish(false), Math.max(0, timeoutMs))
    })
  }

  private settleRunWaiters(): void {
    if (this.activeRuns !== 0) return
    for (const resolveIdle of this.idleWaiters) resolveIdle()
    this.idleWaiters.clear()
  }

  async start(): Promise<void> {
    this.closed = false
    const initial = this.store.snapshot()
    const knownOwners = new Set(initial.scheduleOwnerships.map(({ scheduleId }) => scheduleId))
    if (initial.schedules.some((task) => isSupportedSchedule(task) && !knownOwners.has(task.id))) {
      await this.store.update((state) => migrateLegacyScheduleOwnerships(state))
    }
    await this.reconcileInterruptedRuns()
    await this.blockInvalidActivePrompts(this.ownerScope)
    await this.recoverMissed(this.ownerScopeRevision)
    this.armTimer()
  }

  /** Prevent new claims before the main process changes project and session roots. */
  async beginAccountScopeTransition(): Promise<boolean> {
    this.ownerScopeReady = false
    this.ownerScopeRevision += 1
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    return this.waitForActiveRuns(this.accountScopeDrainTimeoutMs)
  }

  /** Called only after the main process has installed the matching verified account roots. */
  async completeAccountScopeTransition(ownerScope: string | undefined): Promise<void> {
    if (ownerScope !== undefined && !OWNER_SCOPE_PATTERN.test(ownerScope)) throw new TypeError('Invalid verified account scope')
    this.ownerScope = ownerScope ?? null
    this.ownerScopeRevision += 1
    const revision = this.ownerScopeRevision
    this.ownerScopeReady = false
    await this.blockInvalidActivePrompts(this.ownerScope, revision)
    await this.recoverMissed(revision)
    this.ownerScopeReady = true
    this.changed({ reason: 'updated' })
    this.armTimer()
    this.drain()
  }

  /** Bounded second wait used after the main process has stopped runtimes on a long task. */
  waitForAccountScopeDrain(timeoutMs = this.accountScopeDrainTimeoutMs): Promise<boolean> {
    return this.waitForActiveRuns(timeoutMs)
  }

  private async blockInvalidActivePrompts(ownerScope: string | null, expectedRevision = this.ownerScopeRevision): Promise<void> {
    if (!this.options.validatePrompt) return
    const updatedAt = this.now().toISOString()
    await this.store.update((state) => {
      for (const task of state.schedules) {
        if (!isSupportedSchedule(task)) continue
        if (this.ownerScopeRevision !== expectedRevision || !isScheduleBoundToScope(state, task.id, ownerScope)) continue
        if (task.status !== 'active') continue
        try { this.options.validatePrompt!(task.prompt, task.harness) }
        catch (error) {
          if (!(error instanceof TypeError)) throw error
          task.status = 'blocked'
          task.blockedReason = error.message
          task.nextRunAt = undefined
          task.revision += 1
          task.updatedAt = updatedAt
        }
      }
    })
  }

  /**
   * Runs persisted as queued/running belong to a previous process; they will
   * never resume, so surface them as interrupted instead of forever-pending.
   */
  private async reconcileInterruptedRuns(): Promise<void> {
    const finishedAt = this.now().toISOString()
    await this.store.update((state) => {
      for (const task of state.schedules) {
        if (!isSupportedSchedule(task)) continue
        const ownership = findScheduleOwnership(state.scheduleOwnerships, task.id)
        if (!ownership || ownership.state === 'needs_review') continue
        for (const run of task.runs) {
          if (run.status !== 'queued' && run.status !== 'running') continue
          run.status = 'interrupted'
          run.finishedAt = finishedAt
          run.error = 'GooeyPi quit before this run could finish.'
        }
      }
    })
  }

  async stop(): Promise<void> {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending.splice(0)
    if (!await this.waitForActiveRuns(this.accountScopeDrainTimeoutMs)) {
      console.error('Scheduled runs did not stop before shutdown; unfinished history will be marked interrupted on next launch.')
    }
  }

  onDidChange(listener: (event: ScheduleChangeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  hasActiveSchedules(): boolean {
    if (this.closed || !this.ownerScopeReady) return false
    const state = this.store.snapshot()
    return state.schedules.some((task) => isSupportedSchedule(task) && task.status === 'active' && isScheduleBoundToScope(state, task.id, this.ownerScope))
  }

  list(harness?: HarnessId): AutomationScheduleRecord[] {
    this.assertOwnerScopeReady()
    const state = this.store.snapshot()
    return state.schedules.filter(isSupportedSchedule).filter((task) => {
      if (harness !== undefined && task.harness !== harness) return false
      const ownership = findScheduleOwnership(state.scheduleOwnerships, task.id)
      if (ownership?.state === 'needs_review') return this.ownerScope === null
      return ownership?.ownerScope === this.ownerScope && (ownership.state === 'bound' || ownership.state === 'migrated')
    }).map((task) => publicSchedule(task, findScheduleOwnership(state.scheduleOwnerships, task.id)!)).sort((left, right) => {
      const next = (left.nextRunAt ?? 'z').localeCompare(right.nextRunAt ?? 'z')
      return next || right.updatedAt.localeCompare(left.updatedAt)
    })
  }

  get(idValue: unknown): AutomationScheduleRecord {
    this.assertOwnerScopeReady()
    const id = requireId(idValue, 'schedule id')
    const state = this.store.snapshot()
    const task = state.schedules.find((candidate) => candidate.id === id)
    const ownership = findScheduleOwnership(state.scheduleOwnerships, id)
    if (!task || !isSupportedSchedule(task) || !ownership) throw new Error('Scheduled task was not found')
    if (ownership.state === 'needs_review') {
      if (this.ownerScope !== null) throw new Error('Scheduled task was not found')
      return publicSchedule(task, ownership)
    }
    if (ownership.ownerScope !== this.ownerScope) throw new Error('Scheduled task was not found')
    return publicSchedule(task, ownership)
  }

  private boundTask(idValue: unknown): { task: AutomationScheduleRecord; ownership: PersistedScheduleOwnership; ownerScope: string | null; scopeRevision: number } {
    this.assertOwnerScopeReady()
    const id = requireId(idValue, 'schedule id')
    const state = this.store.snapshot()
    const task = state.schedules.find((candidate) => candidate.id === id)
    if (!task || !isSupportedSchedule(task)) throw new Error('Scheduled task was not found')
    const ownership = this.requireBoundOwnership(state, id)
    return { task, ownership, ownerScope: this.ownerScope, scopeRevision: this.ownerScopeRevision }
  }

  preview(timingValue: unknown, countValue: unknown = 3): SchedulePreview {
    const count = Number(countValue)
    if (!Number.isSafeInteger(count) || count < 1 || count > 10) throw new TypeError('Preview count must be between 1 and 10')
    const now = this.now()
    const timing = parseTiming(timingValue, now)
    return { timing, occurrences: previewScheduleOccurrences(timing, count, now) }
  }

  async create(inputValue: unknown, createdBy: 'user' | 'agent' = 'user', harness: HarnessId = 'prime'): Promise<AutomationScheduleRecord> {
    this.assertOwnerScopeReady()
    const ownerScope = this.ownerScope
    const scopeRevision = this.ownerScopeRevision
    const now = this.now()
    const input = parseInput(inputValue, now)
    this.options.validatePrompt?.(input.prompt, harness)
    await Promise.all([this.options.validateTarget(input.target, harness), this.options.validateExecution(input.execution, harness)])
    this.assertScopeRevision(scopeRevision, ownerScope)
    const nextRunAt = nextScheduleOccurrence(input.timing, new Date(now.getTime() - 1))
    if (!nextRunAt) throw new TypeError('Schedule has no future occurrence')
    const task: AutomationScheduleRecord = {
      schemaVersion: 1,
      id: randomUUID(),
      harness,
      revision: 1,
      title: input.title ?? titleFromPrompt(input.prompt),
      prompt: input.prompt,
      target: input.target,
      timing: input.timing,
      execution: input.execution,
      status: 'active',
      createdBy,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      nextRunAt,
      runs: [],
    }
    const ownership: PersistedScheduleOwnership = { scheduleId: task.id, ownerScope, state: 'bound' }
    await this.store.update((state) => {
      this.assertScopeRevision(scopeRevision, ownerScope)
      if (state.schedules.length >= MAX_TASKS) throw new Error(`GooeyPi supports at most ${MAX_TASKS} scheduled tasks`)
      state.schedules.push(task)
      state.scheduleOwnerships.push(ownership)
    })
    this.assertScopeRevision(scopeRevision, ownerScope)
    this.changed({ taskId: task.id, reason: 'created' })
    this.armTimer()
    return publicSchedule(task, ownership)
  }

  async update(idValue: unknown, patchValue: unknown): Promise<AutomationScheduleRecord> {
    const { task: current, ownership, ownerScope, scopeRevision } = this.boundTask(idValue)
    const id = current.id
    const now = this.now()
    const patch = parsePatch(patchValue, now)
    if (current.revision !== patch.revision) throw new Error('Scheduled task changed; reload it before saving')
    const target = patch.target ?? current.target
    const execution = patch.execution ?? current.execution
    const prompt = patch.prompt ?? current.prompt
    this.options.validatePrompt?.(prompt, current.harness)
    await Promise.all([this.options.validateTarget(target, current.harness), this.options.validateExecution(execution, current.harness)])
    this.assertScopeRevision(scopeRevision, ownerScope)
    const timing = patch.timing ?? current.timing
    const nextRunAt = nextScheduleOccurrence(timing, new Date(now.getTime() - 1))
    if (!nextRunAt) throw new TypeError('Schedule has no future occurrence')
    let updated!: AutomationScheduleRecord
    await this.store.update((state) => {
      this.assertScopeRevision(scopeRevision, ownerScope)
      const task = state.schedules.find((candidate) => candidate.id === id)
      if (!task || !isSupportedSchedule(task)) throw new Error('Scheduled task was not found')
      this.requireBoundOwnership(state, id, ownerScope)
      if (task.revision !== patch.revision) throw new Error('Scheduled task changed; reload it before saving')
      updated = {
        ...task,
        revision: task.revision + 1,
        title: patch.title ?? task.title,
        prompt,
        target,
        timing,
        execution,
        status: 'active',
        blockedReason: undefined,
        updatedAt: now.toISOString(),
        nextRunAt,
      }
      Object.assign(task, updated)
    })
    this.assertScopeRevision(scopeRevision, ownerScope)
    this.changed({ taskId: id, reason: 'updated' })
    this.armTimer()
    return publicSchedule(updated, ownership)
  }

  async pause(idValue: unknown): Promise<AutomationScheduleRecord> { return this.setStatus(idValue, 'paused') }

  async resume(idValue: unknown): Promise<AutomationScheduleRecord> {
    const { task: current, ownership, ownerScope, scopeRevision } = this.boundTask(idValue)
    const id = current.id
    const now = this.now()
    this.options.validatePrompt?.(current.prompt, current.harness)
    await Promise.all([this.options.validateTarget(current.target, current.harness), this.options.validateExecution(current.execution, current.harness)])
    this.assertScopeRevision(scopeRevision, ownerScope)
    const nextRunAt = nextScheduleOccurrence(current.timing, new Date(now.getTime() - 1))
    if (!nextRunAt) throw new Error('This schedule has no future occurrence')
    let updated!: AutomationScheduleRecord
    await this.store.update((state) => {
      this.assertScopeRevision(scopeRevision, ownerScope)
      const task = state.schedules.find((candidate) => candidate.id === id)
      if (!task || !isSupportedSchedule(task)) throw new Error('Scheduled task was not found')
      this.requireBoundOwnership(state, id, ownerScope)
      task.status = 'active'
      task.blockedReason = undefined
      task.nextRunAt = nextRunAt
      task.revision += 1
      task.updatedAt = now.toISOString()
      updated = cloneTask(task)
    })
    this.assertScopeRevision(scopeRevision, ownerScope)
    this.changed({ taskId: id, reason: 'updated' })
    this.armTimer()
    return publicSchedule(updated, ownership)
  }

  /**
   * Deleting a task cancels work that has not started. A run that already
   * crossed the persisted `running` transition is allowed to finish because
   * schedule executors do not expose a reliable cancellation primitive.
   */
  async delete(idValue: unknown): Promise<boolean> {
    const { task, ownerScope, scopeRevision } = this.boundTask(idValue)
    const id = task.id
    const removed = await this.store.update((state) => {
      this.assertScopeRevision(scopeRevision, ownerScope)
      this.requireBoundOwnership(state, id, ownerScope)
      const index = state.schedules.findIndex((candidate) => candidate.id === id && isSupportedSchedule(candidate))
      if (index < 0) return false
      state.schedules.splice(index, 1)
      state.scheduleOwnerships = state.scheduleOwnerships.filter((candidate) => candidate.scheduleId !== id)
      return true
    })
    this.assertScopeRevision(scopeRevision, ownerScope)
    if (removed) {
      for (let index = this.pending.length - 1; index >= 0; index -= 1) {
        if (this.pending[index].task.id === id) this.pending.splice(index, 1)
      }
      this.changed({ taskId: id, reason: 'deleted' })
    }
    this.armTimer()
    return removed
  }

  async runNow(idValue: unknown): Promise<ScheduleRunRecord> {
    const { task, ownerScope, scopeRevision } = this.boundTask(idValue)
    this.options.validatePrompt?.(task.prompt, task.harness)
    await Promise.all([this.options.validateTarget(task.target, task.harness), this.options.validateExecution(task.execution, task.harness)])
    this.assertScopeRevision(scopeRevision, ownerScope)
    return this.enqueue(task, ownerScope, scopeRevision, 'manual', this.now().toISOString())
  }

  private async setStatus(idValue: unknown, status: 'paused'): Promise<AutomationScheduleRecord> {
    const { task, ownerScope, scopeRevision, ownership } = this.boundTask(idValue)
    const id = task.id
    const now = this.now().toISOString()
    let updated!: AutomationScheduleRecord
    await this.store.update((state) => {
      this.assertScopeRevision(scopeRevision, ownerScope)
      this.requireBoundOwnership(state, id, ownerScope)
      const task = state.schedules.find((candidate) => candidate.id === id)
      if (!task || !isSupportedSchedule(task)) throw new Error('Scheduled task was not found')
      task.status = status
      task.nextRunAt = undefined
      task.blockedReason = undefined
      task.revision += 1
      task.updatedAt = now
      updated = cloneTask(task)
    })
    this.assertScopeRevision(scopeRevision, ownerScope)
    this.changed({ taskId: id, reason: 'updated' })
    this.armTimer()
    return publicSchedule(updated, ownership)
  }

  private armTimer(): void {
    if (this.closed || !this.ownerScopeReady) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const state = this.store.snapshot()
    const next = state.schedules
      .filter((task) => isSupportedSchedule(task) && task.status === 'active' && task.nextRunAt && isScheduleBoundToScope(state, task.id, this.ownerScope))
      .map((task) => Date.parse(task.nextRunAt!))
      .filter(Number.isFinite)
      .reduce<number | undefined>((earliest, value) => earliest === undefined || value < earliest ? value : earliest, undefined)
    if (next === undefined) return
    const delay = Math.max(0, Math.min(2_147_483_647, next - this.now().getTime()))
    this.timer = setTimeout(() => {
      this.timer = null
      const revision = this.ownerScopeRevision
      void this.processDue(revision)
        .catch((error) => console.error('Scheduled task processing failed:', error))
        .finally(() => this.armTimer())
    }, delay)
    this.timer.unref()
  }

  private async recoverMissed(expectedRevision: number): Promise<void> {
    const now = this.now()
    const state = this.store.snapshot()
    const snapshot = state.schedules.filter(isSupportedSchedule).filter((task) => isScheduleBoundToScope(state, task.id, this.ownerScope))
    for (const task of snapshot) {
      if (this.ownerScopeRevision !== expectedRevision) return
      if (task.status !== 'active' || !task.nextRunAt || Date.parse(task.nextRunAt) >= now.getTime() - DUE_GRACE_MS) continue
      await this.skipMissed(task, now, expectedRevision, this.ownerScope)
    }
  }

  private async processDue(expectedRevision = this.ownerScopeRevision): Promise<void> {
    if (!this.isScopeCurrent(this.ownerScope, expectedRevision)) return
    const now = this.now()
    const state = this.store.snapshot()
    const due = state.schedules
      .filter(isSupportedSchedule)
      .filter((task) => task.status === 'active' && task.nextRunAt && Date.parse(task.nextRunAt) <= now.getTime() && isScheduleBoundToScope(state, task.id, this.ownerScope))
      .sort((left, right) => left.nextRunAt!.localeCompare(right.nextRunAt!))
    for (const task of due) {
      if (!this.isScopeCurrent(this.ownerScope, expectedRevision)) return
      if (now.getTime() - Date.parse(task.nextRunAt!) > DUE_GRACE_MS) await this.skipMissed(task, now, expectedRevision, this.ownerScope)
      else await this.claimAndEnqueue(task, now, expectedRevision, this.ownerScope)
    }
  }

  private async skipMissed(snapshot: AutomationScheduleRecord, now: Date, expectedRevision: number, ownerScope: string | null): Promise<void> {
    const scheduledFor = snapshot.nextRunAt
    if (!scheduledFor) return
    const missed = countMissedOccurrences(snapshot.timing, new Date(scheduledFor), now, 10_000)
    const run: ScheduleRunRecord = {
      id: randomUUID(), taskId: snapshot.id, taskRevision: snapshot.revision, trigger: 'scheduled',
      scheduledFor, queuedAt: now.toISOString(), finishedAt: now.toISOString(), status: 'skipped',
      execution: snapshot.execution, skippedCount: Math.max(1, missed), error: 'GooeyPi was not available when this task was due.',
    }
    await this.store.update((state) => {
      if (this.ownerScopeRevision !== expectedRevision || this.ownerScope !== ownerScope || !isScheduleBoundToScope(state, snapshot.id, ownerScope)) return
      const task = state.schedules.find((candidate) => candidate.id === snapshot.id)
      if (!task || !isSupportedSchedule(task) || task.status !== 'active' || task.nextRunAt !== scheduledFor) return
      this.pushRun(task, run)
      const next = nextScheduleOccurrence(task.timing, now)
      if (next) task.nextRunAt = next
      else { task.nextRunAt = undefined; task.status = 'completed' }
      task.updatedAt = now.toISOString()
    })
    this.changed({ taskId: snapshot.id, reason: 'run' })
  }

  private async claimAndEnqueue(snapshot: AutomationScheduleRecord, now: Date, expectedRevision: number, ownerScope: string | null): Promise<void> {
    const scheduledFor = snapshot.nextRunAt
    if (!scheduledFor) return
    let queued: QueuedRun | undefined
    await this.store.update((state) => {
      if (!this.isScopeCurrent(ownerScope, expectedRevision) || !isScheduleBoundToScope(state, snapshot.id, ownerScope)) return
      const task = state.schedules.find((candidate) => candidate.id === snapshot.id)
      if (!task || !isSupportedSchedule(task) || task.status !== 'active' || task.nextRunAt !== scheduledFor) return
      const next = nextScheduleOccurrence(task.timing, new Date(Date.parse(scheduledFor) + 1))
      if (next) task.nextRunAt = next
      else { task.nextRunAt = undefined; task.status = 'completed' }
      task.updatedAt = now.toISOString()
      const run: ScheduleRunRecord = {
        id: randomUUID(), taskId: task.id, taskRevision: task.revision, trigger: 'scheduled', scheduledFor,
        queuedAt: now.toISOString(), status: 'queued', execution: structuredClone(task.execution),
      }
      this.pushRun(task, run)
      queued = { task: cloneTask(task), runId: run.id, ownerScope }
    })
    if (!queued) return
    this.pending.push(queued)
    this.changed({ taskId: queued.task.id, reason: 'run' })
    this.drain()
  }

  private async enqueue(task: AutomationScheduleRecord, ownerScope: string | null, scopeRevision: number, trigger: 'scheduled' | 'manual', scheduledFor: string): Promise<ScheduleRunRecord> {
    this.assertScopeRevision(scopeRevision, ownerScope)
    const now = this.now().toISOString()
    const run: ScheduleRunRecord = {
      id: randomUUID(), taskId: task.id, taskRevision: task.revision, trigger, scheduledFor,
      queuedAt: now, status: 'queued', execution: structuredClone(task.execution),
    }
    await this.store.update((state) => {
      this.assertScopeRevision(scopeRevision, ownerScope)
      this.requireBoundOwnership(state, task.id, ownerScope)
      const current = state.schedules.find((candidate) => candidate.id === task.id)
      if (!current || !isSupportedSchedule(current) || current.revision !== task.revision) throw new Error('Scheduled task changed before its run could start')
      this.pushRun(current, run)
    })
    this.pending.push({ task: cloneTask(task), runId: run.id, ownerScope })
    this.changed({ taskId: task.id, reason: 'run' })
    this.drain()
    return structuredClone(run)
  }

  private drain(): void {
    if (this.closed || !this.ownerScopeReady) return
    while (this.activeRuns < MAX_CONCURRENT_RUNS) {
      const index = this.pending.findIndex((item) => item.ownerScope === this.ownerScope)
      if (index < 0) return
      const [item] = this.pending.splice(index, 1)
      this.activeRuns += 1
      void this.dispatch(item).catch((error) => console.error('Scheduled run bookkeeping failed:', error)).finally(() => {
        this.activeRuns -= 1
        this.settleRunWaiters()
        this.drain()
      })
    }
  }

  private isScopeCurrent(ownerScope: string | null, expectedRevision: number): boolean {
    return !this.closed && this.ownerScopeReady && this.ownerScope === ownerScope && this.ownerScopeRevision === expectedRevision
  }

  private requeue(item: QueuedRun): void {
    if (this.closed || this.pending.some((candidate) => candidate.runId === item.runId)) return
    this.pending.unshift(item)
  }

  private async dispatch(item: QueuedRun): Promise<void> {
    const { task, runId, ownerScope } = item
    const scopeRevision = this.ownerScopeRevision
    if (!this.isScopeCurrent(ownerScope, scopeRevision)) { this.requeue(item); return }
    const startedAt = this.now().toISOString()
    const start = await this.markRunStarted(task.id, runId, task.revision, startedAt, ownerScope, scopeRevision)
    if (start === 'deferred') { this.requeue(item); return }
    if (start === 'cancelled') {
      this.changed({ taskId: task.id, reason: 'run' })
      return
    }
    if (!this.isScopeCurrent(ownerScope, scopeRevision)) {
      await this.deferRun(task.id, runId)
      this.requeue(item)
      return
    }
    try {
      const result = await this.options.run(task)
      await this.updateRun(task.id, runId, { status: 'succeeded', finishedAt: this.now().toISOString(), ...result })
    } catch (reason) {
      const error = reason instanceof Error ? reason.message.slice(0, 4_000) : String(reason).slice(0, 4_000)
      await this.updateRun(task.id, runId, { status: 'failed', finishedAt: this.now().toISOString(), error })
      if (reason instanceof ScheduleBlockedError) {
        await this.store.update((state) => {
          const current = state.schedules.find((candidate) => candidate.id === task.id)
          if (!current || current.revision !== task.revision) return
          current.status = 'blocked'
          current.blockedReason = error
          current.nextRunAt = undefined
          current.updatedAt = this.now().toISOString()
        })
      }
    }
    this.changed({ taskId: task.id, reason: 'run' })
  }

  private async markRunStarted(taskId: string, runId: string, expectedRevision: number, startedAt: string, ownerScope: string | null, scopeRevision: number): Promise<'started' | 'deferred' | 'cancelled'> {
    return this.store.update((state) => {
      if (!this.isScopeCurrent(ownerScope, scopeRevision)) return 'deferred'
      if (!isScheduleBoundToScope(state, taskId, ownerScope)) return 'deferred'
      const task = state.schedules.find((candidate) => candidate.id === taskId)
      if (!task) return 'cancelled'
      const run = task.runs.find((candidate) => candidate.id === runId)
      if (run?.status !== 'queued') return 'cancelled'
      if (run.taskRevision !== expectedRevision || task.revision !== expectedRevision) {
        Object.assign(run, {
          status: 'cancelled', finishedAt: startedAt,
          error: 'Scheduled task changed before this queued run could start.',
        })
        return 'cancelled'
      }
      Object.assign(run, { status: 'running', startedAt })
      return 'started'
    })
  }

  private async deferRun(taskId: string, runId: string): Promise<void> {
    await this.store.update((state) => {
      const run = state.schedules.find((candidate) => candidate.id === taskId)?.runs.find((candidate) => candidate.id === runId)
      if (run?.status !== 'running') return
      Object.assign(run, { status: 'queued', startedAt: undefined, finishedAt: undefined, error: undefined })
    })
  }

  private async updateRun(taskId: string, runId: string, patch: Partial<ScheduleRunRecord>): Promise<void> {
    await this.store.update((state) => {
      const task = state.schedules.find((candidate) => candidate.id === taskId)
      const run = task?.runs.find((candidate) => candidate.id === runId)
      if (run) Object.assign(run, patch)
    })
  }

  private pushRun(task: AutomationScheduleRecord, run: ScheduleRunRecord): void {
    task.runs.push(structuredClone(run))
  }

  private changed(event: ScheduleChangeEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}
