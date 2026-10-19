import type { EnterpriseWorkAttentionKind as RunAttentionKind } from '../../../src/types/api'
import type { WorkbenchRunLookup, WorkbenchRunLookupResponse } from './work-sources'

export type { RunAttentionKind }

export interface RunAttention {
  runId: string
  kind: RunAttentionKind
  /** Weave's workbench_session_id; it embeds the local session key of the conversation that handed the work over. */
  sessionReference: string
}

/** Persisted per account: the last attention key observed for each run, so restarts neither repeat nor miss notices. */
export type RunWatchState = Record<string, string>

export interface RunWatcherDeps {
  listRunIds(): Promise<string[]>
  lookup(runIds: string[]): Promise<WorkbenchRunLookupResponse>
  load(): Promise<RunWatchState>
  save(state: RunWatchState): Promise<void>
  notify(attention: RunAttention): void
}

const ACTIVE = 'active'
const CLOSED = 'closed'
const MAX_TRACKED_RUNS = 500

export function runAttentionKind(run: Pick<WorkbenchRunLookup, 'status' | 'businessResult'>): RunAttentionKind | undefined {
  if (run.businessResult === 'action_failed' || run.businessResult === 'action_unknown') return 'action_check'
  if (run.businessResult === 'needs_input') return 'needs_input'
  switch (run.status) {
    case 'succeeded': return 'succeeded'
    case 'failed': case 'abandoned': return 'failed'
    case 'parked': return 'waiting'
    default: return undefined
  }
}

function watchKey(run: WorkbenchRunLookup): string {
  if (!run.isCurrent) return CLOSED
  return runAttentionKind(run) ?? (['cancelled'].includes(run.status) ? CLOSED : ACTIVE)
}

/**
 * Compares one observation with the previous state. A run seen for the first
 * time only seeds the state; a run that was previously active (also across a
 * restart) and now needs attention produces exactly one notice per new key.
 */
export function diffRunWatch(previous: RunWatchState, runs: WorkbenchRunLookup[]): { state: RunWatchState; attentions: RunAttention[] } {
  const state: RunWatchState = { ...previous }
  const attentions: RunAttention[] = []
  for (const run of runs) {
    const key = watchKey(run)
    const before = previous[run.runId]
    state[run.runId] = key
    if (before === undefined || before === key || key === ACTIVE || key === CLOSED) continue
    attentions.push({ runId: run.runId, kind: key as RunAttentionKind, sessionReference: run.workbenchSessionID })
  }
  const ids = Object.keys(state)
  if (ids.length > MAX_TRACKED_RUNS) for (const id of ids.slice(0, ids.length - MAX_TRACKED_RUNS)) delete state[id]
  return { state, attentions }
}

/** Polls the employee's recent team runs until Weave offers a run event stream. */
export class RunWatcher {
  private state: RunWatchState | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private running = false
  private rerun = false
  private stopped = false

  constructor(private readonly deps: RunWatcherDeps, private readonly intervalMs = 20_000) {}

  start(): void {
    this.stopped = false
    void this.poll()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Polls now, e.g. right after a hand-off, instead of waiting for the next tick. */
  async poll(): Promise<void> {
    if (this.stopped) return
    if (this.running) {
      // Asked while a read is in flight: read again as soon as it settles.
      this.rerun = true
      return
    }
    this.running = true
    this.rerun = false
    if (this.timer) clearTimeout(this.timer)
    try {
      this.state ??= await this.deps.load()
      const ids = await this.deps.listRunIds()
      const tracked = Object.entries(this.state).filter(([, key]) => key === ACTIVE).map(([id]) => id)
      const query = [...new Set([...ids, ...tracked])]
      if (query.length && !this.stopped) {
        const { runs } = await this.deps.lookup(query)
        if (this.stopped) return
        const { state, attentions } = diffRunWatch(this.state, runs)
        this.state = state
        await this.deps.save(state)
        for (const attention of attentions) this.deps.notify(attention)
      }
    } catch {
      // A failed read keeps the previous state; the next tick retries.
    } finally {
      this.running = false
      if (!this.stopped) this.timer = setTimeout(() => { void this.poll() }, this.rerun ? 0 : this.intervalMs)
    }
  }
}

/** The local session key the hand-off embedded in workbench_session_id (`<project>-<key>-<work>`). */
export function sessionReferenceMatches(sessionReference: string, sessionKey: string): boolean {
  return sessionKey.length === 24 && sessionReference.includes(`-${sessionKey}-`)
}

export const RUN_ATTENTION_COPY: Record<RunAttentionKind, string> = {
  succeeded: '团队工作已完成',
  needs_input: '团队需要你补充材料',
  waiting: '团队在等你处理',
  failed: '团队工作没有完成',
  action_check: '团队工作需要你核对结果',
}
