// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ActionConfirmationDialog } from '../../src/components/ActionConfirmationDialog'
import type { ActionConfirmationEvent } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root, container: HTMLDivElement
let publish: (event: ActionConfirmationEvent) => void
const answer = vi.fn(async (_id: string, _confirmed: boolean) => {})
beforeEach(async () => {
  answer.mockClear()
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<ActionConfirmationDialog subscribe={(callback) => { publish = callback; return () => undefined }} answer={answer} />))
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
const ask = async (id = 'one') => act(async () => publish({ id, action: '登记报价已发送', record: '本人2100元报价', fields: [{ label: '发送说明', value: '2100元报价已发送' }, { label: '发送凭证', value: '报价发送凭证.pdf' }] }))
const choose = async (label: string) => act(async () => [...document.querySelectorAll<HTMLButtonElement>('.extension-question__options button')].find((button) => button.textContent === label)!.click())

it('shows the action, record and submitted fields read-only and reports the employee choice', async () => {
  await ask()
  const dialog = document.querySelector('[role="dialog"]')!
  expect([...dialog.querySelectorAll('dt')].map((term) => term.textContent)).toEqual(['办理事项', '业务记录', '发送说明', '发送凭证'])
  expect([...dialog.querySelectorAll('dd')].map((value) => value.textContent)).toEqual(['登记报价已发送', '本人2100元报价', '2100元报价已发送', '报价发送凭证.pdf'])
  expect(dialog.querySelector('input, textarea, select')).toBeNull()
  await choose('办理')
  expect(answer).toHaveBeenCalledExactlyOnceWith('one', true)
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('reports a no when the employee declines or closes the dialog', async () => {
  await ask(); await choose('不办理')
  expect(answer).toHaveBeenLastCalledWith('one', false)
  await ask('two')
  await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click())
  expect(answer).toHaveBeenLastCalledWith('two', false)
  expect(answer).toHaveBeenCalledTimes(2)
})

it('closes a question the app withdrew without answering and declines one replaced by a newer question', async () => {
  await ask()
  await act(async () => publish({ id: 'other', closed: true }))
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  await act(async () => publish({ id: 'one', closed: true }))
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(answer).not.toHaveBeenCalled()
  await ask('two'); await ask('three')
  expect(answer).toHaveBeenCalledExactlyOnceWith('two', false)
  await choose('办理')
  expect(answer).toHaveBeenLastCalledWith('three', true)
})
