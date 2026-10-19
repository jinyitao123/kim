import { randomUUID } from 'node:crypto'

// A secret the assistant needs on the person's behalf — a model key, say — is
// asked for by the app window and handed straight to whoever in the main
// process asked. It is not sent to the agent runtime, so it never reaches a
// model, a tool result, a session record or a log.

export interface SecretPromptRequest {
  id: string
  title: string
  /** What the field holds, in the person's words. */
  label: string
  /** Where the secret is going, so the person can tell what they are filling in. */
  detail?: string
}

const WAIT_MILLISECONDS = 5 * 60 * 1000

export class SecretPrompts {
  private readonly pending = new Map<string, { resolve(value: string | undefined): void; timer: ReturnType<typeof setTimeout> }>()

  /** `show` puts the prompt in front of the person and says whether a window was there to take it. */
  constructor(private readonly show: (request: SecretPromptRequest) => boolean, private readonly waitMilliseconds = WAIT_MILLISECONDS, private readonly hide?: (id: string) => void) {}

  /** Resolves with what the person typed, or with nothing when they declined, walked away or no window is open. */
  request(prompt: Omit<SecretPromptRequest, 'id'>): Promise<string | undefined> {
    const id = randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.answer(id, undefined), this.waitMilliseconds)
      this.pending.set(id, { resolve, timer })
      if (!this.show({ id, ...prompt })) this.answer(id, undefined)
    })
  }

  /** An answer for a prompt that is no longer waiting is dropped. */
  answer(id: string, value: string | undefined): void {
    const waiting = this.pending.get(id)
    if (!waiting) return
    this.pending.delete(id)
    clearTimeout(waiting.timer)
    waiting.resolve(value?.trim() ? value.trim() : undefined)
    this.hide?.(id)
  }

  /** Ends every wait unanswered, as when the account changes or the app quits. */
  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.answer(id, undefined)
  }
}
