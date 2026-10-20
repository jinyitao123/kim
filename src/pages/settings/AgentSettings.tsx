import { Bot, Keyboard, RefreshCw, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { HARNESS_IDS, type HarnessId } from '@/types/api'
import { errorMessage } from '@/lib/errors'
import { HARNESS_AGENT_NAMES, HARNESS_PRODUCT_NAMES } from '@/lib/harness'
import { detectRendererPlatform, shortcutLabel } from '@/lib/platform-shortcuts'
import type { SettingsMetaSectionProps } from './contracts'
import { DraftSettingField } from './DraftSettingField'
import { SettingsToggle } from './SettingsToggle'

export function AgentSettings({ settings, meta, onUpdate, onRefreshHarnesses }: SettingsMetaSectionProps) {
  const activeHarness = settings.activeHarness
  const detectedHarnesses = HARNESS_IDS.filter((harness) => Boolean(meta?.harnesses[harness].path))
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState('')
  const platform = meta?.platform ?? detectRendererPlatform()
  const oppositeActionShortcut = shortcutLabel(platform, ['Primary', 'Enter'])
  const newLineShortcut = shortcutLabel(platform, ['Shift', 'Enter'])
  const refreshHarnesses = async () => {
    if (refreshing) return
    setRefreshing(true)
    setRefreshError('')
    try { await onRefreshHarnesses() } catch (error) { setRefreshError(errorMessage(error)) }
    finally { setRefreshing(false) }
  }
  const runtimePathValidation = (value: string, harness: HarnessId): string => {
    if (!value) return ''
    const absolute = meta?.platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') : value.startsWith('/')
    return absolute ? '' : `${HARNESS_AGENT_NAMES[harness]} path must be absolute (or blank for automatic discovery)`
  }
  return (
    <>
      <header><h1>运行环境</h1><p>内核检测、模型服务商和工作区权限。</p></header>
      <section className="settings-group">
        <h2>运行环境</h2>
        <label className="settings-row">
          <span><strong>默认内核</strong><small>默认打开的内核，与左上角内核菜单的当前选择一致。</small></span>
          <select value={detectedHarnesses.includes(activeHarness) ? activeHarness : ''} disabled={!detectedHarnesses.length} onChange={(event) => { void onUpdate({ activeHarness: event.target.value as HarnessId }) }}>
            {!detectedHarnesses.length ? <option value="">没有检测到内核</option> : null}
            {detectedHarnesses.map((harness) => <option key={harness} value={harness}>{HARNESS_PRODUCT_NAMES[harness]}</option>)}
          </select>
        </label>
      </section>
      <section className="settings-group">
        <div className="settings-group__heading">
          <h2>运行环境检测</h2>
          <button type="button" className="button button--compact" disabled={refreshing} onClick={() => { void refreshHarnesses() }}>
            <RefreshCw className={refreshing ? 'spin' : ''} size={13} />{refreshing ? '正在检测…' : '重新检测内核'}
          </button>
        </div>
        {refreshError ? <p className="settings-error" role="alert">{refreshError}</p> : null}
        {HARNESS_IDS.map((harness) => {
          const name = HARNESS_AGENT_NAMES[harness]
          const status = meta?.harnesses[harness]
          return (
            <div className="runtime-card" key={harness}>
              <span className={status?.path ? 'is-online' : ''}><Bot size={17} /></span>
              <div>
                <strong>{status?.path ? `${name} is ready` : `${name} not detected`}</strong>
                <small title={status?.problem ? `${status.problem.path}: ${status.problem.reason}` : undefined}>{status?.path ?? (status?.problem ? `${status.problem.path}: ${status.problem.reason}` : `安装 ${name} 后重新检测内核。`)}</small>
              </div>
              {status?.version ? <code>v{status.version}</code> : null}
            </div>
          )
        })}
        <p className="settings-group__description">检测顺序：已保存的路径、内核的环境变量、随应用附带的文件、PATH 和常见安装目录。重新检测只影响之后的对话，不需要重启 Kim。</p>
        {HARNESS_IDS.map((harness) => <DraftSettingField
          key={harness}
          id={`runtime-path-${harness}`}
          label={`${HARNESS_AGENT_NAMES[harness]} executable override`}
          description="可选的绝对路径；留空则自动检测。"
          committedValue={settings.runtimePaths[harness]}
          validate={(value) => runtimePathValidation(value.trim(), harness)}
          normalize={(value) => value.trim()}
          onCommit={async (value) => {
            await onUpdate({ runtimePaths: { ...settings.runtimePaths, [harness]: value } })
            await refreshHarnesses()
          }}
        />)}
      </section>
      <section className="settings-group">
        <h2>对话显示</h2>
        <SettingsToggle checked={settings.showReasoningSummaries} onChange={(showReasoningSummaries) => { void onUpdate({ showReasoningSummaries }) }} label="显示思考摘要" description="智能体工作时显示思考摘要和过程，完成后自动收起。" />
        <SettingsToggle checked={settings.showToolCalls} onChange={(showToolCalls) => { void onUpdate({ showToolCalls }) }} label="显示工具调用" description="显示简洁的工具调用、参数和可展开的结果。" />
      </section>
      <section className="settings-group">
        <h2>消息快捷键</h2>
        <label className="settings-row">
          <span><strong>智能体工作时按 Enter 的作用</strong><small>{oppositeActionShortcut} always uses the opposite action. {newLineShortcut} adds a new line.</small></span>
          <span className="shortcut-choice" role="radiogroup" aria-label="Enter 的作用">
            {(['queue', 'steer'] as const).map((action) => <button key={action} type="button" className={`button button--compact ${settings.messageEnterAction === action ? 'is-active' : ''}`} role="radio" aria-checked={settings.messageEnterAction === action} onClick={() => { void onUpdate({ messageEnterAction: action }) }}>{action === 'queue' ? '排队' : '插话'}</button>)}
          </span>
        </label>
        <div className="shortcut-row"><span><Keyboard size={14} />{settings.messageEnterAction === 'queue' ? '排队发送' : '插话调整本轮'}</span><kbd>Enter</kbd></div>
        <div className="shortcut-row"><span><Keyboard size={14} />{settings.messageEnterAction === 'queue' ? '插话调整本轮' : '排队发送'}</span><kbd>{oppositeActionShortcut}</kbd></div>
      </section>
      <section className="settings-group">
        <h2>权限</h2>
        <div className="info-row"><ShieldCheck size={15} /><div><strong>工作区访问</strong><small>智能体只能访问对话所关联的项目文件夹。</small></div></div>
      </section>
    </>
  )
}
