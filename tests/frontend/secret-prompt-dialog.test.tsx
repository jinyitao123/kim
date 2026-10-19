// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SecretPromptDialog } from '../../src/components/SecretPromptDialog'
import type { SecretPromptEvent } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root, container: HTMLDivElement
let publish: (event: SecretPromptEvent) => void
const answer = vi.fn(async (_id: string, _value: string | null) => {})
beforeEach(async () => {
  answer.mockClear()
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<SecretPromptDialog subscribe={(callback) => { publish = callback; return () => undefined }} answer={answer} />))
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
const prompt = async (id = 'one') => act(async () => publish({ id, title: 'Organization model key', label: 'Key' }))
const typeSecret = async () => act(async () => {
  const input = document.querySelector<HTMLInputElement>('input[name="secret"]')!
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'private-dialog-value')
  input.dispatchEvent(new Event('input', { bubbles: true }))
})

it('collects a password through the UI and clears it after submitting', async () => {
  await prompt(); await typeSecret()
  expect(document.querySelector('input')?.type).toBe('password')
  expect(document.querySelector('input')?.maxLength).toBe(4096)
  await act(async () => document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(answer).toHaveBeenCalledExactlyOnceWith('one', 'private-dialog-value')
  expect(document.querySelector('input[name="secret"]')).toBeNull()
})

it('closes and clears a cancelled or expired prompt without submitting its value', async () => {
  await prompt(); await typeSecret()
  await act(async () => publish({ id: 'one', closed: true }))
  expect(document.querySelector('input[name="secret"]')).toBeNull()
  expect(answer).not.toHaveBeenCalled()
  await prompt('two')
  expect(document.querySelector('input')?.value).toBe('')
})

it('declines the older prompt, ignores its late close and does not carry its value to a newer one', async () => {
  await prompt(); await typeSecret(); await prompt('two')
  expect(answer).toHaveBeenCalledExactlyOnceWith('one', null)
  await act(async () => publish({ id: 'one', closed: true }))
  expect(document.querySelector('input')?.value).toBe('')
  await act(async () => [...document.querySelectorAll('button')].find((button) => button.textContent === '取消')!.click())
  expect(answer).toHaveBeenLastCalledWith('two', null)
  expect(document.querySelector('input[name="secret"]')).toBeNull()
})
