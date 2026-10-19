// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OperationPromptDialog } from '../../src/components/OperationPromptDialog'
import type { OperationPromptEvent } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root, container: HTMLDivElement
let publish: (event: OperationPromptEvent) => void
const answer = vi.fn(async (_id: string, _confirmed: boolean) => {})
beforeEach(async () => {
  answer.mockClear()
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<OperationPromptDialog subscribe={(callback) => { publish = callback; return () => undefined }} answer={answer} />))
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
const ask = async (id = 'one') => act(async () => publish({ id, kind: 'confirm', title: '归档团队', subject: '线索跟进团队', message: '归档后不再接新的工作。' }))
const button = (label: string) => [...document.querySelectorAll('button')].find((item) => item.textContent === label)!

it('shows what will be done, to what and with what consequence, and reports the choice', async () => {
  await ask()
  const shown = document.querySelector('.operation-prompt')!.textContent
  for (const text of ['归档团队', '线索跟进团队', '归档后不再接新的工作。']) expect(shown).toContain(text)
  await act(async () => button('办理').click())
  expect(answer).toHaveBeenCalledExactlyOnceWith('one', true)
  expect(document.querySelector('.operation-prompt')).toBeNull()
})

it('declines on refusal and when a newer question replaces an open one', async () => {
  await ask()
  await ask('two')
  expect(answer).toHaveBeenCalledExactlyOnceWith('one', false)
  // The older question's late close leaves the newer one open.
  await act(async () => publish({ id: 'one', closed: true }))
  await act(async () => button('不办理').click())
  expect(answer).toHaveBeenLastCalledWith('two', false)
  expect(document.querySelector('.operation-prompt')).toBeNull()
})

it('closes without an answer when the main process withdraws the question', async () => {
  await ask()
  await act(async () => publish({ id: 'one', closed: true }))
  expect(document.querySelector('.operation-prompt')).toBeNull()
  expect(answer).not.toHaveBeenCalled()
})

it('shows a secret for copying and takes it off the page when closed or withdrawn', async () => {
  const writeText = vi.fn(async (_text: string) => {})
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  await act(async () => publish({ id: 'one', kind: 'reveal', title: '请保存以下内容', message: '只显示这一次。', values: [{ label: '接入令牌', value: 'private-token' }] }))
  expect(document.querySelector('.operation-prompt code')?.textContent).toBe('private-token')
  await act(async () => button('复制').click())
  expect(writeText).toHaveBeenCalledExactlyOnceWith('private-token')
  expect(button('已复制')).toBeTruthy()
  await act(async () => button('关闭').click())
  expect(answer).toHaveBeenCalledExactlyOnceWith('one', true)
  expect(document.body.textContent).not.toContain('private-token')
  await act(async () => publish({ id: 'two', kind: 'reveal', title: '请保存以下内容', message: '只显示这一次。', values: [{ label: '接入令牌', value: 'private-token' }] }))
  await act(async () => publish({ id: 'two', closed: true }))
  expect(document.body.textContent).not.toContain('private-token')
})
