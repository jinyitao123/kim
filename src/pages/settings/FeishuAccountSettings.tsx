import { useEffect, useRef, useState } from 'react'

export function FeishuAccountSettings({ accountId }: { accountId: string }) {
  const [status, setStatus] = useState<{ available: boolean; bound: boolean }>()
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string }>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  useEffect(() => {
    const expected = ++generation.current
    setPairing(undefined); setStatus(undefined); setError(''); setBusy(false)
    if (!window.prime?.enterprise?.getFeishuStatus) { setError('飞书连接状态暂不可用'); return () => { generation.current++ } }
    void window.prime.enterprise.getFeishuStatus().then((value) => { if (generation.current === expected) setStatus(value) }).catch(() => { if (generation.current === expected) setError('飞书连接状态暂不可用') })
    return () => { generation.current++ }
  }, [accountId])
  useEffect(() => {
    if (!pairing) return
    const timer = setTimeout(() => setPairing(undefined), Math.max(0, Date.parse(pairing.expiresAt) - Date.now()))
    return () => clearTimeout(timer)
  }, [pairing])
  const perform = async (action: 'link' | 'unlink' | 'refresh') => {
    if (busy) return
    const expected = generation.current
    setBusy(true); setError('')
    try {
      if (action === 'link') {
        const value = await window.prime.enterprise.createFeishuLinkCode()
        if (expected === generation.current) setPairing(value)
      } else {
        if (action === 'unlink') await window.prime.enterprise.unlinkFeishu()
        const value = await window.prime.enterprise.getFeishuStatus()
        if (expected === generation.current) { setStatus(value); if (action === 'unlink' || value.bound) setPairing(undefined) }
      }
    } catch { if (expected === generation.current) setError('飞书连接操作失败，请稍后重试') }
    finally { if (expected === generation.current) setBusy(false) }
  }
  return <section className="settings-group">
    <h2>飞书</h2>
    <div className="settings-row">
      <span>{status ? !status.available ? '未配置' : status.bound ? '已连接' : '未连接' : '正在读取'}</span>
      {status?.available && <div>
        <button type="button" className="button" disabled={busy} onClick={() => void perform('link')}>{status.bound ? '重新绑定' : '连接飞书'}</button>
        {status.bound && <button type="button" className="button" disabled={busy} onClick={() => void perform('unlink')}>解除连接</button>}
      </div>}
    </div>
    {pairing && <div role="status">
      <p>在飞书机器人私聊发送以下内容，10分钟内有效。</p>
      <p><code>绑定 {pairing.code}</code></p>
      <button type="button" className="button" disabled={busy} onClick={() => void perform('refresh')}>检查连接</button>
    </div>}
    {error && <p className="settings-error" role="alert">{error}</p>}
  </section>
}
