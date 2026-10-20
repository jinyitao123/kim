// @vitest-environment jsdom
import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../src/lib/data'
import { VoiceSettings } from '../../src/pages/settings/VoiceSettings'
import type { AppSettings, PrimeWorkApi, VoiceCredentialStatus } from '../../src/types/api'

vi.mock('../../src/components/ui', () => ({
  Modal: ({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) => <div role="dialog" aria-label={title}>{children}{footer}</div>,
}))

const emptyStatus: VoiceCredentialStatus = {
  configured: { openai: false, groq: false, deepgram: false, 'self-hosted': false },
  source: {},
  storage: { available: false, message: 'Voice keys stay in memory while Kim is running. Enter them again after restarting Kim.' },
}

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

async function render(node: ReactNode) {
  await act(async () => { root.render(node); await Promise.resolve() })
}

async function click(element: HTMLElement) {
  await act(async () => { element.click() })
}

async function enter(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function voiceBridge(overrides: Partial<PrimeWorkApi['voice']> = {}): PrimeWorkApi['voice'] {
  return {
    credentialStatus: vi.fn().mockResolvedValue(emptyStatus),
    saveApiKey: vi.fn().mockResolvedValue(emptyStatus),
    deleteApiKey: vi.fn().mockResolvedValue(emptyStatus),
    createRealtimeCall: vi.fn(),
    transcribe: vi.fn(),
    testSelfHosted: vi.fn().mockResolvedValue(true),
    executeTool: vi.fn(),
    ...overrides,
  }
}

function Harness({ voice }: { voice: PrimeWorkApi['voice'] | null }) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  return <VoiceSettings settings={settings} voice={voice} onUpdate={(patch) => { setSettings((current) => ({ ...current, ...patch })) }} />
}

describe('Voice settings setup flow', () => {
  it('shows only the selected provider model picker and switches to curated Groq models', async () => {
    await render(<Harness voice={voiceBridge()} />)

    const service = container.querySelector<HTMLSelectElement>('select[aria-label="听写服务"]')!
    const model = container.querySelector<HTMLSelectElement>('select[aria-label="听写模型"]')!
    expect(service.value).toBe('openai-live')
    expect([...model.options].map((option) => option.value)).toEqual(['gpt-live-transcribe', 'gpt-realtime-whisper'])
    expect(container.querySelector('input[aria-label="whisper-cli executable"]')).toBeNull()

    await choose(service, 'groq')
    const groqModel = container.querySelector<HTMLSelectElement>('select[aria-label="听写模型"]')!
    expect([...groqModel.options].map((option) => option.value)).toEqual(['whisper-large-v3-turbo', 'whisper-large-v3'])
    expect(container.textContent).not.toContain('OpenAI file model')
  })

  it('opens an enabled API-key flow and saves through the voice bridge', async () => {
    const saveApiKey = vi.fn().mockResolvedValue({
      configured: { openai: true, groq: false, deepgram: false, 'self-hosted': false },
      source: { openai: 'session' },
      storage: emptyStatus.storage,
    } satisfies VoiceCredentialStatus)
    await render(<Harness voice={voiceBridge({ saveApiKey })} />)

    const openAiCard = [...container.querySelectorAll<HTMLElement>('.voice-connection-card')].find((card) => card.textContent?.includes('OpenAI'))!
    const addKey = [...openAiCard.querySelectorAll('button')].find((button) => button.textContent?.includes('添加密钥'))!
    expect(addKey.disabled).toBe(false)
    await click(addKey)
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!
    const input = dialog.querySelector<HTMLInputElement>('input[type="password"]')!
    await enter(input, 'sk-test-key')
    const save = [...dialog.querySelectorAll('button')].find((button) => button.textContent?.includes('使用 API 密钥'))!
    await click(save)

    expect(saveApiKey).toHaveBeenCalledWith('openai', 'sk-test-key')
  })

  it('explains that voice keys must be entered again after restarting', async () => {
    await render(<Harness voice={voiceBridge()} />)

    const realtime = container.querySelector<HTMLElement>('[aria-labelledby="voice-realtime-title"]')!
    expect(realtime.textContent).toContain('OpenAI 密钥只在 Kim 运行期间保存在内存里')
    expect(realtime.textContent).toContain('重启后需要重新输入')
    expect(container.textContent).not.toContain('keychain')
    expect(container.textContent).not.toContain('GNOME Keyring')
  })

  it('allows a key for this app session and explains it must be entered again after restarting', async () => {
    const message = 'Voice keys stay in memory while Kim is running. Enter them again after restarting Kim.'
    const saveApiKey = vi.fn().mockResolvedValue({
      configured: { openai: true, groq: false, deepgram: false, 'self-hosted': false },
      source: { openai: 'session' },
      storage: { available: false, message },
    } satisfies VoiceCredentialStatus)
    await render(<Harness voice={voiceBridge({
      credentialStatus: vi.fn().mockResolvedValue({
        configured: { openai: false, groq: false, deepgram: false, 'self-hosted': false },
        source: {},
        storage: { available: false, message },
      } satisfies VoiceCredentialStatus),
      saveApiKey,
    })} />)

    expect(container.textContent).toContain('语音密钥只在本次运行有效')
    expect(container.textContent).toContain('Enter them again after restarting Kim')
    expect(container.textContent).not.toContain('Storage locked')
    const openAiCard = [...container.querySelectorAll<HTMLElement>('.voice-connection-card')].find((card) => card.textContent?.includes('OpenAI'))!
    const addKey = [...openAiCard.querySelectorAll('button')].find((button) => button.textContent?.includes('添加密钥'))!
    expect(addKey.disabled).toBe(false)
    await click(addKey)

    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.textContent).toContain('只在本次运行期间把它保存在内存里')
    expect(dialog.textContent).toContain('重启后需要重新输入')
    const input = dialog.querySelector<HTMLInputElement>('input[type="password"]')!
    await enter(input, 'sk-session-key')
    const save = [...dialog.querySelectorAll('button')].find((button) => button.textContent?.includes('使用 API 密钥'))!
    await click(save)

    expect(saveApiKey).toHaveBeenCalledWith('openai', 'sk-session-key')
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(openAiCard.textContent).toContain('仅本次运行')
    expect(container.textContent).toContain('语音密钥只在本次运行有效')
  })

  it('explains how to recover an 旧桌面进程 instead of showing disabled key buttons', async () => {
    await render(<Harness voice={null} />)

    expect(container.textContent).toContain('重启 Kim 以完成语音功能的启用')
    expect(container.textContent).toContain('⌘Q')
    expect([...container.querySelectorAll('button')].some((button) => button.disabled && button.textContent?.includes('添加密钥'))).toBe(false)
  })

  it('connects and tests a self-hosted Parakeet or Whisper endpoint with an optional token', async () => {
    const testSelfHosted = vi.fn().mockResolvedValue(true)
    const saveApiKey = vi.fn().mockResolvedValue({
      configured: { openai: false, groq: false, deepgram: false, 'self-hosted': true },
      source: { 'self-hosted': 'session' },
      storage: emptyStatus.storage,
    } satisfies VoiceCredentialStatus)
    await render(<Harness voice={voiceBridge({ testSelfHosted, saveApiKey })} />)

    const service = container.querySelector<HTMLSelectElement>('select[aria-label="听写服务"]')!
    await choose(service, 'self-hosted')
    expect(container.textContent).toContain('连接你的转写服务')
    expect(container.textContent).toContain('Parakeet、Whisper')
    expect(container.querySelector('input[aria-label="whisper-cli executable"]')).toBeNull()
    expect(container.textContent).not.toContain('API key required')

    const url = container.querySelector<HTMLInputElement>('input[aria-label="自建服务地址"]')!
    const model = container.querySelector<HTMLInputElement>('input[aria-label="自建模型 ID"]')!
    await enter(url, 'http://127.0.0.1:9000')
    await enter(model, 'nvidia/parakeet-tdt-0.6b-v3')

    const addToken = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('添加令牌'))!
    await click(addToken)
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.textContent).toContain('可选的访问令牌')
    await enter(dialog.querySelector<HTMLInputElement>('input[type="password"]')!, 'local-token')
    await click([...dialog.querySelectorAll('button')].find((button) => button.textContent?.includes('使用令牌'))!)
    expect(saveApiKey).toHaveBeenCalledWith('self-hosted', 'local-token')

    await click([...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Connect & test'))!)
    expect(testSelfHosted).toHaveBeenCalledWith({ url: 'http://127.0.0.1:9000', model: 'nvidia/parakeet-tdt-0.6b-v3' })
    expect(container.textContent).toContain('已连接，Kim 成功转写了一段测试音频。')
  })

  it('turns a missing Voice IPC handler into a restart state instead of checking forever', async () => {
    const credentialStatus = vi.fn().mockRejectedValue(new Error("No handler registered for 'voice:credential-status'"))
    await render(<Harness voice={voiceBridge({ credentialStatus })} />)

    expect(container.textContent).toContain('重启 Kim 以完成语音功能的启用')
    expect(container.textContent).toContain('需要重启')
    expect(container.textContent).not.toContain('正在检查…')
    expect([...container.querySelectorAll('button')].some((button) => button.textContent?.includes('添加密钥'))).toBe(false)
  })
})
