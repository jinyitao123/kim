import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { EnterpriseWorkAttention, EnterpriseWorkSessionTarget as WorkSessionTarget, SessionRecord } from '../../../src/types/api'
import { canonicalSessionPath } from '../session-paths'
import { digest } from './handoff-store'
import { RUN_ATTENTION_COPY, RunWatcher, sessionReferenceMatches, type RunAttention, type RunWatchState } from './run-watcher'
import type { WorkbenchRunLookupResponse } from './work-sources'

export interface RunAttentionOptions {
  stateDirectory: string
  listRecentRunIds(): Promise<string[]>
  lookupRuns(runIds: string[]): Promise<WorkbenchRunLookupResponse>
  listSessions(): Promise<SessionRecord[]>
  /** Returns false when no trusted renderer is ready. */
  sendToRenderer(channel: 'enterprise:work-attention' | 'enterprise:open-work-session', target: EnterpriseWorkAttention): boolean
  isWindowFocused(): boolean
  revealWindow(): Promise<void>
  showSystemNotification(input: { title: string; body: string; onClick(): void }): void
  intervalMs?: number
}

const sessionKeyOf = (filePath: string): string[] => [...new Set([filePath, canonicalSessionPath(filePath)])].map((path) => digest(path).slice(0, 24))

/**
 * Watches the signed-in account's team runs and returns their results to the
 * originating conversation: an in-app notice when the window is in front, a
 * system notification otherwise. It never starts the agent on its own.
 */
export class RunAttentionService {
  private watcher: RunWatcher | undefined
  private accountKey: string | undefined
  private pendingOpen: EnterpriseWorkAttention | undefined

  constructor(private readonly options: RunAttentionOptions) {}

  setAccount(accountKey: string | undefined): void {
    if (accountKey === this.accountKey) return
    this.watcher?.stop()
    this.watcher = undefined
    this.pendingOpen = undefined
    this.accountKey = accountKey
    if (!accountKey) return
    const file = join(this.options.stateDirectory, `${digest(accountKey).slice(0, 32)}.json`)
    const watcher = new RunWatcher({
      listRunIds: () => this.options.listRecentRunIds(),
      lookup: (ids) => this.options.lookupRuns(ids),
      load: async () => {
        try {
          const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
            : {}
        } catch { return {} }
      },
      save: async (state: RunWatchState) => {
        await mkdir(this.options.stateDirectory, { recursive: true, mode: 0o700 })
        const temporary = `${file}.${process.pid}.tmp`
        await writeFile(temporary, JSON.stringify(state), { mode: 0o600 })
        await rename(temporary, file)
      },
      notify: (attention) => { if (this.watcher === watcher) void this.deliver(attention) },
    }, this.options.intervalMs)
    this.watcher = watcher
    watcher.start()
  }

  /** Checks right away, e.g. after a hand-off or when the window regains focus. */
  pollSoon(): void { void this.watcher?.poll() }

  stop(): void { this.setAccount(undefined) }

  /** A notification clicked before the renderer subscribed is handed over once it asks. */
  takePendingOpen(): EnterpriseWorkAttention | undefined {
    const pending = this.pendingOpen
    this.pendingOpen = undefined
    return pending
  }

  async resolveSession(sessionReference: string): Promise<WorkSessionTarget['session']> {
    if (!sessionReference) return undefined
    const sessions = await this.options.listSessions()
    const match = sessions.find((session) => !session.archived && session.depth === 0
      && sessionKeyOf(session.filePath).some((key) => sessionReferenceMatches(sessionReference, key)))
    return match ? { id: match.id, harness: match.harness, filePath: match.filePath } : undefined
  }

  private async deliver(attention: RunAttention): Promise<void> {
    const accountKey = this.accountKey
    let session: WorkSessionTarget['session']
    let sessionTitle: string | undefined
    try {
      session = await this.resolveSession(attention.sessionReference)
      if (session) sessionTitle = (await this.options.listSessions()).find((item) => item.id === session!.id)?.title
    } catch { session = undefined }
    if (accountKey !== this.accountKey) return
    const title = RUN_ATTENTION_COPY[attention.kind]
    const body = sessionTitle ? `「${sessionTitle}」· 回到对话查看` : '在「我的工作」中查看'
    const target = { runId: attention.runId, kind: attention.kind, ...(session ? { session } : {}), title, body }
    if (this.options.isWindowFocused() && this.options.sendToRenderer('enterprise:work-attention', target)) return
    this.options.sendToRenderer('enterprise:work-attention', target)
    this.options.showSystemNotification({
      title, body,
      onClick: () => {
        if (accountKey !== this.accountKey) return
        // Kept until the renderer takes it: a window created by this click may
        // not have subscribed yet when the event below is sent.
        this.pendingOpen = target
        void this.options.revealWindow().then(() => {
          if (accountKey === this.accountKey) this.options.sendToRenderer('enterprise:open-work-session', target)
        })
      },
    })
  }
}
