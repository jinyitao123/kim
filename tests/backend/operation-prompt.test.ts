import { afterEach, expect, it, vi } from 'vitest'
import { OperationPrompts, type OperationPromptRequest } from '../../electron/main/operation-prompt'

afterEach(() => vi.useRealTimers())
const question = { title: '归档团队', subject: '线索跟进团队', message: '归档后不再接新的工作。' }

it('goes ahead only on the answer to the open question', async () => {
  let request!: OperationPromptRequest
  const hide = vi.fn()
  const prompts = new OperationPrompts((next) => { request = next; return true }, 1000, hide)
  const answer = prompts.confirm(question)
  expect(request).toMatchObject({ kind: 'confirm', ...question })
  prompts.answer('unknown', true)
  expect(hide).not.toHaveBeenCalled()
  prompts.answer(request.id, true)
  expect(await answer).toBe(true)
  expect(hide).toHaveBeenCalledExactlyOnceWith(request.id)
  prompts.answer(request.id, true)
  expect(hide).toHaveBeenCalledOnce()
})

it('treats a refusal, a missing window and a person who walked away as a no', async () => {
  vi.useFakeTimers()
  let id = ''
  const hide = vi.fn()
  const open = new OperationPrompts((next) => { id = next.id; return true }, 10, hide)
  const declined = open.confirm(question)
  open.answer(id, false)
  expect(await declined).toBe(false)
  expect(await new OperationPrompts(() => false, 10).confirm(question)).toBe(false)
  const expired = open.confirm(question)
  await vi.advanceTimersByTimeAsync(10)
  expect(await expired).toBe(false)
  open.answer(id, true)
  expect(hide).toHaveBeenCalledTimes(2)
})

it('shows a secret without waiting and reports whether a window took it', () => {
  const shown: OperationPromptRequest[] = []
  const hide = vi.fn()
  const values = [{ label: '接入令牌', value: 'private-token' }]
  const prompts = new OperationPrompts((next) => { shown.push(next); return true }, 1000, hide)
  expect(prompts.reveal({ title: '请保存以下内容', message: '只显示这一次。', values })).toBe(true)
  expect(shown[0]).toMatchObject({ kind: 'reveal', values })
  expect(new OperationPrompts(() => false).reveal({ title: 't', message: 'm', values })).toBe(false)
  // Closing it is the person's own doing and needs nothing taken off the screen.
  prompts.answer(shown[0]!.id, true)
  prompts.cancelAll()
  expect(hide).not.toHaveBeenCalled()
})

it('declines every question and takes every shown secret off the screen when the account or window goes', async () => {
  const ids: string[] = []
  const hide = vi.fn()
  const prompts = new OperationPrompts((next) => { ids.push(next.id); return true }, 1000, hide)
  const answer = prompts.confirm(question)
  prompts.reveal({ title: 't', message: 'm', values: [{ label: '接入令牌', value: 'private-token' }] })
  prompts.cancelAll()
  expect(await answer).toBe(false)
  expect(hide.mock.calls.map(([id]) => id).sort()).toEqual([...ids].sort())
  prompts.cancelAll()
  expect(hide).toHaveBeenCalledTimes(2)
})
