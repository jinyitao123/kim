import { RotateCcw } from 'lucide-react'
import type { SettingsSectionProps } from './contracts'
import { browserHomeValidation, normalizeBrowserHome } from './draft-state'
import { DraftSettingField } from './DraftSettingField'
import { SettingsToggle } from './SettingsToggle'

interface BrowserSettingsProps extends SettingsSectionProps {
  onRequestReset(): void
}

export function BrowserSettings({ settings, onUpdate, onRequestReset }: BrowserSettingsProps) {
  return (
    <>
      <header><h1>浏览器</h1><p>管理 Kim 内置浏览器使用的独立配置。</p></header>
      <section className="settings-group">
        <h2>启动</h2>
        <DraftSettingField
          id="browser-home"
          label="主页"
          description="新建浏览器标签页时打开。"
          committedValue={settings.browserHome}
          validate={browserHomeValidation}
          normalize={normalizeBrowserHome}
          onCommit={(browserHome) => onUpdate({ browserHome })}
        />
        <SettingsToggle checked={settings.browserAskForDownloads} onChange={(browserAskForDownloads) => { void onUpdate({ browserAskForDownloads }) }} label="每次下载前询问保存位置" description="浏览器每次下载前先选择保存位置。" />
      </section>
      <section className="settings-group">
        <h2>浏览器数据</h2>
        <div className="danger-row">
          <span><strong>清除浏览数据</strong><small>删除 Cookie、缓存、权限和浏览历史。</small></span>
          <button type="button" className="button" onClick={onRequestReset}><RotateCcw size={13} /> Clear data</button>
        </div>
      </section>
    </>
  )
}
