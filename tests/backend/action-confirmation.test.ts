import { afterEach, expect, it, vi } from 'vitest'
import { ActionConfirmations, type ActionConfirmationRequest } from '../../electron/main/action-confirmation'

afterEach(() => vi.useRealTimers())
const question = { action: '登记报价已发送', record: '本人2100元报价', fields: [{ label: '发送说明', value: '已发送' }] }

it('resolves with the answer to an outstanding question and drops unknown or late answers', async () => {
  let request!: ActionConfirmationRequest
  const hide = vi.fn()
  const confirmations = new ActionConfirmations((next) => { request = next; return true }, 1000, hide)
  const answer = confirmations.request(question)
  confirmations.answer('unknown', true)
  expect(hide).not.toHaveBeenCalled()
  expect(request).toMatchObject(question)
  confirmations.answer(request.id, true)
  expect(await answer).toBe(true)
  expect(hide).toHaveBeenCalledExactlyOnceWith(request.id)
  confirmations.answer(request.id, false)
  expect(hide).toHaveBeenCalledOnce()
})

it('counts a missing window, a lapsed wait and an invalidated account as a no', async () => {
  vi.useFakeTimers()
  const hide = vi.fn()
  expect(await new ActionConfirmations(() => false, 1000, hide).request(question)).toBe(false)
  let id = ''
  const confirmations = new ActionConfirmations((next) => { id = next.id; return true }, 10, hide)
  const lapsed = confirmations.request(question)
  await vi.advanceTimersByTimeAsync(10)
  expect(await lapsed).toBe(false)
  confirmations.answer(id, true)
  const waiting = [confirmations.request(question), confirmations.request(question)]
  confirmations.cancelAll()
  expect(await Promise.all(waiting)).toEqual([false, false])
  expect(hide).toHaveBeenCalledTimes(4)
})
