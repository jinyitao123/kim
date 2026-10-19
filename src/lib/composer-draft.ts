import type { HarnessId, WorkspaceMaterialReference } from '@/types/api'

export interface ComposerDraftSnapshot {
  text: string
  model?: string
  effort?: string
  fast?: boolean
  attachments?: WorkspaceMaterialReference[]
}

const LEGACY_COMPOSER_DRAFT_KEY = 'prime-work.composer-draft'
const COMPOSER_DRAFT_PREFIX = 'prime-work.composer-draft.v2:'

export function composerDraftStorageKey(scope: string): string {
  return `${COMPOSER_DRAFT_PREFIX}${scope}`
}

/** Model, effort, and fast mode ride along with typed text; alone they are not a draft. */
function emptyDraft(snapshot: ComposerDraftSnapshot): boolean {
  return !snapshot.text && !snapshot.attachments?.length
}

const harnesses = new Set<HarnessId>(['prime', 'pi'])
function isMaterialReference(value: unknown): value is WorkspaceMaterialReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Partial<WorkspaceMaterialReference>
  return typeof item.projectId === 'string' && /^[A-Za-z0-9_.:@-]{1,256}$/.test(item.projectId)
    && typeof item.harness === 'string' && harnesses.has(item.harness as HarnessId)
    && typeof item.workspacePath === 'string' && item.workspacePath.length > 0 && item.workspacePath.length <= 4096 && !item.workspacePath.includes('\0')
    && typeof item.name === 'string' && item.name.length > 0 && item.name.length <= 255
    && typeof item.path === 'string' && item.path.startsWith('材料/') && !item.path.startsWith('/') && !item.path.includes('\\')
    && !item.path.split('/').some((part) => !part || part === '.' || part === '..')
    && typeof item.sha256 === 'string' && /^[0-9a-f]{64}$/.test(item.sha256)
    && Number.isSafeInteger(item.bytes) && Number(item.bytes) > 0 && Number(item.bytes) <= 2 * 1024 * 1024
    && ({ '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json', '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } as Record<string, string>)[item.name.slice(item.name.lastIndexOf('.')).toLowerCase()] === item.mimeType
}

/** Snapshot the composer's current DOM value so a crash-and-reload keeps the draft. */
export function saveComposerDraftFromDom(): void {
  try {
    const textarea = document.querySelector<HTMLTextAreaElement>('.composer textarea')
    if (textarea?.value) window.sessionStorage.setItem(LEGACY_COMPOSER_DRAFT_KEY, textarea.value)
  } catch { /* storage unavailable */ }
}

export function saveComposerDraft(scope: string, snapshot: ComposerDraftSnapshot): void {
  try {
    const key = composerDraftStorageKey(scope)
    const previous = readComposerDraft(scope)
    const next: ComposerDraftSnapshot = {
      text: snapshot.text,
      model: snapshot.model || previous?.model,
      effort: snapshot.effort ?? previous?.effort,
      fast: snapshot.fast ?? previous?.fast,
      attachments: snapshot.attachments ?? previous?.attachments,
    }
    if (emptyDraft(next)) {
      window.sessionStorage.removeItem(key)
      window.sessionStorage.removeItem(LEGACY_COMPOSER_DRAFT_KEY)
      return
    }
    window.sessionStorage.setItem(key, JSON.stringify(next))
    window.sessionStorage.setItem(LEGACY_COMPOSER_DRAFT_KEY, next.text)
  } catch { /* storage unavailable */ }
}

export function readComposerDraft(scope: string): ComposerDraftSnapshot | null {
  try {
    const raw = window.sessionStorage.getItem(composerDraftStorageKey(scope))
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object' && typeof (parsed as ComposerDraftSnapshot).text === 'string') {
        const snapshot = parsed as ComposerDraftSnapshot
        return { ...snapshot, attachments: Array.isArray(snapshot.attachments) ? snapshot.attachments.filter(isMaterialReference) : undefined }
      }
    }
    const legacy = window.sessionStorage.getItem(LEGACY_COMPOSER_DRAFT_KEY)
    return legacy ? { text: legacy } : null
  } catch {
    return null
  }
}

export function clearComposerDraft(scope: string): void {
  try {
    window.sessionStorage.removeItem(composerDraftStorageKey(scope))
    window.sessionStorage.removeItem(LEGACY_COMPOSER_DRAFT_KEY)
  } catch { /* storage unavailable */ }
}

/** Read and clear a preserved crash draft; returns '' when none exists. */
export function takeComposerDraft(): string {
  try {
    const draft = window.sessionStorage.getItem(LEGACY_COMPOSER_DRAFT_KEY) ?? ''
    if (draft) window.sessionStorage.removeItem(LEGACY_COMPOSER_DRAFT_KEY)
    return draft
  } catch { return '' }
}
