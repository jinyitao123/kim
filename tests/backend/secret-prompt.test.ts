import { afterEach, expect, it, vi } from 'vitest'
import { SecretPrompts, type SecretPromptRequest } from '../../electron/main/secret-prompt'

afterEach(() => vi.useRealTimers())

it('answers only an outstanding prompt and closes it without publishing its value', async () => {
  let request!: SecretPromptRequest
  const hide = vi.fn()
  const prompts = new SecretPrompts((next) => { request = next; return true }, 1000, hide)
  const answer = prompts.request({ title: 'Key', label: 'Model key' })
  prompts.answer('unknown', 'wrong-value')
  expect(hide).not.toHaveBeenCalled()
  prompts.answer(request.id, '  private-value  ')
  expect(await answer).toBe('private-value')
  expect(request).not.toHaveProperty('value')
  expect(hide).toHaveBeenCalledExactlyOnceWith(request.id)
  prompts.answer(request.id, 'late-value')
  expect(hide).toHaveBeenCalledOnce()
})

it('declines immediately when there is no trusted window', async () => {
  const hide = vi.fn()
  const prompts = new SecretPrompts(() => false, 1000, hide)
  expect(await prompts.request({ title: 'Key', label: 'Model key' })).toBeUndefined()
  expect(hide).toHaveBeenCalledOnce()
})

it('expires every wait, closes its UI and drops late answers', async () => {
  vi.useFakeTimers()
  let id = ''
  const hide = vi.fn()
  const prompts = new SecretPrompts((next) => { id = next.id; return true }, 10, hide)
  const answer = prompts.request({ title: 'Key', label: 'Model key' })
  await vi.advanceTimersByTimeAsync(10)
  expect(await answer).toBeUndefined()
  expect(hide).toHaveBeenCalledExactlyOnceWith(id)
  prompts.answer(id, 'too-late')
  expect(hide).toHaveBeenCalledOnce()
})

it('cancels all waits when the account or window is invalidated', async () => {
  const hide = vi.fn()
  const prompts = new SecretPrompts(() => true, 1000, hide)
  const answers = [prompts.request({ title: 'One', label: 'Key' }), prompts.request({ title: 'Two', label: 'Key' })]
  prompts.cancelAll()
  expect(await Promise.all(answers)).toEqual([undefined, undefined])
  expect(hide).toHaveBeenCalledTimes(2)
  prompts.cancelAll()
  expect(hide).toHaveBeenCalledTimes(2)
})
