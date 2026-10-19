import { randomUUID } from 'node:crypto'

// When the employee's wording leaves open whether they asked for a business
// action, the app window asks them and tells the main process what they chose.
// The question and the answer do not pass through the agent runtime, so a
// model can neither see the dialog nor answer it.

export interface ActionConfirmationRequest {
  id: string
  /** The action as the business system names it. */
  action: string
  /** The record the action applies to. */
  record: string
  /** What will be submitted, read-only. */
  fields: Array<{ label: string; value: string }>
}

const WAIT_MILLISECONDS = 5 * 60 * 1000

export class ActionConfirmations {
  private readonly pending = new Map<string, { resolve(confirmed: boolean): void; timer: ReturnType<typeof setTimeout> }>()

  /** `show` puts the question in front of the person and says whether a window was there to take it. */
  constructor(private readonly show: (request: ActionConfirmationRequest) => boolean, private readonly waitMilliseconds = WAIT_MILLISECONDS, private readonly hide?: (id: string) => void) {}

  /** Resolves true only when the person chose to go ahead; declining, walking away or having no window open is a no. */
  request(question: Omit<ActionConfirmationRequest, 'id'>): Promise<boolean> {
    const id = randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.answer(id, false), this.waitMilliseconds)
      this.pending.set(id, { resolve, timer })
      if (!this.show({ id, ...question })) this.answer(id, false)
    })
  }

  /** An answer for a question that is no longer waiting is dropped. */
  answer(id: string, confirmed: boolean): void {
    const waiting = this.pending.get(id)
    if (!waiting) return
    this.pending.delete(id)
    clearTimeout(waiting.timer)
    waiting.resolve(confirmed)
    this.hide?.(id)
  }

  /** Ends every wait as declined, as when the account changes or the app quits. */
  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.answer(id, false)
  }
}
