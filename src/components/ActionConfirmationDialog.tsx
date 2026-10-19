import { useEffect, useRef, useState } from 'react'
import type { ActionConfirmationEvent, ActionConfirmationRequest } from '@/types/api'
import { Modal } from './ui'

interface ActionConfirmationDialogProps {
  subscribe(callback: (request: ActionConfirmationEvent) => void): () => void
  answer(id: string, confirmed: boolean): Promise<void>
}

/** Asks the employee whether to go ahead with a business action; the app takes the answer, the conversation never does. */
export function ActionConfirmationDialog({ subscribe, answer }: ActionConfirmationDialogProps) {
  const [request, setRequest] = useState<ActionConfirmationRequest>()
  const currentRequest = useRef<ActionConfirmationRequest>(undefined)
  useEffect(() => subscribe((next) => {
    if ('closed' in next) {
      if (currentRequest.current?.id !== next.id) return
      currentRequest.current = undefined
      setRequest(undefined)
      return
    }
    // A newer question replaces one still open; the older one is declined.
    const previous = currentRequest.current
    currentRequest.current = next
    if (previous) void answer(previous.id, false)
    setRequest(next)
  }), [subscribe, answer])
  if (!request) return null

  const finish = (confirmed: boolean) => {
    currentRequest.current = undefined
    void answer(request.id, confirmed)
    setRequest(undefined)
  }
  return <Modal title="确认办理" onClose={() => finish(false)}>
    <dl className="action-confirmation">
      <div><dt>办理事项</dt><dd>{request.action}</dd></div>
      <div><dt>业务记录</dt><dd>{request.record}</dd></div>
      {request.fields.map((field, index) => <div key={`${field.label}-${index}`}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}
    </dl>
    <div className="extension-question__options" role="group" aria-label="确认办理">
      <button type="button" onClick={() => finish(true)}>办理</button>
      <button type="button" onClick={() => finish(false)}>不办理</button>
    </div>
  </Modal>
}
