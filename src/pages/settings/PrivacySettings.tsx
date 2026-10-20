import { Bot, LockKeyhole } from 'lucide-react'
import type { SettingsSectionProps } from './contracts'

export function PrivacySettings(_props: SettingsSectionProps) {
  return (
    <>
      <header><h1>隐私</h1><p>了解 Kim 如何保存设置以及如何连接智能体。</p></header>
      <section className="settings-group">
        <h2>本地数据</h2>
        <div className="info-row"><LockKeyhole size={15} /><div><strong>设置保存在本机</strong><small>项目信息和界面设置保存在这台设备上。</small></div></div>
      </section>
      <section className="settings-group">
        <h2>智能体请求</h2>
        <div className="info-row"><Bot size={15} /><div><strong>请求经由你选择的智能体</strong><small>对话请求按所选智能体及其服务商配置发出。</small></div></div>
      </section>
    </>
  )
}
