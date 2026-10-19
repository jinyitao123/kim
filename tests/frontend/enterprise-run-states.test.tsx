// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useEnterpriseRunStates } from '../../src/hooks/useEnterpriseRunStates'
import type { EnterpriseWorkRunDetails, EnterpriseWorkRunStates } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root, container: HTMLDivElement
let latest: ReturnType<typeof useEnterpriseRunStates>
function Probe({ account = 'employee', read, ids = ['a', 'a', 'b'], detailRunId, readDetails }: { account?: string; read(ids: string[]): Promise<EnterpriseWorkRunStates>; ids?: string[]; detailRunId?: string; readDetails?(id: string): Promise<EnterpriseWorkRunDetails> }) {
  latest = useEnterpriseRunStates(ids, account, read, detailRunId, readDetails)
  return null
}
beforeEach(() => { vi.useFakeTimers(); vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible'); container = document.createElement('div'); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); vi.restoreAllMocks() })
const advance = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(5000) }) }

it('batches a visible session once and removes terminal runs from subsequent refreshes', async () => {
  const read = vi.fn<(ids: string[]) => Promise<EnterpriseWorkRunStates>>()
    .mockResolvedValueOnce({ runs: [{ runId: 'a', status: 'failed', isCurrent: true }, { runId: 'b', status: 'running', isCurrent: true }], missing: [] })
    .mockResolvedValueOnce({ runs: [{ runId: 'b', status: 'succeeded', isCurrent: true, businessResult: 'needs_input' }], missing: [] })
  await act(async () => root.render(<Probe read={read} />))
  expect(read).toHaveBeenNthCalledWith(1, ['a', 'b'])
  await advance()
  expect(read).toHaveBeenNthCalledWith(2, ['b'])
  expect(latest.views.b.run?.businessResult).toBe('needs_input')
  await advance()
  expect(read).toHaveBeenCalledTimes(2)
})

it('marks failed reads stale and pauses hidden-window polling until visible again', async () => {
  const read = vi.fn<(ids: string[]) => Promise<EnterpriseWorkRunStates>>()
    .mockResolvedValueOnce({ runs: [{ runId: 'a', status: 'running', isCurrent: true }], missing: [] })
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({ runs: [{ runId: 'a', status: 'cancelled', isCurrent: true }], missing: [] })
  await act(async () => root.render(<Probe read={read} ids={['a']} />))
  await advance()
  expect(latest.views.a).toMatchObject({ stale: true, run: { status: 'running' } })
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  await advance()
  expect(read).toHaveBeenCalledTimes(2)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  expect(read).toHaveBeenCalledTimes(3)
  expect(latest.views.a).toMatchObject({ run: { runId: 'a', status: 'cancelled', isCurrent: true }, stale: false })
})

const detail = (status: EnterpriseWorkRunDetails['status']): EnterpriseWorkRunDetails => ({ runId: 'a', status, members: [], activityComplete: false, materials: [], explanation: '', authorizationRequired: false })

it('refreshes only the expanded details at ten-second intervals and fetches final details before stopping', async () => {
  const read = vi.fn<(ids: string[]) => Promise<EnterpriseWorkRunStates>>()
    .mockResolvedValueOnce({ runs: [{ runId: 'a', status: 'running', isCurrent: true }], missing: [] })
    .mockResolvedValueOnce({ runs: [{ runId: 'a', status: 'running', isCurrent: true }], missing: [] })
    .mockResolvedValue({ runs: [{ runId: 'a', status: 'failed', isCurrent: true }], missing: [] })
  const readDetails = vi.fn<(id: string) => Promise<EnterpriseWorkRunDetails>>().mockResolvedValueOnce(detail('running')).mockResolvedValue(detail('failed'))
  await act(async () => root.render(<Probe read={read} ids={['a']} detailRunId="a" readDetails={readDetails} />))
  expect(readDetails).toHaveBeenCalledExactlyOnceWith('a')
  await advance()
  expect(readDetails).toHaveBeenCalledOnce()
  await advance()
  expect(readDetails).toHaveBeenCalledTimes(2)
  expect(latest.views.a.details?.status).toBe('failed')
  await advance()
  expect(read).toHaveBeenCalledTimes(3)
  expect(readDetails).toHaveBeenCalledTimes(2)
})

it('discards a late detail response after an account switch', async () => {
  let finish!: (value: EnterpriseWorkRunDetails) => void
  const read = vi.fn<(ids: string[]) => Promise<EnterpriseWorkRunStates>>().mockResolvedValueOnce({ runs: [{ runId: 'a', status: 'failed', isCurrent: true }], missing: [] }).mockResolvedValue({ runs: [], missing: ['a'] })
  const readDetails = vi.fn(() => new Promise<EnterpriseWorkRunDetails>((resolve) => { finish = resolve }))
  await act(async () => root.render(<Probe read={read} ids={['a']} detailRunId="a" readDetails={readDetails} />))
  await act(async () => root.render(<Probe account="other" read={read} ids={['a']} detailRunId="a" readDetails={readDetails} />))
  await act(async () => finish(detail('failed')))
  expect(latest.views.a).toEqual({ unavailable: true })
})

it('does not overlap requests or accept late state from a previous account', async () => {
  let finishOld!: (result: EnterpriseWorkRunStates) => void
  const read = vi.fn<(ids: string[]) => Promise<EnterpriseWorkRunStates>>()
    .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve }))
    .mockResolvedValue({ runs: [], missing: ['a'] })
  await act(async () => root.render(<Probe read={read} ids={['a']} />))
  await advance()
  expect(read).toHaveBeenCalledOnce()
  await act(async () => root.render(<Probe account="other-employee" read={read} ids={['a']} />))
  expect(latest.views.a).toEqual({ unavailable: true })
  await act(async () => finishOld({ runs: [{ runId: 'a', status: 'running', isCurrent: true }], missing: [] }))
  expect(latest.views.a).toEqual({ unavailable: true })
})
