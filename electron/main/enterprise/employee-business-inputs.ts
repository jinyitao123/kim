import { digest, type HandoffStore } from './handoff-store'

/** Host-observed employee text, never assistant/tool text or attached material content. */
export interface BusinessInputSource {
  source_ref: string
  messageId: string
  eventSeq: number
  sha256: string
  text: string
  transcriptSha256: string
}
export interface BusinessTranscriptEntry { id: string; role: string; text: string }
interface InputGeneration {
  generation: number
  sources: BusinessInputSource[]
  invalidated?: { messageIds: string[] }
}
const keyFor = (account: string, session: string) => `employee-business-inputs:${account}:${digest(session)}`
const CHANGED = '已绑定员工历史发生变化，旧草稿来源已失效；请在新消息中明确当前业务内容后继续'
export class EmployeeBusinessInputs {
  constructor(private readonly store: HandoffStore) {}
  private readonly pending = new Map<string, Promise<unknown>>()
  private async serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.pending.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation)
    this.pending.set(key, result)
    try { return await result } finally { if (this.pending.get(key) === result) this.pending.delete(key) }
  }
  async remember(account: string, session: string, text: string, eventSeq: number, entry: BusinessTranscriptEntry) {
    return this.serialize(keyFor(account, session), () => this.rememberSource(account, session, text, eventSeq, entry))
  }
  async read(account: string, session: string, transcript: BusinessTranscriptEntry[]): Promise<BusinessInputSource[]> {
    return this.serialize(keyFor(account, session), () => this.readSources(account, session, transcript))
  }
  private async load(key: string): Promise<InputGeneration> {
    const stored = (await this.store.inspect<InputGeneration | BusinessInputSource[]>(key))?.value
    return Array.isArray(stored) ? { generation: 0, sources: stored } : stored ?? { generation: 0, sources: [] }
  }
  private async invalidate(key: string, state: InputGeneration, additionalIds: string[]) {
    await this.store.checkpoint(key, digest(key), { generation: state.generation, sources: [],
      invalidated: { messageIds: [...new Set([...state.sources.map(source => source.messageId), ...additionalIds])] } } satisfies InputGeneration)
  }
  private async rememberSource(account: string, session: string, text: string, eventSeq: number, entry: BusinessTranscriptEntry) {
    if (entry.role !== 'user' || !text.trim()) return
    const key = keyFor(account, session), state = await this.load(key)
    // A replay of the previous capture may accompany the next prompt; it cannot revive this generation.
    if (state.invalidated?.messageIds.includes(entry.id)) return
    const generation = state.generation + (state.invalidated ? 1 : 0)
    const prior = state.invalidated ? [] : state.sources
    const source: BusinessInputSource = { source_ref: digest(`${key}:${generation}:${entry.id}:${digest(text)}`).slice(0, 32), messageId: entry.id, eventSeq,
      sha256: digest(text), text, transcriptSha256: digest(entry.text) }
    const existing = prior.find(item => item.messageId === entry.id)
    if (existing) {
      if (existing.eventSeq !== source.eventSeq || existing.sha256 !== source.sha256 || existing.transcriptSha256 !== source.transcriptSha256 || existing.text !== source.text) {
        await this.invalidate(key, state, [entry.id]); throw new Error(CHANGED)
      }
      return
    }
    await this.store.checkpoint(key, digest(key), { generation, sources: [...prior, source].slice(-50) } satisfies InputGeneration)
  }
  private async readSources(account: string, session: string, transcript: BusinessTranscriptEntry[]): Promise<BusinessInputSource[]> {
    const key = keyFor(account, session), state = await this.load(key)
    if (state.invalidated) throw new Error(CHANGED)
    const changed = state.sources.some(source => {
      const entry = transcript[source.eventSeq]
      return entry?.id !== source.messageId || entry.role !== 'user' || digest(entry.text) !== source.transcriptSha256 || digest(source.text) !== source.sha256
    })
    if (changed) {
      await this.invalidate(key, state, transcript.filter(entry => entry.role === 'user').map(entry => entry.id))
      throw new Error(CHANGED)
    }
    return state.sources
  }
}
