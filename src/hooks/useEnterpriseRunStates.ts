import { useCallback, useEffect, useRef, useState } from 'react'
import type { EnterpriseWorkRunDetails, EnterpriseWorkRunState, EnterpriseWorkRunStates } from '@/types/api'

export interface EnterpriseRunView {
  run?: EnterpriseWorkRunState
  unavailable?: boolean
  stale?: boolean
  details?: EnterpriseWorkRunDetails
  detailStale?: boolean
}

export const enterpriseRunTerminal = (status: string): boolean => ['succeeded', 'failed', 'cancelled', 'abandoned'].includes(status)

/** One account/session-owned, serial read loop for all visible authorization cards. */
export function useEnterpriseRunStates(runIds: string[], accountScope: string | undefined, read?: (ids: string[]) => Promise<EnterpriseWorkRunStates>, detailRunId?: string, readDetails?: (id: string) => Promise<EnterpriseWorkRunDetails>) {
  const idsKey = JSON.stringify([...new Set(runIds)].sort())
  const owner = `${accountScope ?? ''}:${idsKey}`
  const [snapshot, setSnapshot] = useState<{ owner: string; views: Record<string, EnterpriseRunView> }>({ owner: '', views: {} })
  const [revision, setRevision] = useState(0)
  const previousRef = useRef(snapshot)
  previousRef.current = snapshot
  const refresh = useCallback(() => setRevision((current) => current + 1), [])

  useEffect(() => {
    const ids: string[] = JSON.parse(idsKey)
    if (!read || !accountScope || !ids.length) return
    let disposed = false, inFlight = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const views = previousRef.current.owner === owner ? { ...previousRef.current.views } : {}
    // Revalidate even cached terminal states on mount/account/session changes.
    let first = true, lastDetailRead = Number.NEGATIVE_INFINITY
    const needsDetail = () => Boolean(readDetails && detailRunId && ids.includes(detailRunId) && !views[detailRunId]?.unavailable
      && (!views[detailRunId]?.details || views[detailRunId]?.detailStale || !enterpriseRunTerminal(views[detailRunId].details!.status)
        || views[detailRunId].details!.status !== views[detailRunId]?.run?.status))
    const publish = () => { if (!disposed) setSnapshot({ owner, views: { ...views } }) }
    const poll = async () => {
      if (disposed || inFlight || document.visibilityState === 'hidden') return
      const pending = ids.filter((id) => first || views[id]?.stale || !views[id]?.run || !enterpriseRunTerminal(views[id].run!.status))
      if (!pending.length && !needsDetail()) return
      first = false; inFlight = true
      try {
        if (pending.length) {
          const result = await read(pending)
          if (disposed) return
          const returned = new Map(result.runs.map((run) => [run.runId, run]))
          for (const id of pending) {
            const run = returned.get(id)
            views[id] = run ? { ...views[id], run, stale: false, unavailable: false } : { unavailable: true }
          }
          publish()
        }
      } catch {
        if (disposed) return
        for (const id of pending) views[id] = { ...views[id], stale: true }
      } finally {
        if (!disposed && needsDetail() && detailRunId && readDetails && Date.now() - lastDetailRead >= 10000) {
          lastDetailRead = Date.now()
          try {
            const details = await readDetails(detailRunId)
            if (!disposed) views[detailRunId] = { ...views[detailRunId], details, detailStale: false,
              ...(views[detailRunId]?.run?.status !== details.status ? { stale: true } : {}) }
          } catch {
            if (!disposed) views[detailRunId] = { ...views[detailRunId], detailStale: true }
          }
        }
        inFlight = false
        if (!disposed) {
          publish()
          if (needsDetail() || ids.some((id) => !views[id]?.run || views[id]?.stale || !enterpriseRunTerminal(views[id].run!.status))) timer = setTimeout(() => { void poll() }, 5000)
        }
      }
    }
    const onVisibility = () => {
      if (timer) clearTimeout(timer)
      if (document.visibilityState !== 'hidden') void poll()
    }
    document.addEventListener('visibilitychange', onVisibility)
    void poll()
    return () => { disposed = true; if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', onVisibility) }
  }, [accountScope, idsKey, owner, read, revision, detailRunId, readDetails])

  return { views: snapshot.owner === owner ? snapshot.views : {}, refresh }
}
