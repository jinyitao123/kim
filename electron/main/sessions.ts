import { type Dirent, type Stats, watch } from 'node:fs'
import { readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { assertNoMcpAuthenticationCommand } from '../../src/lib/mcp-policy'
import type { HarnessId, SessionChangeEvent, SessionRecord, TranscriptMessage } from '../../src/types/api'
import { queueDaemonFollowUp } from './agent-daemon'
import { type AdmissionQueue, comparePaths, createAdmissionQueue, createSingleFlight } from './lib/async'
import { type ExecutableSource, resolveExecutable, runProcess } from './process-utils'
import { type SessionCatalogIo, SessionMetadataCatalog, type SessionNameTimestamp } from './sessions/catalog'
import { createSessionMetadataReader, type SessionMetadata, type SessionMetadataReader } from './sessions/metadata'
import { readTranscript } from './sessions/transcript'
import type { JsonStateStore } from './store'
import { isPathWithin, isRecord, requireBoolean, requireExistingDirectory, requireId, requireString } from './validation'

interface RuntimeSessionState { isStreaming: boolean; isCompacting?: boolean }

interface RuntimeSessionSnapshot extends RuntimeSessionState { sessionFile?: string }

const MAX_SESSION_FILES = 5_000
const MAX_SESSION_WATCH_DIRECTORIES = 512
const MAX_CONCURRENT_TRANSCRIPT_READS = 2
const MAX_PENDING_TRANSCRIPT_READS = 32

type TranscriptReader = (filePath: string, isStreaming: boolean) => Promise<TranscriptMessage[]>

type SessionPathAuthorizer = (sessionRootRealPath: string, sessionRealPath: string) => boolean

export interface SessionWatcher {
  close(): void
  on(event: 'error', listener: (error: Error) => void): SessionWatcher
}

export type SessionWatchFactory = (
  path: string,
  options: { persistent: boolean },
  listener: (eventType: string, filename: string | Buffer | null) => void,
) => SessionWatcher

const watchSessionDirectory: SessionWatchFactory = (path, options, listener) => watch(
  path,
  options,
  (eventType, filename) => listener(eventType, filename),
)

const authorizePrimeSessionPath: SessionPathAuthorizer = (root, path) => isPathWithin(root, path) && path.endsWith('.jsonl')

export interface SessionServiceOptions {
  environment?: NodeJS.ProcessEnv
  /** Harness stamped on every record and change event this service emits; defaults to 'prime'. */
  harness?: HarnessId
  /** Canonical-or-lexical session root; defaults to the Prime Agent session directory. */
  sessionRoot?: string
  catalogIo?: SessionCatalogIo
  /** Pre-I/O discovery ordering for a harness's file-name scheme; defaults to Prime UUIDv7 names. */
  catalogNameTimestamp?: SessionNameTimestamp
  metadataReader?: SessionMetadataReader
  transcriptReader?: TranscriptReader
  /** Containment rule applied to realpathed candidates; defaults to root containment plus a `.jsonl` suffix. */
  isSessionPathAuthorized?: SessionPathAuthorizer
  /**
   * Also watch a bounded set of session directories exactly one level below
   * the root (for harnesses that bucket sessions).
   */
  recursiveWatch?: boolean
  /** Injectable watch seam for deterministic filesystem-event tests. */
  watchDirectory?: SessionWatchFactory
  /**
   * File-level rename fallback for harnesses whose CLI does not expose a
   * `rename` subcommand (Pi). Called when no live runtime is available
   * to accept `set_session_name` and no CLI fallback exists.
   */
  renameFile?: (filePath: string, title: string) => boolean
  maxConcurrentTranscriptReads?: number
  maxPendingTranscriptReads?: number
}

export class SessionService {
  readonly harness: HarnessId
  private currentSessionRoot: string
  private readonly recursiveWatch: boolean
  private runtimeForSession: (filePath: string) => RuntimeSessionState | undefined = () => undefined
  private listRuntimeSessions: (() => readonly RuntimeSessionSnapshot[]) | null = null
  private stopRuntimeForSession: (filePath: string) => Promise<void> = async () => undefined
  private renameRuntimeSession: (filePath: string, title: string) => Promise<boolean> = async () => false
  private catalog: SessionMetadataCatalog
  private readonly metadataReader: SessionMetadataReader
  private readonly transcriptReads = createSingleFlight<string, TranscriptMessage[]>()
  private readonly transcriptAdmission: AdmissionQueue
  private readonly transcriptReader: TranscriptReader
  private readonly isSessionPathAuthorized: SessionPathAuthorizer
  private readonly watchDirectory: SessionWatchFactory
  private readonly renameFile: ((filePath: string, title: string) => boolean) | undefined
  private readonly maxSessionFiles: number
  private readonly catalogIo: SessionCatalogIo | undefined
  private readonly catalogNameTimestamp: SessionNameTimestamp | undefined
  private readonly changeListeners = new Set<(event: SessionChangeEvent) => void>()
  private sessionWatcher: SessionWatcher | null = null
  private readonly bucketWatchers = new Map<string, SessionWatcher>()
  private bucketWatcherRefresh: Promise<void> | null = null
  private bucketWatcherRefreshPending = false
  private watcherRetry: NodeJS.Timeout | null = null
  private changeTimer: NodeJS.Timeout | null = null
  private readonly changedNames = new Set<string>()
  private catalogOnlyChange = false
  private followUpsInFlight = 0
  private rootGeneration = 0
  private rootTransitioning = false
  private readonly environment?: NodeJS.ProcessEnv
  private activeRootOperations = 0
  private readonly rootOperationWaiters = new Set<() => void>()
  private rootChangeTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly store: JsonStateStore,
    private readonly primeAgentPath: ExecutableSource,
    maxSessionFiles = MAX_SESSION_FILES,
    options: SessionServiceOptions = {},
  ) {
    this.environment = options.environment
    const transcriptLimit = options.maxConcurrentTranscriptReads ?? MAX_CONCURRENT_TRANSCRIPT_READS
    const pendingLimit = options.maxPendingTranscriptReads ?? MAX_PENDING_TRANSCRIPT_READS
    if (!Number.isInteger(transcriptLimit) || transcriptLimit < 1) throw new RangeError('maxConcurrentTranscriptReads must be a positive integer')
    if (!Number.isInteger(pendingLimit) || pendingLimit < 0) throw new RangeError('maxPendingTranscriptReads must be a non-negative integer')
    this.transcriptAdmission = createAdmissionQueue({
      maxConcurrent: transcriptLimit,
      maxPending: pendingLimit,
      pendingLimitError: () => new Error('Too many transcript reads are pending'),
      closedError: () => new Error('Too many transcript reads are pending'),
    })
    this.harness = options.harness ?? 'prime'
    this.currentSessionRoot = options.sessionRoot ?? join(homedir(), '.prime', 'agent', 'sessions')
    this.maxSessionFiles = maxSessionFiles
    this.catalogIo = options.catalogIo
    this.catalogNameTimestamp = options.catalogNameTimestamp
    this.recursiveWatch = options.recursiveWatch === true
    this.metadataReader = options.metadataReader ?? createSessionMetadataReader()
    this.transcriptReader = options.transcriptReader ?? readTranscript
    this.isSessionPathAuthorized = options.isSessionPathAuthorized ?? authorizePrimeSessionPath
    this.watchDirectory = options.watchDirectory ?? watchSessionDirectory
    this.catalog = this.createCatalog()
    this.renameFile = options.renameFile
  }

  get sessionRoot(): string { return this.currentSessionRoot }

  /**
   * Switch this service to a different harness session root. The change is a
   * barrier: new operations are rejected while old operations settle, active
   * runtimes attached to the old root are stopped, and the catalog/watchers
   * are rebuilt before this promise resolves.
   */
  setSessionRoot(rootValue: unknown): Promise<void> {
    const operation = this.rootChangeTail.then(async () => {
      const requestedRoot = requireString(rootValue, 'sessionRoot', { min: 1, max: 4_096 })
      await this.changeSessionRoot(requestedRoot)
    })
    this.rootChangeTail = operation.then(() => undefined, () => undefined)
    return operation
  }

  private createCatalog(): SessionMetadataCatalog {
    return new SessionMetadataCatalog(
      () => this.sessionRoot,
      this.primeAgentPath,
      this.maxSessionFiles,
      (filePath, knownStat) => this.readMetadata(filePath, knownStat),
      this.catalogIo,
      this.catalogNameTimestamp,
    )
  }

  private async changeSessionRoot(requestedRoot: string): Promise<void> {
    // Store only the canonical root. This prevents a caller from retargeting
    // the service later by changing a symlink used when selecting the root.
    const nextRoot = await requireExistingDirectory(requestedRoot, 'sessionRoot')
    const previousConfiguredRoot = this.currentSessionRoot
    let previousRoot: string | undefined
    try { previousRoot = await realpath(this.sessionRoot) } catch { /* A harness may not have created its session directory yet. */ }
    if (previousRoot === nextRoot) return

    this.rootTransitioning = true
    this.rootGeneration += 1
    this.stopWatcher()
    try {
      await this.waitForRootOperations()
      if (previousRoot) await this.stopRuntimesWithin(previousRoot)
      this.currentSessionRoot = nextRoot
      this.catalog = this.createCatalog()
      this.rootTransitioning = false
      this.startWatcher()
    } catch (error) {
      // A failed runtime stop leaves the original scope active. Rebuild its
      // catalog too, because the generation change invalidated all old reads.
      this.currentSessionRoot = previousConfiguredRoot
      this.catalog = this.createCatalog()
      this.rootTransitioning = false
      this.startWatcher()
      throw error
    }
  }

  private async stopRuntimesWithin(root: string): Promise<void> {
    const runtimePaths = [...new Set((this.listRuntimeSessions?.() ?? [])
      .map((runtime) => runtime.sessionFile)
      .filter((filePath): filePath is string => typeof filePath === 'string'))]
    const results = await Promise.allSettled(runtimePaths.map(async (filePath) => {
      let canonicalPath: string
      try { canonicalPath = await realpath(filePath) } catch { return }
      if (this.isSessionPathAuthorized(root, canonicalPath)) await this.stopRuntimeForSession(canonicalPath)
    }))
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failure) throw failure.reason
  }

  private beginRootOperation(): { generation: number; release(): void } {
    if (this.rootTransitioning) throw new Error('Session root is changing')
    this.activeRootOperations += 1
    const generation = this.rootGeneration
    let released = false
    return {
      generation,
      release: () => {
        if (released) return
        released = true
        this.activeRootOperations -= 1
        if (this.activeRootOperations === 0) {
          for (const resolveWaiter of this.rootOperationWaiters) resolveWaiter()
          this.rootOperationWaiters.clear()
        }
      },
    }
  }

  private assertRootGeneration(generation: number): void {
    if (this.rootTransitioning || generation !== this.rootGeneration) throw new Error('Session root changed during the operation')
  }

  private async waitForRootOperations(): Promise<void> {
    if (this.activeRootOperations === 0) return
    await new Promise<void>((resolveWaiter) => this.rootOperationWaiters.add(resolveWaiter))
  }

  bindRuntimeHooks(hooks: {
    get(filePath: string): RuntimeSessionState | undefined
    all?(): readonly RuntimeSessionSnapshot[]
    stop(filePath: string): Promise<void>
    rename(filePath: string, title: string): Promise<boolean>
  }): void {
    this.runtimeForSession = hooks.get
    this.listRuntimeSessions = hooks.all ?? null
    this.stopRuntimeForSession = hooks.stop
    this.renameRuntimeSession = hooks.rename
  }

  onDidChange(listener: (event: SessionChangeEvent) => void): () => void {
    this.changeListeners.add(listener)
    this.startWatcher()
    return () => {
      this.changeListeners.delete(listener)
      if (!this.changeListeners.size) this.stopWatcher()
    }
  }

  async list(projectPath?: unknown, includeArchivedValue: unknown = false, forceValue: unknown = false): Promise<SessionRecord[]> {
    const operation = this.beginRootOperation()
    try {
      const includeArchived = requireBoolean(includeArchivedValue, 'includeArchived')
      const force = requireBoolean(forceValue, 'force')
      const requestedProject = projectPath ? requireString(projectPath, 'projectPath', { min: 1, max: 4096 }) : undefined
      let project = requestedProject ? resolve(requestedProject) : undefined
      if (requestedProject) {
        try { project = await requireExistingDirectory(requestedProject, 'projectPath') } catch { /* Preserve stale lexical filtering. */ }
      }
      // A caller reconciling a just-created session cannot rely on fs.watch:
      // recursive delivery varies by platform and an event may still be queued.
      // Force advances the scan revision while retaining metadata-level caches.
      const catalog = this.catalog
      if (force) catalog.invalidateLiveCatalog()
      const sessions = await catalog.all()
      this.assertRootGeneration(operation.generation)
      const archived = new Set(this.store.getArchivedSessions().map((path) => resolve(path)))
      // One runtime snapshot per list call; each session then resolves in O(1).
      const runtimeBySession = this.snapshotRuntimeSessions()
      const records: SessionRecord[] = []
      for (const original of sessions) {
        const metadata = { ...original }
        const isArchived = archived.has(resolve(metadata.filePath))
        if ((isArchived && !includeArchived) || (project && resolve(metadata.projectPath) !== project)) continue
        const runtime = runtimeBySession
          ? runtimeBySession.get(resolve(metadata.filePath))
          : this.runtimeForSession(metadata.filePath)
        if (runtime) metadata.status = runtime.isStreaming || runtime.isCompacting ? 'running' : 'idle'
        const { sessionName: _sessionName, ...record } = metadata
        records.push({ ...record, harness: this.harness, archived: isArchived })
      }
      this.assertRootGeneration(operation.generation)
      return records.sort((a, b) => Date.parse(b.lastUserMessageAt ?? b.createdAt) - Date.parse(a.lastUserMessageAt ?? a.createdAt) || comparePaths(a.filePath, b.filePath))
    } finally { operation.release() }
  }

  private snapshotRuntimeSessions(): Map<string, RuntimeSessionState> | null {
    if (!this.listRuntimeSessions) return null
    const bySession = new Map<string, RuntimeSessionState>()
    for (const runtime of this.listRuntimeSessions()) {
      if (!runtime.sessionFile) continue
      const key = resolve(runtime.sessionFile)
      if (!bySession.has(key)) bySession.set(key, runtime)
    }
    return bySession
  }

  async projectPaths(): Promise<string[]> {
    const sessions = await this.list()
    return [...new Set(sessions.map((session) => session.projectPath).filter((path) => path.startsWith('/')))]
  }

  async read(filePath: unknown): Promise<TranscriptMessage[]> {
    const operation = this.beginRootOperation()
    try {
      const requested = requireString(filePath, 'filePath', { min: 1, max: 4096 })
      const safePath = await this.requireSessionPath(requested)
      this.assertRootGeneration(operation.generation)
      // Coalesced callers share one immutable result; the IPC boundary clones it
      // for the renderer, so a pre-IPC structuredClone would be a second copy.
      const result = await this.transcriptReads.run(`${operation.generation}\0${safePath}`, () => this.transcriptAdmission.run(async () => {
        const runtime = this.runtimeForSession(safePath)
        return this.transcriptReader(safePath, runtime?.isStreaming === true || runtime?.isCompacting === true)
      }))
      this.assertRootGeneration(operation.generation)
      return result
    } finally { operation.release() }
  }

  async followUp(filePath: unknown, message: unknown, intent: unknown = 'queue'): Promise<boolean> {
    const operation = this.beginRootOperation()
    try {
      if (intent !== 'queue' && intent !== 'steer') throw new TypeError('Invalid active-session message intent')
      const safeMessage = requireString(message, 'message', { min: 1, max: 64 * 1024 })
      assertNoMcpAuthenticationCommand(safeMessage, this.harness)
      if (this.followUpsInFlight >= 4) throw new Error('Too many active-session replies are in flight')
      this.followUpsInFlight += 1
      try { return await this.queueActiveFollowUp(filePath, safeMessage, intent, operation.generation) }
      finally { this.followUpsInFlight -= 1 }
    } finally { operation.release() }
  }

  private async queueActiveFollowUp(filePath: unknown, message: unknown, intent: 'queue' | 'steer', generation: number): Promise<boolean> {
    const safePath = await this.requireSessionPath(filePath)
    this.assertRootGeneration(generation)
    const safeMessage = requireString(message, 'message', { min: 1, max: 64 * 1024 })
    const primeAgentPath = resolveExecutable(this.primeAgentPath)
    if (!primeAgentPath) throw new Error('Prime Agent executable was not found')

    // The catalog canonicalizes candidate session files with bounded
    // parallelism and caches the result; reuse it instead of re-listing with
    // up to MAX_SESSION_FILES * 4 serial realpath calls.
    const active = (await this.catalog.liveSessions()).get(safePath)
    this.assertRootGeneration(generation)
    if (active?.lifecycle !== 'live' || active.isSessionActive !== true) return false
    const activeSessionId = requireId(active.activeSessionId ?? active.id, 'activeSessionId')
    if (activeSessionId.startsWith('-')) throw new Error('Prime Agent returned an invalid active session identifier')

    const status = await runProcess(primeAgentPath, ['status', '--json'], { timeoutMs: 15_000, maxBytes: 1024 * 1024, env: this.environment ? { ...this.environment, PRIME_AGENT_SESSION_DIR: this.sessionRoot } : undefined })
    if (status.code !== 0 || status.timedOut || status.outputExceeded) throw new Error('GooeyPi could not inspect the Prime Agent daemon')
    let statuses: unknown
    try { statuses = JSON.parse(status.stdout) } catch { throw new Error('Prime Agent returned an invalid daemon status') }
    if (!Array.isArray(statuses) || statuses.length > 64) throw new Error('Prime Agent returned an invalid daemon status')
    const current = statuses.find((value) => isRecord(value) && value.status === 'current' && value.isDefault === true)
    if (!isRecord(current) || typeof current.socketPath !== 'string') throw new Error('Prime Agent did not report its active daemon socket')
    this.assertRootGeneration(generation)
    await queueDaemonFollowUp(current.socketPath, activeSessionId, safeMessage, intent === 'steer' ? 'steer' : 'follow_up')
    this.assertRootGeneration(generation)
    return true
  }

  async rename(filePath: unknown, title: unknown): Promise<boolean> {
    const operation = this.beginRootOperation()
    try {
      const safePath = await this.requireSessionPath(filePath)
      this.assertRootGeneration(operation.generation)
      const safeTitle = requireString(title, 'title', { min: 1, max: 200, trim: true })
      if (safeTitle.startsWith('-') || /[\r\n]/.test(safeTitle)) throw new TypeError('title contains invalid characters')
      if (await this.renameRuntimeSession(safePath, safeTitle)) {
        this.assertRootGeneration(operation.generation)
        return true
      }
      const primeAgentPath = resolveExecutable(this.primeAgentPath)
      // Pi services are constructed with a null CLI path (electron/main/index.ts).
      if (!primeAgentPath) {
        const renamed = this.renameFile?.(safePath, safeTitle) ?? false
        this.assertRootGeneration(operation.generation)
        return renamed
      }
      const metadata = await this.readMetadata(safePath)
      this.assertRootGeneration(operation.generation)
      const result = await runProcess(primeAgentPath, ['rename', metadata.id, safeTitle, '--json'], { timeoutMs: 30_000, env: this.environment ? { ...this.environment, PRIME_AGENT_SESSION_DIR: this.sessionRoot } : undefined })
      this.assertRootGeneration(operation.generation)
      return result.code === 0
    } finally { operation.release() }
  }

  async archive(filePath: unknown, archivedValue: unknown = true): Promise<boolean> {
    const operation = this.beginRootOperation()
    try {
      const safePath = await this.requireSessionPath(filePath)
      this.assertRootGeneration(operation.generation)
      const archived = requireBoolean(archivedValue, 'archived')
      if (archived) await this.stopRuntimeForSession(safePath)
      this.assertRootGeneration(operation.generation)
      await this.store.update((state) => {
        state.archivedSessions = state.archivedSessions.filter((path) => resolve(path) !== resolve(safePath))
        if (archived) state.archivedSessions.push(safePath)
      })
      this.assertRootGeneration(operation.generation)
      return true
    } finally { operation.release() }
  }

  async requireSessionPath(value: unknown): Promise<string> {
    const operation = this.beginRootOperation()
    try {
      const safePath = await this.requireSessionPathWithinRoot(this.sessionRoot, value)
      this.assertRootGeneration(operation.generation)
      return safePath
    } finally { operation.release() }
  }

  private async requireSessionPathWithinRoot(sessionRoot: string, value: unknown): Promise<string> {
    const requested = requireString(value, 'filePath', { min: 1, max: 4096 })
    const root = await realpath(sessionRoot)
    const path = await realpath(requested)
    if (!this.isSessionPathAuthorized(root, path)) throw new TypeError('Session path is outside the Prime session directory')
    return path
  }

  private startWatcher(): void {
    if (this.sessionWatcher || this.watcherRetry || !this.changeListeners.size) return
    const watchedRoot = this.sessionRoot
    const generation = this.rootGeneration
    try {
      // A missing session root (harness never used on this machine) throws
      // here and lands in the retry below, which watches once the root appears.
      const watcher = this.watchDirectory(watchedRoot, { persistent: false }, (_eventType, filename) => {
        if (this.rootTransitioning || this.rootGeneration !== generation || this.sessionRoot !== watchedRoot) return
        this.queueSessionChange(filename, generation)
        if (this.recursiveWatch) this.refreshBucketWatchers(watcher, watchedRoot, generation)
      })
      this.sessionWatcher = watcher
      if (this.recursiveWatch) this.refreshBucketWatchers(watcher, watchedRoot, generation)
      watcher.on('error', () => {
        if (this.sessionWatcher !== watcher || this.rootGeneration !== generation) return
        watcher.close()
        this.sessionWatcher = null
        this.closeBucketWatchers()
        this.queueSessionChange(null, generation)
        this.scheduleWatcherRetry()
      })
    } catch {
      this.scheduleWatcherRetry()
    }
  }

  private scheduleWatcherRetry(): void {
    if (this.watcherRetry || !this.changeListeners.size) return
    this.watcherRetry = setTimeout(() => {
      this.watcherRetry = null
      this.startWatcher()
    }, 1_000)
    this.watcherRetry.unref()
  }

  private stopWatcher(): void {
    this.sessionWatcher?.close()
    this.sessionWatcher = null
    this.closeBucketWatchers()
    if (this.watcherRetry) clearTimeout(this.watcherRetry)
    if (this.changeTimer) clearTimeout(this.changeTimer)
    this.bucketWatcherRefresh = null
    this.watcherRetry = null
    this.changeTimer = null
    this.changedNames.clear()
    this.catalogOnlyChange = false
    this.bucketWatcherRefreshPending = false
  }

  /**
   * Pi keeps JSONL files exactly one bucket below the session root, so
   * watch a bounded set of real child directories and feed their root-relative
   * names through the same containment checks as root events. Using this on
   * every platform keeps behavior identical where recursive `fs.watch` is not
   * implemented (notably Linux).
   */
  private refreshBucketWatchers(rootWatcher: SessionWatcher, watchedRoot: string, generation: number): void {
    if (this.rootGeneration !== generation || this.rootTransitioning || this.sessionWatcher !== rootWatcher) return
    if (this.bucketWatcherRefresh) {
      this.bucketWatcherRefreshPending = true
      return
    }
    const refresh = this.performBucketWatcherRefresh(rootWatcher, watchedRoot, generation).finally(() => {
      if (this.bucketWatcherRefresh !== refresh) return
      const refreshAgain = this.bucketWatcherRefreshPending
      this.bucketWatcherRefreshPending = false
      this.bucketWatcherRefresh = null
      const currentWatcher = this.sessionWatcher
      if (refreshAgain && currentWatcher && this.changeListeners.size && !this.rootTransitioning) {
        this.refreshBucketWatchers(currentWatcher, this.sessionRoot, this.rootGeneration)
      }
    })
    this.bucketWatcherRefresh = refresh
  }

  private async performBucketWatcherRefresh(rootWatcher: SessionWatcher, watchedRoot: string, generation: number): Promise<void> {
    let entries: Dirent<string>[]
    let root: string
    try {
      [entries, root] = await Promise.all([
        readdir(watchedRoot, { withFileTypes: true }),
        realpath(watchedRoot),
      ])
    } catch { return }
    if (this.sessionWatcher !== rootWatcher || this.rootGeneration !== generation || this.rootTransitioning || !this.changeListeners.size) return

    const bucketNames = entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()
        && entry.name.length > 0 && entry.name.length <= 255 && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort()
      .slice(0, MAX_SESSION_WATCH_DIRECTORIES)
    const wanted = new Set(bucketNames)
    for (const [name, watcher] of this.bucketWatchers) {
      if (wanted.has(name)) continue
      watcher.close()
      this.bucketWatchers.delete(name)
    }

    for (const name of bucketNames) {
      if (this.bucketWatchers.has(name)) continue
      try {
        const bucketPath = await realpath(join(root, name))
        if (this.sessionWatcher !== rootWatcher || this.rootGeneration !== generation || this.rootTransitioning || !this.changeListeners.size) return
        if (!isPathWithin(root, bucketPath) || bucketPath === root) continue
        const watcher = this.watchDirectory(bucketPath, { persistent: false }, (_eventType, filename) => {
          if (this.sessionWatcher !== rootWatcher || this.rootGeneration !== generation || this.rootTransitioning) return
          const leaf = typeof filename === 'string' ? filename : ''
          this.queueSessionChange(leaf ? join(name, leaf) : null, generation)
        })
        this.bucketWatchers.set(name, watcher)
        watcher.on('error', () => {
          if (this.bucketWatchers.get(name) !== watcher || this.rootGeneration !== generation) return
          watcher.close()
          this.bucketWatchers.delete(name)
          this.queueSessionChange(null, generation)
        })
      } catch { /* The root watcher will report replacements and retry discovery. */ }
    }
  }

  private closeBucketWatchers(): void {
    for (const watcher of this.bucketWatchers.values()) watcher.close()
    this.bucketWatchers.clear()
  }

  /**
   * Root-relative watch names this watcher can resolve to one session file:
   * a bare file name, plus exactly one bucket-directory level when watching
   * recursively. Everything else coalesces into a catalog-wide refresh.
   */
  private isWatchedSessionName(name: string): boolean {
    if (!name.endsWith('.jsonl')) return false
    const segments = name.split(sep)
    if (segments.length > (this.recursiveWatch ? 2 : 1)) return false
    return segments.every((segment) => segment.length > 0 && !segment.startsWith('.'))
  }

  private queueSessionChange(filename: string | Buffer | null, generation = this.rootGeneration): void {
    if (this.rootTransitioning || generation !== this.rootGeneration) return
    const name = typeof filename === 'string' ? filename : Buffer.isBuffer(filename) ? filename.toString('utf8') : ''
    if (!name || !this.isWatchedSessionName(name)) {
      this.catalogOnlyChange = true
    } else if (this.changedNames.size < 256) {
      this.changedNames.add(name)
    } else {
      this.catalogOnlyChange = true
    }
    if (!this.changeTimer) {
      const watchedRoot = this.sessionRoot
      const catalog = this.catalog
      this.changeTimer = setTimeout(() => {
        this.changeTimer = null
        void this.flushSessionChanges(generation, watchedRoot, catalog)
      }, 120)
      this.changeTimer.unref()
    }
  }

  private async flushSessionChanges(generation: number, watchedRoot: string, catalog: SessionMetadataCatalog): Promise<void> {
    if (this.rootTransitioning || generation !== this.rootGeneration) return
    const names = [...this.changedNames]
    let catalogOnly = this.catalogOnlyChange
    this.changedNames.clear()
    this.catalogOnlyChange = false

    let paths: string[]
    if (!catalogOnly && names.length) {
      const result = await catalog.reconcileKnownChanges(names)
      if (this.rootTransitioning || generation !== this.rootGeneration) return
      if (result.kind === 'reconciled') {
        paths = result.paths
      } else {
        paths = await this.resolveChangedSessionPaths(names, watchedRoot, generation)
        if (paths.length !== names.length) catalogOnly = true
      }
    } else {
      // Missing/invalid names, watcher errors, and admission overflow leave
      // the changed catalog membership unknowable, so retain the full-scan path.
      catalog.invalidateLiveCatalog()
      paths = await this.resolveChangedSessionPaths(names, watchedRoot, generation)
      if (paths.length !== names.length) catalogOnly = true
    }
    if (this.rootTransitioning || generation !== this.rootGeneration || !this.changeListeners.size) return
    for (const filePath of paths) this.emitChange({ filePath, harness: this.harness })
    if (catalogOnly) this.emitChange({ harness: this.harness })
  }

  private async resolveChangedSessionPaths(names: readonly string[], watchedRoot: string, generation: number): Promise<string[]> {
    return (await Promise.all(names.map(async (name) => {
      if (this.rootTransitioning || generation !== this.rootGeneration) return null
      try {
        const path = await this.requireSessionPathWithinRoot(watchedRoot, join(watchedRoot, name))
        return this.rootTransitioning || generation !== this.rootGeneration ? null : path
      } catch { return null }
    }))).filter((path): path is string => path !== null)
  }

  private emitChange(event: SessionChangeEvent): void {
    for (const listener of this.changeListeners) {
      try { listener(event) } catch { /* A renderer listener cannot break session watching. */ }
    }
  }

  private async readMetadata(filePath: string, knownStat?: Stats): Promise<SessionMetadata> {
    const metadata = await this.metadataReader(filePath, knownStat)
    if (metadata.projectPath) {
      try { metadata.projectPath = await requireExistingDirectory(metadata.projectPath, 'session project path') }
      catch { if (metadata.projectPath.startsWith('/')) metadata.projectPath = resolve(metadata.projectPath) }
    }
    return metadata
  }
}
