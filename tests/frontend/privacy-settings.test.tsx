// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../src/lib/data'
import { PrivacySettings } from '../../src/pages/settings/PrivacySettings'
import { HARNESS_IDS, type HarnessId } from '../../src/types/api'

const TELEMETRY_VALUES = [false, true] as const
const HARNESS_TELEMETRY_CASES = HARNESS_IDS.flatMap((harness) => (
  TELEMETRY_VALUES.map((telemetry) => ({ harness, telemetry }))
)) satisfies Array<{ harness: HarnessId; telemetry: boolean }>

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('PrivacySettings', () => {
  it.each(HARNESS_TELEMETRY_CASES)('shows agent-neutral copy without an inert diagnostics control for $harness with telemetry=$telemetry', ({ harness, telemetry }) => {
    const onUpdate = vi.fn()
    act(() => root.render(<PrivacySettings settings={{ ...DEFAULT_SETTINGS, activeHarness: harness, telemetry }} onUpdate={onUpdate} />))

    expect(container.textContent).toContain('了解 Kim 如何保存设置以及如何连接智能体。')
    expect(container.textContent).toContain('设置保存在本机')
    expect(container.textContent).toContain('项目信息和界面设置保存在这台设备上。')
    expect(container.textContent).toContain('请求经由你选择的智能体')
    expect(container.textContent).toContain('对话请求按所选智能体及其服务商配置发出。')
    expect(container.querySelector('input[type="checkbox"]')).toBeNull()
    expect(container.textContent).not.toMatch(/optional diagnostics|share diagnostics|this Mac|Prime Agent/i)
    expect(onUpdate).not.toHaveBeenCalled()
  })
})
