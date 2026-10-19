import { randomBytes } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'
import { isPathWithin, isRecord } from '../validation'
import type { SessionServiceOptions } from '../sessions'
import type { SessionCatalogEntry, SessionCatalogIo } from './catalog'
import {
  createBranchSummaryTranscriptReader,
  createBucketedCatalogIo,
  createBucketedMetadataParser,
  isBucketedSessionPath,
  timestampFromBucketedSessionName,
} from './bucketed'
import {
  createIncrementalMetadataReader,
  nodeMetadataReaderIo,
  type SessionMetadataReader,
  type SessionMetadataReaderIo,
} from './metadata'
import type { TranscriptFileReader } from './transcript'

/**
 * Pi session JSONL v3 layout under `~/.pi/agent/sessions/<bucket>/`:
 * - Line 1 is the `{"type":"session","version":3,...}` header; everything
 *   after it is append-only entries with `id`/`parentId`
 *   forming a branch tree. The project path comes from the header `cwd` —
 *   decoding the bucket directory name is lossy for paths containing dashes.
 * - The display name rides `session_info` entries (`name`); the latest one in
 *   file order wins. There is no `title_change` entry and no in-place rewrite.
 * - File names are `<ISO timestamp with dashes>_<uuid>.jsonl`; ordering derives
 *   from the name prefix, not UUIDv7 bits.
 *
 * Tree parsing and model-change handling use the shared `./bucketed` helpers.
 */
export function piSessionRoot(): string {
  return join(homedir(), '.pi', 'agent', 'sessions')
}

export const piTimestampFromSessionName = timestampFromBucketedSessionName

function isAccountScopedPiRoot(root: string): boolean {
  const parts = resolve(root).split(sep)
  return parts.length >= 4 && parts.at(-1) === 'pi' && parts.at(-3) === 'accounts' && parts.at(-4) === 'agent-sessions'
}

export function createPiCatalogIo(): SessionCatalogIo {
  const bucketed = createBucketedCatalogIo()
  return {
    ...bucketed,
    async readDirectory(root: string): Promise<readonly SessionCatalogEntry[]> {
      const nested = await bucketed.readDirectory(root)
      if (!isAccountScopedPiRoot(root)) return nested
      // PI_CODING_AGENT_SESSION_DIR is an exact directory. Account-scoped Pi
      // sessions therefore sit directly below this root, unlike the default
      // ~/.pi/agent/sessions/<cwd-bucket>/ layout.
      const direct = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && piTimestampFromSessionName(entry.name) !== undefined)
        .map((entry) => ({ name: entry.name, isFile: () => true, isSymbolicLink: () => false }))
      return [...direct, ...nested]
    },
  }
}

export function isPiSessionPath(root: string, path: string): boolean {
  if (isBucketedSessionPath(root, path)) return true
  if (!isAccountScopedPiRoot(root) || !isPathWithin(root, path)) return false
  const segments = relative(root, path).split(sep)
  return segments.length === 1 && segments[0] === basename(path) && piTimestampFromSessionName(segments[0]!) !== undefined
}

const piMetadataParser = createBucketedMetadataParser((state, value) => {
  if (value.type === 'model_change') {
    // Pi records split the provider and model id into separate fields.
    if (typeof value.modelId === 'string') state.model = value.modelId
    if (typeof value.provider === 'string') state.provider = value.provider
  } else if (value.type === 'session_info' && typeof value.name === 'string') {
    // The latest session_info name wins; an empty name falls back to the prompt.
    state.displayName = value.name
  }
})

/**
 * Pi metadata reader: the file is append-only from byte zero (no mutable title
 * slot), so the shared incremental machinery covers the whole file.
 */
export function createPiSessionMetadataReader(io: SessionMetadataReaderIo = nodeMetadataReaderIo): SessionMetadataReader {
  return createIncrementalMetadataReader(piMetadataParser, io)
}
/**
 * Append a `session_info` record to a pi session file as a fallback rename
 * when no live runtime is available. Pi's metadata reader picks up the
 * latest `session_info` name in file order, so the new name takes effect
 * immediately on the next catalog scan.
 *
 * Pi v3 entries are an id/parentId branch tree; every fixture and the
 * header comment above carry both fields. Generate a short hex id and
 * parent it to the current leaf so a later pi resume can load the file.
 */
export function appendPiSessionInfo(filePath: string, title: string): boolean {
  try {
    const parentId = currentPiLeafId(filePath)
    const record = `${JSON.stringify({
      type: 'session_info',
      id: randomBytes(4).toString('hex'),
      parentId,
      timestamp: new Date().toISOString(),
      name: title,
    })}\n`
    appendFileSync(filePath, record, 'utf8')
    return true
  } catch {
    return false
  }
}

function currentPiLeafId(filePath: string): string | null {
  const lines = readFileSync(filePath, 'utf8').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (!line) continue
    let value: unknown
    try { value = JSON.parse(line) } catch { continue }
    if (!isRecord(value) || value.type === 'session' || typeof value.id !== 'string' || !value.id) continue
    return value.id
  }
  return null
}
export const readPiTranscript: TranscriptFileReader = createBranchSummaryTranscriptReader()

/**
 * Fully wired SessionService options for a pi session root. Construct the
 * service with a null CLI path: pi has no `prime-agent list` live overlay.
 */
export function piSessionServiceOptions(sessionRoot = piSessionRoot()): SessionServiceOptions {
  return {
    harness: 'pi',
    sessionRoot,
    catalogIo: createPiCatalogIo(),
    catalogNameTimestamp: piTimestampFromSessionName,
    metadataReader: createPiSessionMetadataReader(),
    transcriptReader: readPiTranscript,
    isSessionPathAuthorized: isPiSessionPath,
    // Session files sit one bucket directory below the root; bounded one-level
    // watchers keep catalog refresh behavior identical across platforms.
    recursiveWatch: true,
    renameFile: appendPiSessionInfo,
  }
}
