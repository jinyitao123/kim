import type { AutomationScheduleRecord } from '../../../src/types/api'
import type { DesktopState, PersistedSchedule } from '../store'

export interface PersistedScheduleOwnership {
  scheduleId: string
  /** Opaque EnterpriseService scope hash. This field stays in main-process storage. */
  ownerScope: string | null
  state: 'bound' | 'migrated' | 'needs_review'
  originalStatus?: AutomationScheduleRecord['status']
}

export const OWNER_SCOPE_PATTERN = /^[a-f0-9]{64}$/
export const REVIEW_REQUIRED_REASON = '这条旧计划的账号归属无法核验，原计划已保留且不会自动运行。'

export function findScheduleOwnership(ownerships: readonly PersistedScheduleOwnership[], scheduleId: string): PersistedScheduleOwnership | undefined {
  return ownerships.find((candidate) => candidate.scheduleId === scheduleId)
}

export function isScheduleBoundToScope(state: Pick<DesktopState, 'scheduleOwnerships'>, scheduleId: string, ownerScope: string | null): boolean {
  const ownership = findScheduleOwnership(state.scheduleOwnerships, scheduleId)
  return !!ownership && ownership.state !== 'needs_review' && ownership.ownerScope === ownerScope
}

export function publicSchedule(task: AutomationScheduleRecord, ownership: PersistedScheduleOwnership): AutomationScheduleRecord {
  const view = structuredClone(task)
  view.ownerMigrationState = ownership.state
  if (ownership.state === 'needs_review') {
    view.status = 'blocked'
    view.blockedReason = REVIEW_REQUIRED_REASON
  }
  return view
}

/** Only an exact, unique persisted target record can supply a legacy owner's scope. */
export function migrateLegacyScheduleOwnerships(state: Pick<DesktopState, 'projects' | 'schedules' | 'scheduleOwnerships'>): void {
  const known = new Set(state.scheduleOwnerships.map(({ scheduleId }) => scheduleId))
  for (const task of state.schedules) {
    if (task.harness === 'omp') {
      // Retired-harness records stay archived and never regain execution authority.
      known.add(task.id)
      continue
    }
    if (known.has(task.id)) continue
    const matches = state.projects.filter((candidate) => candidate.id === task.target.projectId && candidate.harness === task.harness)
    const scope = matches.length === 1 ? matches[0].accountScope : undefined
    if (scope && OWNER_SCOPE_PATTERN.test(scope)) state.scheduleOwnerships.push({ scheduleId: task.id, ownerScope: scope, state: 'migrated' })
    else state.scheduleOwnerships.push({ scheduleId: task.id, ownerScope: null, state: 'needs_review', originalStatus: task.status })
    known.add(task.id)
  }
}

export function parseScheduleOwnerships(value: unknown, schedules: readonly PersistedSchedule[]): PersistedScheduleOwnership[] {
  if (!Array.isArray(value)) return []
  const scheduleIds = new Set(schedules.map(({ id }) => id))
  const seen = new Set<string>()
  return value.flatMap((item): PersistedScheduleOwnership[] => {
    if (!isRecord(item) || typeof item.scheduleId !== 'string' || !item.scheduleId.trim() || item.scheduleId.length > 256 || !scheduleIds.has(item.scheduleId) || seen.has(item.scheduleId)) return []
    const ownerScope = item.ownerScope === null ? null : typeof item.ownerScope === 'string' && OWNER_SCOPE_PATTERN.test(item.ownerScope) ? item.ownerScope : undefined
    if (ownerScope === undefined || !['bound', 'migrated', 'needs_review'].includes(String(item.state))) return []
    if (item.state === 'needs_review' && ownerScope !== null) return []
    const originalStatus = ['active', 'paused', 'completed', 'blocked'].includes(String(item.originalStatus)) ? item.originalStatus as AutomationScheduleRecord['status'] : undefined
    seen.add(item.scheduleId)
    return [{ scheduleId: item.scheduleId, ownerScope, state: item.state as PersistedScheduleOwnership['state'], originalStatus }]
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
