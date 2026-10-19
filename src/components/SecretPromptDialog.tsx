import { useEffect, useRef, useState } from 'react'
import type { SecretPromptEvent, SecretPromptRequest } from '@/types/api'
import { Modal } from './ui'

interface SecretPromptDialogProps {
  subscribe(callback: (request: SecretPromptEvent) => void): () => void
  answer(id: string, value: string | null): Promise<void>
}

/** Takes a secret the assistant asked for and hands it to the app itself; the conversation never sees it. */
export function SecretPromptDialog({ subscribe, answer }: SecretPromptDialogProps) {
  const [request, setRequest] = useState<SecretPromptRequest>()
  const [value, setValue] = useState('')
  const currentRequest = useRef<SecretPromptRequest>(undefined)
  useEffect(() => subscribe((next) => {
    if ('closed' in next) {
      if (currentRequest.current?.id !== next.id) return
      currentRequest.current = undefined
      setRequest(undefined)
      setValue('')
      return
    }
    // A newer request replaces one still open; the older one is declined.
    const previous = currentRequest.current
    currentRequest.current = next
    if (previous) void answer(previous.id, null)
    setRequest(next)
    setValue('')
  }), [subscribe, answer])
  if (!request) return null

  const finish = (secret: string | null) => {
    currentRequest.current = undefined
    void answer(request.id, secret)
    setRequest(undefined)
    setValue('')
  }
  return <Modal title={request.title} onClose={() => finish(null)} footer={<>
    <button type="button" className="button" onClick={() => finish(null)}>取消</button>
    <button type="submit" form="secret-prompt-form" className="button button--primary" disabled={!value.trim()}>保存</button>
  </>}>
    <form id="secret-prompt-form" onSubmit={(event) => { event.preventDefault(); if (value.trim()) finish(value) }}>
      {request.detail ? <p>{request.detail}</p> : null}
      <label className="field"><span>{request.label}</span>
        <input autoFocus type="password" name="secret" maxLength={4096} autoComplete="off" spellCheck={false} value={value} onChange={(event) => setValue(event.target.value)} />
      </label>
    </form>
  </Modal>
}
