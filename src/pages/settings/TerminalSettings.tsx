import { Keyboard } from 'lucide-react'
import type { SettingsSectionProps } from './contracts'
import { shortcutLabel } from '@/lib/platform-shortcuts'
import { terminalShellValidation } from './draft-state'
import { DraftSettingField } from './DraftSettingField'
import { SettingsToggle } from './SettingsToggle'

export function TerminalSettings({ settings, onUpdate, platform = 'darwin' }: SettingsSectionProps & { platform?: NodeJS.Platform }) {
  return (
    <>
      <header><h1>终端</h1><p>设置本地项目使用的交互式 Shell。</p></header>
      <section className="settings-group">
        <h2>Shell</h2>
        <DraftSettingField
          id="terminal-shell"
          label="Shell 可执行文件"
          description="修改后需要重启已打开的终端。"
          committedValue={settings.terminalShell}
          validate={terminalShellValidation}
          onCommit={(terminalShell) => onUpdate({ terminalShell })}
          className="mono"
        />
        <SettingsToggle checked={settings.terminalOpen} onChange={(terminalOpen) => { void onUpdate({ terminalOpen }) }} label="新对话自动打开终端" description="新建项目对话时显示终端。" />
      </section>
      <section className="settings-group">
        <h2>快捷键</h2>
        <div className="shortcut-row"><span><Keyboard size={14} />显示或隐藏终端</span><kbd>{shortcutLabel(platform, ['Primary', 'J'])}</kbd></div>
      </section>
    </>
  )
}
