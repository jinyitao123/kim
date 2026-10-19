// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { PrimeWorkApi } from '../../src/types/api'
import { FeishuAccountSettings } from '../../src/pages/settings/FeishuAccountSettings'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement, root: Root
const code = 'a'.repeat(48)
beforeEach(() => {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  window.prime = { enterprise: { getFeishuStatus: vi.fn(async () => ({ available: true, bound: false })), createFeishuLinkCode: vi.fn(async () => ({ code, expiresAt: new Date(Date.now() + 600_000).toISOString() })), unlinkFeishu: vi.fn(async () => undefined) } } as unknown as PrimeWorkApi
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks() })
it('pairs and refreshes from the signed-in account without exposing tokens', async () => {
  await act(async () => root.render(<FeishuAccountSettings accountId="employee" />))
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
  expect(container.textContent).toContain(`绑定 ${code}`)
  vi.mocked(window.prime.enterprise.getFeishuStatus).mockResolvedValue({ available: true, bound: true })
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === '检查连接')!.click())
  expect(container.textContent).toContain('已连接'); expect(container.textContent).not.toContain(code)
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === '解除连接')!.click())
  expect(window.prime.enterprise.unlinkFeishu).toHaveBeenCalledTimes(1)
})
it('discards a previous employee pairing response after account switching', async () => {
  let resolve!: (value: { code: string; expiresAt: string }) => void
  vi.mocked(window.prime.enterprise.createFeishuLinkCode).mockImplementation(() => new Promise(done => { resolve = done }))
  await act(async () => root.render(<FeishuAccountSettings accountId="one" />))
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
  await act(async () => root.render(<FeishuAccountSettings accountId="two" />))
  await act(async () => resolve({ code, expiresAt: new Date(Date.now() + 600_000).toISOString() }))
  expect(container.textContent).not.toContain(code)
})
it('shows an unconfigured integration without a connection action', async () => {
  vi.mocked(window.prime.enterprise.getFeishuStatus).mockResolvedValue({ available: false, bound: false })
  await act(async () => root.render(<FeishuAccountSettings accountId="employee" />))
  expect(container.textContent).toContain('未配置'); expect(container.querySelector('button')).toBeNull()
})
