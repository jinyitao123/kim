import { CircleHelp } from 'lucide-react'
import { WorkbenchMark } from '@/components/ui'
import type { AppMeta } from '@/types/api'

interface AboutSettingsProps {
  meta?: AppMeta | null
  onOpenDocs(): void
}

export function AboutSettings({ meta, onOpenDocs }: AboutSettingsProps) {
  return (
    <>
      <header><h1>关于 Kim</h1></header>
      <section className="about-card"><WorkbenchMark size={48} /><div><h2>Kim</h2><p>版本 {meta?.version ?? '0.1.0'}</p></div></section>
      <section className="settings-group">
        <div className="settings-row"><span><strong>平台</strong><small>{meta?.platform ?? 'macOS'}</small></span></div>
        <div className="settings-row"><span><strong>用户目录</strong><small className="mono">{meta?.homeDir ?? '—'}</small></span></div>
        <div className="settings-row"><span><strong>帮助与文档</strong></span><button className="button" type="button" onClick={onOpenDocs}><CircleHelp size={13} /> Open docs</button></div>
      </section>
    </>
  )
}
