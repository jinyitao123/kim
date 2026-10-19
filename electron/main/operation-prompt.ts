import { randomUUID } from 'node:crypto'

// Two things the assistant must not do for the person while it carries out an
// operation in Weave: agree to something that cannot be taken back, and read a
// secret the operation produced. The app window does both. The question, the
// answer and the secret travel only between the window and the main process,
// so a model can neither see the dialog nor answer it.

export interface OperationPromptRequest {
  id: string
  /** `confirm` waits for a yes or no; `reveal` shows values once for the person to copy. */
  kind: 'confirm' | 'reveal'
  /** The operation, in a few words. */
  title: string
  /** What the operation is about, by the name the person knows it by. */
  subject?: string
  /** What cannot be taken back, or what to do with the values. */
  message: string
  values?: Array<{ label: string; value: string }>
}

const WAIT_MILLISECONDS = 5 * 60 * 1000

export class OperationPrompts {
  private readonly pending = new Map<string, { resolve(confirmed: boolean): void; timer: ReturnType<typeof setTimeout> }>()
  private readonly shown = new Set<string>()

  /** `show` puts the dialog in front of the person and says whether a window was there to take it. */
  constructor(private readonly show: (request: OperationPromptRequest) => boolean, private readonly waitMilliseconds = WAIT_MILLISECONDS, private readonly hide?: (id: string) => void) {}

  /** Resolves true only when the person chose to go ahead; declining, walking away or having no window open is a no. */
  confirm(question: { title: string; subject?: string; message: string }): Promise<boolean> {
    const id = randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.answer(id, false), this.waitMilliseconds)
      this.pending.set(id, { resolve, timer })
      if (!this.show({ id, kind: 'confirm', ...question })) this.answer(id, false)
    })
  }

  /** Shows values to the person and returns at once, saying whether a window took them. */
  reveal(secret: { title: string; message: string; values: Array<{ label: string; value: string }> }): boolean {
    const id = randomUUID()
    if (!this.show({ id, kind: 'reveal', ...secret })) return false
    this.shown.add(id)
    return true
  }

  /** An answer for a dialog that is no longer open is dropped. */
  answer(id: string, confirmed: boolean): void {
    this.shown.delete(id)
    const waiting = this.pending.get(id)
    if (!waiting) return
    this.pending.delete(id)
    clearTimeout(waiting.timer)
    waiting.resolve(confirmed)
    this.hide?.(id)
  }

  /** Declines every open question and takes every shown value off the screen, as when the account changes or the app quits. */
  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.answer(id, false)
    for (const id of [...this.shown]) { this.shown.delete(id); this.hide?.(id) }
  }
}
