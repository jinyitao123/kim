import { useState } from 'react'
import type { EnterpriseSession } from '@/types/api'
import { BrowserSignIn } from '../BrowserSignIn'
import { FeishuAccountSettings } from './FeishuAccountSettings'

interface EnterpriseAccountSettingsProps {
  session?: EnterpriseSession
  onSignIn(): Promise<void>
  onCancelSignIn(): Promise<void>
  onReopenSignIn(): Promise<void>
  onSignOut(): Promise<void>
}

export function EnterpriseAccountSettings({ session, onSignIn, onCancelSignIn, onReopenSignIn, onSignOut }: EnterpriseAccountSettingsProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const signOut = async () => {
    if (busy) return
    setBusy(true); setError('')
    try { await onSignOut() } catch (reason) {
      setError(reason instanceof Error ? reason.message : '退出失败，请稍后重试')
    } finally { setBusy(false) }
  }

  return <div className="settings-section enterprise-account-settings">
    <div className="settings-section__header"><h1>企业账号</h1></div>
    <section className="settings-group">
      <h2>Forge 与 Weave</h2>
      {session?.status === 'signed-in' && session.user ? <div className="settings-row enterprise-account-summary">
        <span><strong>{session.user.name}</strong><small>{session.user.email} · {session.organization?.name ?? session.organization?.id}</small></span>
        <button type="button" className="button" disabled={busy} onClick={() => void signOut()}>{busy ? '正在退出…' : '退出登录'}</button>
      </div> : <div className="enterprise-account-form">
        <BrowserSignIn session={session} buttonClassName="button button--primary" onSignIn={onSignIn} onCancelSignIn={onCancelSignIn} onReopenSignIn={onReopenSignIn} onError={setError} />
      </div>}
      {error || session?.message ? <p className="settings-error" role="alert">{error || session?.message}</p> : null}
      <p className="enterprise-account-origin">{session?.environment.origin || '正在读取 Forge 环境'}{session && !session.environment.secure ? ' · HTTP连接' : ''}</p>
    </section>
    {session?.status === 'signed-in' && session.user && <FeishuAccountSettings accountId={session.user.id} />}
  </div>
}
