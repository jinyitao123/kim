import { ArrowRight, LoaderCircle } from 'lucide-react'
import { useState } from 'react'
import type { EnterpriseSession } from '@/types/api'

interface BrowserSignInProps {
  session?: EnterpriseSession
  disabled?: boolean
  buttonClassName: string
  onSignIn(): Promise<void>
  onCancelSignIn(): Promise<void>
  onReopenSignIn(): Promise<void>
  onError(message: string): void
}

const CANCELLED = '已取消登录'
const message = (reason: unknown, fallback: string) => reason instanceof Error && reason.message ? reason.message : fallback

/** Starts a sign-in the employee finishes in their browser, and shows the code to compare there. */
export function BrowserSignIn({ session, disabled, buttonClassName, onSignIn, onCancelSignIn, onReopenSignIn, onError }: BrowserSignInProps) {
  const [busy, setBusy] = useState(false)
  const pending = session?.status === 'signed-in' ? undefined : session?.signIn

  const start = async () => {
    if (busy || disabled) return
    setBusy(true); onError('')
    try { await onSignIn() } catch (reason) {
      const text = message(reason, '登录失败，请稍后重试')
      // Cancelling is the employee's own choice, not a failure to report back to them.
      if (!text.includes(CANCELLED)) onError(text)
    } finally { setBusy(false) }
  }
  const reopen = () => void onReopenSignIn().catch((reason: unknown) => onError(message(reason, '无法打开浏览器')))
  const cancel = () => void onCancelSignIn().catch((reason: unknown) => onError(message(reason, '取消失败，请稍后重试')))

  if (pending) return <div className="browser-sign-in" role="status">
    <p>请在浏览器中确认登录，并核对确认码</p>
    <output className="browser-sign-in__code" aria-label="确认码">{pending.userCode}</output>
    <div className="browser-sign-in__actions">
      <button type="button" className="button" onClick={reopen}>重新打开浏览器</button>
      <button type="button" className="button" onClick={cancel}>取消</button>
    </div>
  </div>

  return <button type="button" className={buttonClassName} autoFocus disabled={busy || disabled} onClick={() => void start()}>
    {busy ? <><LoaderCircle className="spin" size={15}/>正在登录</> : <>登录<ArrowRight size={15}/></>}
  </button>
}
