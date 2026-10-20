import type { AppSettings } from '@/types/api'
import type { SettingsSectionProps } from './contracts'
import { SettingsToggle } from './SettingsToggle'

export function GeneralSettings({ settings, onUpdate, platform }: SettingsSectionProps & { platform: NodeJS.Platform }) {
  return (
    <>
      <header><h1>常规</h1><p>设置 Kim 在各个项目中的行为。</p></header>
      <section className="settings-group">
        <h2>窗口</h2>
        <SettingsToggle checked={settings.sidebarOpen} onChange={(sidebarOpen) => { void onUpdate({ sidebarOpen }) }} label="显示项目侧栏" description="打开应用时显示项目和对话列表。" />
        <SettingsToggle checked={settings.inspectorOpen} onChange={(inspectorOpen) => { void onUpdate({ inspectorOpen }) }} label="打开右侧面板" description="新打开的对话显示摘要面板。" />
        <SettingsToggle checked={settings.showFileChangesPopup} onChange={(showFileChangesPopup) => { void onUpdate({ showFileChangesPopup }) }} label="显示文件改动卡片" description="工作区有未提交的改动时，在输入框上方显示改动卡片。" />
      </section>
      {platform === 'darwin' ? (
        <section className="settings-group">
          <h2>启动与后台</h2>
          <SettingsToggle checked={settings.keepRunningInBackground} onChange={(keepRunningInBackground) => { void onUpdate({ keepRunningInBackground }) }} label="关闭窗口后继续运行" description="在菜单栏继续运行定时任务，直到退出应用。" />
          <SettingsToggle checked={settings.launchAtLogin} onChange={(launchAtLogin) => { void onUpdate({ launchAtLogin }) }} label="登录时启动" description="登录这台 Mac 时在后台启动应用。" />
        </section>
      ) : null}
      <section className="settings-group">
        <h2>对话默认设置</h2>
        <label className="settings-row">
          <span><strong>Git 切换方式</strong><small>工作树为每个任务使用独立文件夹，适合并行工作；分支复用同一个文件夹，要求项目没有未提交改动且空闲。</small></span>
          <select value={settings.checkoutStrategy} onChange={(event) => {
            const checkoutStrategy = event.target.value
            if (checkoutStrategy === 'worktree' || checkoutStrategy === 'branch') void onUpdate({ checkoutStrategy })
          }}>
            <option value="worktree">工作树</option>
            <option value="branch">分支</option>
          </select>
        </label>
        <label className="settings-row">
          <span><strong>默认面板标签</strong><small>打开对话时右侧面板默认显示的内容。</small></span>
          <select value={settings.defaultInspectorTab} onChange={(event) => { void onUpdate({ defaultInspectorTab: event.target.value as AppSettings['defaultInspectorTab'] }) }}>
            <option value="summary">摘要</option>
            <option value="changes">改动</option>
            <option value="browser">浏览器</option>
            <option value="files">文件</option>
          </select>
        </label>
      </section>
    </>
  )
}
