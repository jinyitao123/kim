import { useEffect, useRef, useState } from 'react'
import type { OperationPromptEvent, OperationPromptRequest } from '@/types/api'
import { Modal } from './ui'

interface OperationPromptDialogProps {
  subscribe(callback: (request: OperationPromptEvent) => void): () => void
  answer(id: string, confirmed: boolean): Promise<void>
}

/** Asks the person before an operation that cannot be taken back, or shows them a secret it produced; the app takes the answer and the conversation sees neither. */
export function OperationPromptDialog({ subscribe, answer }: OperationPromptDialogProps) {
  const [request, setRequest] = useState<OperationPromptRequest>()
  const [copied, setCopied] = useState<number>()
  const currentRequest = useRef<OperationPromptRequest>(undefined)
  useEffect(() => subscribe((next) => {
    if ('closed' in next) {
      if (currentRequest.current?.id !== next.id) return
      currentRequest.current = undefined
      setRequest(undefined)
      return
    }
    // A newer dialog replaces one still open; the older one is declined.
    const previous = currentRequest.current
    currentRequest.current = next
    if (previous) void answer(previous.id, false)
    setRequest(next)
    setCopied(undefined)
  }), [subscribe, answer])
  if (!request) return null

  const finish = (confirmed: boolean) => {
    currentRequest.current = undefined
    void answer(request.id, confirmed)
    setRequest(undefined)
  }
  if (request.kind === 'reveal') {
    const copy = (index: number, value: string) => { void navigator.clipboard?.writeText(value).then(() => setCopied(index), () => undefined) }
    return <Modal title={request.title} onClose={() => finish(true)} footer={<button type="button" className="button button--primary" onClick={() => finish(true)}>关闭</button>}>
      <p>{request.message}</p>
      <dl className="operation-prompt operation-prompt--values">
        {(request.values ?? []).map((item, index) => <div key={`${item.label}-${index}`}>
          <dt>{item.label}</dt>
          <dd><code>{item.value}</code><button type="button" className="button" onClick={() => copy(index, item.value)}>{copied === index ? '已复制' : '复制'}</button></dd>
        </div>)}
      </dl>
    </Modal>
  }
  return <Modal title="确认办理" onClose={() => finish(false)}>
    <dl className="operation-prompt">
      <div><dt>办理事项</dt><dd>{request.title}</dd></div>
      {request.subject ? <div><dt>对象</dt><dd>{request.subject}</dd></div> : null}
      <div><dt>后果</dt><dd>{request.message}</dd></div>
    </dl>
    <div className="extension-question__options" role="group" aria-label="确认办理">
      <button type="button" onClick={() => finish(true)}>办理</button>
      <button type="button" onClick={() => finish(false)}>不办理</button>
    </div>
  </Modal>
}
