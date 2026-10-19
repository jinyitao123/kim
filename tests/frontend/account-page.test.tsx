// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountPage } from '../../src/pages/AccountPage'
import { EnterpriseAccountSettings } from '../../src/pages/settings/EnterpriseAccountSettings'
import type { EnterpriseSession } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('GooeyPi enterprise account entry', () => {
  const signedOut: EnterpriseSession = { version: '1', status: 'signed-out', storage: 'session-only', environment: { origin: 'http://forge.example.test', secure: false } }
  const awaitingApproval: EnterpriseSession = { ...signedOut, signIn: { userCode: 'WXYZ2345', verificationUri: 'http://forge.example.test/_console/auth/device?user_code=WXYZ2345', expiresAt: '2026-10-11T08:30:00.000Z' } }
  const noop = async () => undefined
  const button = (label: string) => [...container.querySelectorAll('button')].find((item) => item.textContent === label)

  it('starts the sign-in from one button and asks for no account or password', async () => {
    const onSignIn = vi.fn(noop)
    await act(async () => root.render(<AccountPage session={signedOut} onSignIn={onSignIn} onCancelSignIn={noop} onReopenSignIn={noop} />))
    expect(container.querySelector('input')).toBeNull()
    await act(async () => button('登录')!.click())
    expect(onSignIn).toHaveBeenCalledTimes(1)
    expect(onSignIn).toHaveBeenCalledWith()
    expect(container.textContent).not.toContain('密码')
  })

  it('shows the confirmation code while the browser approval is awaited, and lets the employee reopen it or cancel', async () => {
    const onCancelSignIn = vi.fn(noop), onReopenSignIn = vi.fn(noop)
    await act(async () => root.render(<AccountPage session={awaitingApproval} onSignIn={noop} onCancelSignIn={onCancelSignIn} onReopenSignIn={onReopenSignIn} />))
    expect(container.querySelector('output')?.textContent).toBe('WXYZ2345')
    expect(button('登录')).toBeUndefined()
    // The address carries the code; the page shows only the code itself.
    expect(container.textContent).not.toContain('user_code')
    await act(async () => button('重新打开浏览器')!.click())
    expect(onReopenSignIn).toHaveBeenCalledTimes(1)
    await act(async () => button('取消')!.click())
    expect(onCancelSignIn).toHaveBeenCalledTimes(1)
  })

  it('reports a refused sign-in but stays quiet when the employee cancelled it', async () => {
    const onSignIn = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('已在浏览器中拒绝这次登录')).mockRejectedValueOnce(new Error('已取消登录'))
    await act(async () => root.render(<AccountPage session={signedOut} onSignIn={onSignIn} onCancelSignIn={noop} onReopenSignIn={noop} />))
    await act(async () => button('登录')!.click())
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('已在浏览器中拒绝这次登录')
    await act(async () => button('登录')!.click())
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('says why a saved sign-in could not be picked up', async () => {
    await act(async () => root.render(<AccountPage session={{ ...signedOut, message: '暂时连不上企业服务；恢复后重新打开，或重新登录' }} onSignIn={noop} onCancelSignIn={noop} onReopenSignIn={noop} />))
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('暂时连不上企业服务；恢复后重新打开，或重新登录')
    expect(button('登录')).toBeDefined()
  })

  it('keeps signed-in account management in settings without a sign-in control', async () => {
    await act(async () => root.render(<EnterpriseAccountSettings session={{ version: '1', status: 'signed-in', storage: 'private-file', environment: { origin: 'http://forge.example.test', secure: false }, user: { id: 'employee', name: 'Employee', email: 'employee@example.test' }, organization: { id: 'default', name: 'Default' }, permissions: ['teams:use'] }} onSignIn={noop} onCancelSignIn={noop} onReopenSignIn={noop} onSignOut={noop} />))
    expect(container.textContent).toContain('Employee')
    expect(container.textContent).toContain('退出登录')
    expect(button('登录')).toBeUndefined()
    expect(container.querySelector('input')).toBeNull()
  })

  it('shows saved origins and requires an explicit normal restart before signing in', async () => {
    const onSignIn = vi.fn(noop), restart = vi.fn(noop)
    const config = { version: 1 as const, forgeOrigin: 'https://forge.example.test', weaveOrigin: 'https://weave.example.test' }
    const select = vi.fn(async () => ({ status: 'saved' as const, config, environmentOverride: false, restartRequired: true }))
    await act(async () => root.render(<AccountPage onSignIn={onSignIn} onCancelSignIn={noop} onReopenSignIn={noop} onImportConnection={select} onRestartConnection={restart} />))
    await act(async () => button('导入组织连接')!.click())
    expect(container.textContent).toContain(config.forgeOrigin)
    expect(container.textContent).toContain(config.weaveOrigin)
    expect(container.textContent).toContain('重启后生效')
    expect(button('登录')!.disabled).toBe(true)
    await act(async () => button('登录')!.click())
    expect(onSignIn).not.toHaveBeenCalled()
    expect(restart).not.toHaveBeenCalled()
    await act(async () => button('重启应用')!.click())
    expect(restart).toHaveBeenCalledTimes(1)
  })

  it('does not claim developer overrides changed or restart after a cancelled import', async () => {
    const config = { version: 1 as const, forgeOrigin: 'https://forge.example.test', weaveOrigin: 'https://weave.example.test' }
    const select = vi.fn<() => Promise<import('../../src/types/api').EnterpriseConnectionImportResult>>()
      .mockResolvedValueOnce({ status: 'saved', config, environmentOverride: true, restartRequired: false })
      .mockResolvedValueOnce({ status: 'cancelled' })
    const restart = vi.fn(noop)
    await act(async () => root.render(<AccountPage onSignIn={noop} onCancelSignIn={noop} onReopenSignIn={noop} onImportConnection={select} onRestartConnection={restart} />))
    await act(async () => button('导入组织连接')!.click())
    expect(container.textContent).toContain('当前仍使用开发连接覆盖')
    expect(button('重启应用')).toBeUndefined()
    const before = container.textContent
    await act(async () => button('导入组织连接')!.click())
    expect(container.textContent).toBe(before)
    expect(restart).not.toHaveBeenCalled()
  })
})
