// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../src/lib/data'
import { GeneralSettings } from '../../src/pages/settings/GeneralSettings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('GeneralSettings macOS background controls', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('describes and persists the opt-in macOS behavior', () => {
    const update = vi.fn()
    act(() => root.render(<GeneralSettings settings={DEFAULT_SETTINGS} onUpdate={update} platform="darwin" />))

    expect(container.textContent).toContain('启动与后台')
    expect(container.textContent).toContain('关闭窗口后继续运行')
    expect(container.textContent).toContain('在菜单栏继续运行定时任务，直到退出应用。')
    expect(container.textContent).toContain('登录时启动')
    expect(container.textContent).toContain('登录这台 Mac 时在后台启动应用。')

    const toggles = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    expect(toggles.slice(-2).map((toggle) => toggle.checked)).toEqual([false, false])
    act(() => toggles.at(-2)?.click())
    act(() => toggles.at(-1)?.click())
    expect(update).toHaveBeenNthCalledWith(1, { keepRunningInBackground: true })
    expect(update).toHaveBeenNthCalledWith(2, { launchAtLogin: true })
  })

  it('keeps the unfinished cross-platform behavior out of other builds', () => {
    act(() => root.render(<GeneralSettings settings={DEFAULT_SETTINGS} onUpdate={vi.fn()} platform="win32" />))
    expect(container.textContent).not.toContain('启动与后台')
    expect(container.textContent).not.toContain('登录时启动')
  })

  it('offers worktree isolation or in-place branch switching', () => {
    const update = vi.fn()
    act(() => root.render(<GeneralSettings settings={DEFAULT_SETTINGS} onUpdate={update} platform="linux" />))

    const select = [...container.querySelectorAll('select')].find((candidate) => candidate.value === 'worktree')
    expect(select?.textContent).toContain('工作树')
    expect(select?.textContent).toContain('分支')
    expect(container.textContent).toContain('独立文件夹')
    expect(container.textContent).toContain('同一个文件夹')

    act(() => {
      if (!select) return
      select.value = 'branch'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(update).toHaveBeenCalledWith({ checkoutStrategy: 'branch' })
  })
})
