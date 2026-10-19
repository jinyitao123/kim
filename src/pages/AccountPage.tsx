import { useState } from 'react'
import { WorkbenchMark } from '@/components/ui'
import type { EnterpriseConnectionImportResult, EnterpriseSession } from '@/types/api'
import { BrowserSignIn } from './BrowserSignIn'

interface AccountPageProps {
  session?: EnterpriseSession
  onSignIn(): Promise<void>
  onCancelSignIn(): Promise<void>
  onReopenSignIn(): Promise<void>
  onImportConnection?(): Promise<EnterpriseConnectionImportResult>
  onRestartConnection?(): Promise<void>
}

export function AccountPage({ session, onSignIn, onCancelSignIn, onReopenSignIn, onImportConnection, onRestartConnection }: AccountPageProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [connection, setConnection] = useState<EnterpriseConnectionImportResult>()
  const restartRequired = connection !== undefined && connection.status !== 'cancelled' && connection.restartRequired
  const importConnection = async () => {
    if (busy || !onImportConnection) return
    setBusy(true); setError('')
    try { const result = await onImportConnection(); if (result.status !== 'cancelled') setConnection(result) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '连接导入失败') }
    finally { setBusy(false) }
  }

  return <main className="account-page">
    <section className="account-card" aria-labelledby="account-title">
      <div className="account-mark" aria-hidden="true"><WorkbenchMark size={64} /></div>
      <h1 id="account-title">登录</h1>
      <BrowserSignIn session={session} disabled={busy || restartRequired} buttonClassName="account-submit" onSignIn={onSignIn} onCancelSignIn={onCancelSignIn} onReopenSignIn={onReopenSignIn} onError={setError} />
      {error || session?.message ? <p className="account-error" role="alert">{error || session?.message}</p> : null}
      <small>{session?.environment.origin || '正在读取企业环境'}{session && !session.environment.secure ? ' · HTTP连接' : ''}</small>
      {onImportConnection && <button type="button" className="button" disabled={busy || Boolean(session?.signIn)} onClick={() => void importConnection()}>导入组织连接</button>}
      {connection && connection.status !== 'cancelled' && <div role="status">
        <p>Forge：{connection.config.forgeOrigin}<br/>Weave：{connection.config.weaveOrigin}</p>
        <p>{connection.status === 'unchanged' ? '连接文件未变化。' : '组织连接已保存。'}{connection.environmentOverride ? '当前仍使用开发连接覆盖，请管理员处理覆盖后重启。' : connection.restartRequired ? '重启后生效。' : '当前连接地址一致。'}</p>
        {connection.restartRequired && <button type="button" className="button" onClick={() => void onRestartConnection?.().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '重启失败'))}>重启应用</button>}
      </div>}
    </section>
  </main>
}
