import { Check, KeyRound, Laptop, LoaderCircle, Mic2, Radio, RefreshCw, Server, ShieldAlert, ShieldCheck, Trash2, Waves } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Modal } from '@/components/ui'
import { errorMessage } from '@/lib/errors'
import { shortcutLabel } from '@/lib/platform-shortcuts'
import {
  DEEPGRAM_MODELS,
  GROQ_MODELS,
  OPENAI_FILE_MODELS,
  OPENAI_LIVE_MODELS,
  REALTIME_MODELS,
  REALTIME_VOICES,
  VOICE_PROVIDER_OPTIONS,
  optionsWithCurrent,
  type VoiceOption,
} from '@/lib/voice-options'
import type { AppSettings, PrimeWorkApi, VoiceCredentialProvider, VoiceCredentialStatus, VoiceTranscriptionProvider } from '@/types/api'
import type { SettingsSectionProps } from './contracts'

const CREDENTIALS: Array<{ id: VoiceCredentialProvider; name: string; monogram: string; detail: string }> = [
  { id: 'openai', name: 'OpenAI', monogram: 'OA', detail: '实时听写和语音球需要它。' },
  { id: 'groq', name: 'Groq', monogram: 'GQ', detail: '仅在听写服务选择 Groq 时使用。' },
  { id: 'deepgram', name: 'Deepgram', monogram: 'DG', detail: '仅在听写服务选择 Deepgram 时使用。' },
  { id: 'self-hosted', name: '自建服务', monogram: 'SH', detail: 'Parakeet 或 Whisper 服务的可选访问令牌。' },
]

const CONNECTION_CREDENTIALS = CREDENTIALS.filter((item) => item.id !== 'self-hosted')

interface VoiceSettingsProps extends SettingsSectionProps {
  voice: PrimeWorkApi['voice'] | null
  platform?: NodeJS.Platform
}

type VoiceServiceState = 'checking' | 'ready' | 'restart-required' | 'error'
type SelfHostedTestState = 'idle' | 'testing' | 'connected' | 'error'

function needsDesktopRestart(error: unknown): boolean {
  return /No handler registered for ['"]voice:/i.test(errorMessage(error))
}

function ModelSelect({ label, description, value, options, onChange }: { label: string; description: string; value: string; options: VoiceOption[]; onChange(value: string): void }) {
  const choices = optionsWithCurrent(options, value)
  const selected = choices.find((option) => option.value === value)
  return (
    <label className="voice-choice-row">
      <span><strong>{label}</strong><small>{description}</small></span>
      <span className="voice-choice-control">
        <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
          {choices.map((option) => <option key={option.value} value={option.value}>{option.label}{option.recommended ? ' · 推荐' : ''}</option>)}
        </select>
        {selected ? <small>{selected.detail}</small> : null}
      </span>
    </label>
  )
}

function PathInput({ label, description, placeholder, value, onCommit }: { label: string; description: string; placeholder: string; value: string; onCommit(value: string): void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <label className="voice-path-field">
      <span><strong>{label}</strong><small>{description}</small></span>
      <input aria-label={label} value={draft} placeholder={placeholder} spellCheck={false} onChange={(event) => setDraft(event.target.value)} onBlur={() => { if (draft !== value) onCommit(draft) }} />
    </label>
  )
}

export function VoiceSettings({ settings, onUpdate, voice, platform = 'darwin' }: VoiceSettingsProps) {
  const [status, setStatus] = useState<VoiceCredentialStatus | null>(null)
  const [serviceState, setServiceState] = useState<VoiceServiceState>(voice ? 'checking' : 'restart-required')
  const [credential, setCredential] = useState<VoiceCredentialProvider | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const [selfHostedUrl, setSelfHostedUrl] = useState(settings.voiceSelfHostedUrl)
  const [selfHostedModel, setSelfHostedModel] = useState(settings.voiceSelfHostedModel)
  const [selfHostedTestState, setSelfHostedTestState] = useState<SelfHostedTestState>('idle')
  const [selfHostedMessage, setSelfHostedMessage] = useState('')

  useEffect(() => setSelfHostedUrl(settings.voiceSelfHostedUrl), [settings.voiceSelfHostedUrl])
  useEffect(() => setSelfHostedModel(settings.voiceSelfHostedModel), [settings.voiceSelfHostedModel])

  useEffect(() => {
    let active = true
    if (!voice) { setServiceState('restart-required'); return }
    setServiceState('checking')
    void voice.credentialStatus().then((next) => {
      if (active) { setStatus(next); setServiceState('ready') }
    }).catch((error) => {
      if (!active) return
      setStatus(null)
      if (needsDesktopRestart(error)) { setCredential(null); setFailure(''); setServiceState('restart-required') }
      else { setFailure(errorMessage(error)); setServiceState('error') }
    })
    return () => { active = false }
  }, [voice])

  const saveCredential = async () => {
    if (!voice || !credential || !apiKey.trim()) return
    setBusy(true); setFailure('')
    try {
      setStatus(await voice.saveApiKey(credential, apiKey))
      setApiKey(''); setCredential(null)
    } catch (error) { setFailure(errorMessage(error)) } finally { setBusy(false) }
  }

  const removeCredential = async (provider: VoiceCredentialProvider) => {
    if (!voice) return
    setBusy(true); setFailure('')
    try { setStatus(await voice.deleteApiKey(provider)) } catch (error) { setFailure(errorMessage(error)) } finally { setBusy(false) }
  }

  const closeCredential = () => { if (!busy) { setCredential(null); setApiKey(''); setFailure('') } }
  const openCredential = (provider: VoiceCredentialProvider) => { setFailure(''); setCredential(provider) }
  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => { void onUpdate({ [key]: value } as Pick<AppSettings, K>) }
  const testSelfHosted = async () => {
    if (!voice || !selfHostedUrl.trim()) return
    setSelfHostedTestState('testing'); setSelfHostedMessage('')
    const url = selfHostedUrl.trim()
    const model = selfHostedModel.trim()
    try {
      await voice.testSelfHosted({ url, model })
      await onUpdate({ voiceSelfHostedUrl: url, voiceSelfHostedModel: model })
      setSelfHostedTestState('connected')
      setSelfHostedMessage('已连接，Kim 成功转写了一段测试音频。')
    } catch (error) {
      setSelfHostedTestState('error')
      setSelfHostedMessage(errorMessage(error))
    }
  }
  const provider = VOICE_PROVIDER_OPTIONS.find((option) => option.value === settings.voiceTranscriptionProvider) ?? VOICE_PROVIDER_OPTIONS[0]
  const selectedCredential = provider.credential
  const selectedConfigured = selectedCredential ? status?.configured[selectedCredential] ?? false : true
  const sessionOnly = status ? !status.storage.available : false

  return (
    <>
      <header className="voice-settings-header">
        <span className="voice-settings-header__icon"><Mic2 size={19} /></span>
        <div><h1>语音</h1><p>连接语音服务、选择模型，然后就可以用麦克风或语音球。</p></div>
      </header>

      {serviceState === 'restart-required' ? (
        <div className="voice-bridge-notice" role="status">
          <RefreshCw size={17} />
          <span><strong>重启 Kim 以完成语音功能的启用</strong><small>当前窗口连接的是没有语音功能的旧桌面进程。请用 {shortcutLabel(platform, ['Primary', 'Q'])} 完全退出 Kim 后再打开。</small></span>
        </div>
      ) : null}

      <section className="voice-section" aria-labelledby="voice-connections-title">
        <div className="voice-section__heading">
          <span><ShieldCheck size={15} /></span>
          <div><h2 id="voice-connections-title">连接</h2><p>为托管服务添加密钥。语音密钥只在 Kim 运行期间保存在内存里，重启后需要重新输入。</p></div>
        </div>
        {serviceState === 'ready' && status && sessionOnly ? (
          <div className="voice-storage-notice" role="status">
            <KeyRound size={17} />
            <span><strong>语音密钥只在本次运行有效</strong><small>{status.storage.message ?? '密钥只在本次启动期间有效，重启 Kim 后需要重新输入。'} You can still add a key for this session.</small></span>
          </div>
        ) : null}
        {voice ? <div className="voice-connection-grid">
          {CONNECTION_CREDENTIALS.map((item) => {
            const configured = status?.configured[item.id] ?? false
            const source = status?.source[item.id]
            return (
              <article className={`voice-connection-card${configured ? ' is-connected' : ''}`} key={item.id}>
                <span className="voice-provider-mark" aria-hidden="true">{item.monogram}</span>
                <div className="voice-connection-card__body">
                  <span className="voice-connection-card__title"><strong>{item.name}</strong><i>{serviceState === 'checking' ? '正在检查…' : serviceState === 'restart-required' ? '需要重启' : serviceState === 'error' ? '不可用' : configured ? source === 'environment' ? '环境变量密钥' : source === 'session' ? '仅本次运行' : '已连接' : '未连接'}</i></span>
                  <small>{item.detail}</small>
                </div>
                {serviceState === 'ready' ? <button type="button" className="button" disabled={busy} onClick={() => openCredential(item.id)}><KeyRound size={13} /> {configured ? '更换密钥' : '添加密钥'}</button> : null}
                {serviceState === 'ready' && (source === 'saved' || source === 'session') ? <button type="button" className="button button--icon" aria-label={`移除 ${item.name} API 密钥`} disabled={busy} onClick={() => void removeCredential(item.id)}><Trash2 size={13} /></button> : null}
              </article>
            )
          })}
        </div> : null}
        {failure && !credential ? <p className="settings-error" role="alert">{failure}</p> : null}
      </section>

      <section className="voice-section" aria-labelledby="voice-dictation-title">
        <div className="voice-section__heading">
          <span><Waves size={15} /></span>
          <div><h2 id="voice-dictation-title">听写</h2><p>控制发送按钮旁边的麦克风。</p></div>
        </div>
        <div className="voice-setup-card">
          <label className="voice-choice-row">
            <span><strong>服务</strong><small>选择麦克风音频在哪里转写。</small></span>
            <span className="voice-choice-control">
              <select aria-label="听写服务" value={settings.voiceTranscriptionProvider} onChange={(event) => update('voiceTranscriptionProvider', event.target.value as VoiceTranscriptionProvider)}>
                {VOICE_PROVIDER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}{option.recommended ? ' · 推荐' : ''}</option>)}
              </select>
              <small>{provider.detail}</small>
            </span>
          </label>

          {settings.voiceTranscriptionProvider === 'openai-live' ? <ModelSelect label="听写模型" description="边说边出文字。" value={settings.voiceOpenAiLiveTranscriptionModel} options={OPENAI_LIVE_MODELS} onChange={(value) => update('voiceOpenAiLiveTranscriptionModel', value)} /> : null}
          {settings.voiceTranscriptionProvider === 'openai' ? <ModelSelect label="听写模型" description="停止录音后再转写。" value={settings.voiceOpenAiTranscriptionModel} options={OPENAI_FILE_MODELS} onChange={(value) => update('voiceOpenAiTranscriptionModel', value)} /> : null}
          {settings.voiceTranscriptionProvider === 'groq' ? <ModelSelect label="听写模型" description="在速度和 Whisper 最高准确度之间选择。" value={settings.voiceGroqTranscriptionModel} options={GROQ_MODELS} onChange={(value) => update('voiceGroqTranscriptionModel', value)} /> : null}
          {settings.voiceTranscriptionProvider === 'deepgram' ? <ModelSelect label="听写模型" description="选择通用或音频专用的 Nova 模型。" value={settings.voiceDeepgramTranscriptionModel} options={DEEPGRAM_MODELS} onChange={(value) => update('voiceDeepgramTranscriptionModel', value)} /> : null}
          {settings.voiceTranscriptionProvider === 'self-hosted' ? (
            <div className="voice-self-hosted-setup">
              <span className="voice-local-setup__intro"><Server size={15} /><span><strong>连接你的转写服务</strong><small>支持 Parakeet、Whisper 等实现了 OpenAI 转写接口的服务。</small></span></span>
              <label className="voice-path-field">
                <span><strong>服务地址</strong><small>填写服务的基础地址，或完整的 /v1/audio/transcriptions 地址。</small></span>
                <input aria-label="自建服务地址" type="url" value={selfHostedUrl} placeholder="http://127.0.0.1:9000" spellCheck={false} onChange={(event) => { setSelfHostedUrl(event.target.value); setSelfHostedTestState('idle'); setSelfHostedMessage('') }} onBlur={() => { const value = selfHostedUrl.trim(); if (value !== settings.voiceSelfHostedUrl) update('voiceSelfHostedUrl', value) }} />
              </label>
              <label className="voice-path-field">
                <span><strong>模型 ID</strong><small>可选。留空则使用服务默认的英文模型。</small></span>
                <input aria-label="自建模型 ID" value={selfHostedModel} placeholder="nvidia/parakeet-tdt-0.6b-v3" spellCheck={false} onChange={(event) => { setSelfHostedModel(event.target.value); setSelfHostedTestState('idle'); setSelfHostedMessage('') }} onBlur={() => { const value = selfHostedModel.trim(); if (value !== settings.voiceSelfHostedModel) update('voiceSelfHostedModel', value) }} />
              </label>
              <div className="voice-self-hosted-auth">
                <span><strong>访问令牌</strong><small>可选。只在 Kim 运行期间保存在内存里，重启后需要重新输入。</small></span>
                <span className="voice-self-hosted-auth__actions">
                  <i>{status?.configured['self-hosted'] ? status.source['self-hosted'] === 'session' ? '仅本次运行' : status.source['self-hosted'] === 'environment' ? '环境变量令牌' : '已设置令牌' : '未设置令牌'}</i>
                  {voice && serviceState === 'ready' ? <button type="button" className="button" disabled={busy} onClick={() => openCredential('self-hosted')}><KeyRound size={13} /> {status?.configured['self-hosted'] ? '更换令牌' : '添加令牌'}</button> : null}
                  {voice && serviceState === 'ready' && (status?.source['self-hosted'] === 'saved' || status?.source['self-hosted'] === 'session') ? <button type="button" className="button button--icon" aria-label="移除自建服务的访问令牌" disabled={busy} onClick={() => void removeCredential('self-hosted')}><Trash2 size={13} /></button> : null}
                </span>
              </div>
              <div className="voice-self-hosted-connect">
                <span><strong>连接检查</strong><small>上传 0.1 秒静音，验证实际的转写链路和模型。</small></span>
                <button type="button" className="button button--primary" disabled={!voice || !selfHostedUrl.trim() || selfHostedTestState === 'testing'} onClick={() => void testSelfHosted()}>{selfHostedTestState === 'testing' ? <LoaderCircle className="is-spinning" size={13} /> : <Server size={13} />} {selfHostedTestState === 'testing' ? '正在测试…' : 'Connect & test'}</button>
              </div>
              {selfHostedMessage ? <p className={`voice-self-hosted-result is-${selfHostedTestState}`} role={selfHostedTestState === 'error' ? 'alert' : 'status'}>{selfHostedTestState === 'connected' ? <Check size={13} /> : <ShieldAlert size={13} />}{selfHostedMessage}</p> : null}
              <p className="voice-self-hosted-note">本机和内网地址可以用 HTTP；公网地址请用 HTTPS。</p>
            </div>
          ) : null}
          {settings.voiceTranscriptionProvider === 'local-whisper' ? (
            <div className="voice-local-setup">
              <span className="voice-local-setup__intro"><Laptop size={15} /><span><strong>本地 whisper.cpp 设置</strong><small>这里填文件路径，因为 Kim 会直接运行你安装的 whisper.cpp；托管服务不需要。</small></span></span>
              <PathInput label="whisper-cli executable" description="whisper.cpp 命令行程序的路径。" placeholder="/opt/homebrew/bin/whisper-cli" value={settings.voiceLocalWhisperExecutable} onCommit={(value) => update('voiceLocalWhisperExecutable', value)} />
              <PathInput label="GGML 模型文件" description="已下载的 whisper.cpp 模型路径。" placeholder="/path/to/ggml-large-v3-turbo.bin" value={settings.voiceLocalWhisperModel} onCommit={(value) => update('voiceLocalWhisperModel', value)} />
            </div>
          ) : null}

          {settings.voiceTranscriptionProvider === 'self-hosted' ? (
            <div className={`voice-requirement${selfHostedUrl.trim() ? ' is-ready' : ''}`}>
              <span>{selfHostedUrl.trim() ? <Check size={13} /> : <Server size={13} />}{selfHostedUrl.trim() ? '已配置自建服务' : '需要服务地址'}</span>
            </div>
          ) : selectedCredential ? (
            <div className={`voice-requirement${selectedConfigured ? ' is-ready' : ''}`}>
              <span>{selectedConfigured ? <Check size={13} /> : <KeyRound size={13} />}{selectedConfigured ? `${CREDENTIALS.find((item) => item.id === selectedCredential)?.name} is connected` : `${CREDENTIALS.find((item) => item.id === selectedCredential)?.name} key required`}</span>
              {!selectedConfigured && voice && serviceState === 'ready' ? <button type="button" onClick={() => openCredential(selectedCredential)}>添加密钥</button> : null}
            </div>
          ) : <div className="voice-requirement is-ready"><span><Check size={13} />在本地运行，不需要 API 密钥</span></div>}
        </div>
      </section>

      <section className="voice-section" aria-labelledby="voice-realtime-title">
        <div className="voice-section__heading">
          <span><Radio size={15} /></span>
          <div><h2 id="voice-realtime-title">语音球</h2><p>可拖动的语音助手，使用你的 OpenAI 连接。</p></div>
        </div>
        <div className="voice-setup-card">
          <ModelSelect label="实时模型" description="负责对话、网页搜索和任务分派。" value={settings.voiceRealtimeModel} options={REALTIME_MODELS} onChange={(value) => update('voiceRealtimeModel', value)} />
          <ModelSelect label="说话声音" description="语音球回答时使用的声音。" value={settings.voiceRealtimeVoice} options={REALTIME_VOICES} onChange={(value) => update('voiceRealtimeVoice', value)} />
          <div className={`voice-requirement${status?.configured.openai ? ' is-ready' : ''}`}>
            <span>{status?.configured.openai ? <Check size={13} /> : <KeyRound size={13} />}{status?.configured.openai ? 'OpenAI 已连接' : '需要 OpenAI 密钥'}</span>
            {!status?.configured.openai && voice && serviceState === 'ready' ? <button type="button" onClick={() => openCredential('openai')}>添加密钥</button> : null}
          </div>
          {sessionOnly ? <p className="voice-realtime-note">OpenAI 密钥只在 Kim 运行期间保存在内存里，重启后需要重新输入。</p> : null}
        </div>
      </section>

      {credential ? <Modal title={`连接 ${CREDENTIALS.find((item) => item.id === credential)?.name ?? credential}`} onClose={closeCredential} footer={<><button type="button" className="button" disabled={busy} onClick={closeCredential}>取消</button><button type="button" className="button button--primary" disabled={busy || !apiKey.trim()} onClick={() => void saveCredential()}>{busy ? '正在应用…' : credential === 'self-hosted' ? '使用令牌' : '使用 API 密钥'}</button></>}>
        <p className="modal-intro">粘贴{credential === 'self-hosted' ? '可选的访问令牌' : '服务商的 API 密钥'}。{sessionOnly ? 'Kim 只在本次运行期间把它保存在内存里，重启后需要重新输入。' : 'Kim 会在本机加密保存，之后不再显示密钥。'}</p>
        {failure ? <p className="settings-error" role="alert">{failure}</p> : null}
        <label className="field"><span>{credential === 'self-hosted' ? '访问令牌' : 'API 密钥'}</span><input autoFocus type="password" value={apiKey} autoComplete="off" spellCheck={false} placeholder={credential === 'self-hosted' ? '粘贴访问令牌' : '粘贴 API 密钥'} onChange={(event) => setApiKey(event.target.value)} /></label>
      </Modal> : null}
    </>
  )
}
