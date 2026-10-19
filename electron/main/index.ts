import { app, BrowserWindow, dialog, Menu, nativeTheme, Notification, protocol, session, shell, webContents } from 'electron'
import type { BrowserWindowConstructorOptions, Input, WebContents } from 'electron'
import { basename, extname, isAbsolute, join, relative, resolve, win32 as win32Path } from 'node:path'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { assertNoMcpAuthenticationCommand } from '../../src/lib/mcp-policy'
import { BROWSER_PARTITION, HARNESS_IDS, type ApplicationMenuName, type AppMeta, type AppUpdateState, type HarnessId, type PrimeEventEnvelope, type ProviderAuthEvent, type RuntimeInfo, type ThemeMode } from '../../src/types/api'
import { AgentRpcManager, LOOM_CAPABILITY_MCP_CONFIG, LOOM_RPC_ADAPTER, PI_RPC_ADAPTER } from './agent-rpc'
import { installApplicationMenu } from './application-menu'
import { MacBackgroundController, shouldStartInBackground } from './background'
import { BrowserDownloadGuard } from './browser-downloads'
import { installCrashGuards } from './crash-guard'
import { CuaDriverService } from './cua-driver'
import { GitService } from './git'
import { CheckoutService } from './checkouts'
import { isTrustedRendererUrl, registerIpc, type IpcRegistration } from './ipc'
import { HarnessDiscoveryService, reconcileActiveHarness } from './harness-discovery'
import { HARNESSES } from './harness'
import { beginProcessShutdown, runProcess, stopChildProcesses } from './process-utils'
import { PluginService, beginPluginDiscoveryShutdown } from './plugins'
import type { PrimeProviderService } from './providers'
import { PACKAGED_RENDERER_URL, PACKAGED_SMOKE_READY_EVENT, packagedSmokeMarker, packagedSmokeMarkerPath, serializePackagedSmokeMarker } from './packaged-smoke'
import { PetService } from './pets'
import { ProjectService } from './projects'
import { SettingsService } from './settings-schedules'
import { ScheduledRunExecutor } from './schedules/executor'
import { HeartbeatService } from './schedules/heartbeats'
import { AutomationService } from './schedules/service'
import { AgentScheduleBridge } from './schedules/agent-bridge'
import { AgentBrowserBridge } from './browser/agent-bridge'
import { AgentBrowserService } from './browser/agent-service'
import { AgentCollaborationBridge } from './collaboration/agent-bridge'
import { AgentEnterpriseBridge } from './enterprise/agent-bridge'
import { TeamDevelopmentAgentBridge } from './development/agent-bridge'
import { OperationPrompts } from './operation-prompt'
import { SecretPrompts } from './secret-prompt'
import { ActionConfirmations } from './action-confirmation'
import type { TeamDevelopmentContextInput, TeamWorkspace, TeamWorkspaceCommand } from '../../src/types/team-workspace'
import { configureGooeyPiAgentMessageSigning, loadOrCreateGooeyPiAgentMessageKey } from './collaboration/message-envelope'
import { extensionInjection, resolveExtensionPath, type ExtensionCapability } from './extension-manifest'
import { SessionService } from './sessions'
import { piSessionServiceOptions } from './sessions/pi'
import { loomSessionServiceOptions } from './sessions/loom'
import { type JsonStateStore, openDesktopStateStore, StateCompatibilityError, StateMigrationError } from './store'
import { TerminalService } from './terminal'
import { RepositoryUseGate } from './repository-use-gate'
import { VoiceService, sessionOnlyVoiceSecretCodec } from './voice'
import { isAllowedRendererAudioPermission } from './voice-permissions'
import { createManualUpdateCheck, getAutoUpdater, UpdateService } from './updates'

protocol.registerSchemesAsPrivileged([{ scheme: 'prime-work', privileges: { standard: true, secure: true, supportFetchAPI: true } }])

let mainWindow: BrowserWindow | null = null
let ipc: IpcRegistration | null = null
let agents: AgentRpcManager | null = null
let loomAgents: AgentRpcManager | null = null
let loomCapabilityHost: import('./loom-capabilities').LoomCapabilityHost | null = null
let piAgents: AgentRpcManager | null = null
let terminals: TerminalService | null = null
let downloads: BrowserDownloadGuard | null = null
let providerService: PrimeProviderService | null = null
let updateService: UpdateService | null = null
let store: JsonStateStore | null = null
let automation: AutomationService | null = null
let agentScheduleBridges: AgentScheduleBridge[] = []
let agentBrowser: AgentBrowserService | null = null
let agentBrowserBridge: AgentBrowserBridge | null = null
let agentCollaborationBridge: AgentCollaborationBridge | null = null
let agentEnterpriseBridge: AgentEnterpriseBridge | null = null
let runAttention: import('./enterprise/run-attention').RunAttentionService | null = null
let teamDevelopmentBridge: TeamDevelopmentAgentBridge | null = null
let backgroundMode: MacBackgroundController | null = null
let shutdownStarted = false
let shutdownApproved = false
let confirmingShutdown = false
let trustedRendererUrl = ''
let packagedSmokeMarkerFile: string | null = null
let windowCreation: Promise<BrowserWindow | null> | null = null
let startInBackground = false
const keepTestWindowsHidden = process.env.PRIME_WORK_E2E_HIDE_WINDOWS === '1'

installCrashGuards({
  logPath: () => {
    try { return join(app.getPath('userData'), 'crash.log') } catch { return null }
  },
  cleanup: async () => {
    agents?.beginShutdown()
    piAgents?.beginShutdown()
    loomAgents?.beginShutdown()
    beginProcessShutdown()
    await Promise.allSettled([agents?.stopAll() ?? Promise.resolve(), piAgents?.stopAll() ?? Promise.resolve(), loomAgents?.stopAll() ?? Promise.resolve(), stopChildProcesses()])
  },
})

function appIconPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(app.getAppPath(), 'assets', 'icon.png')
}

// One policy for every surface that serves renderer content: the app protocol
// response headers and the packaged browser-session header rewrite.
const RENDERER_CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"

const rendererContentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.map': 'application/json; charset=utf-8',
}

function registerRendererProtocol(): void {
  if (!app.isPackaged) return
  const rendererRoot = resolve(__dirname, '../renderer')
  protocol.handle('prime-work', async (request) => {
    try {
      const url = new URL(request.url)
      if (url.hostname !== 'app' || url.username || url.password || url.search || url.hash) return new Response('Not found', { status: 404 })
      const decoded = decodeURIComponent(url.pathname)
      const candidate = resolveRendererAssetPath(rendererRoot, decoded)
      if (!candidate) return new Response('Not found', { status: 404 })
      const body = await readFile(candidate)
      return new Response(body, { headers: {
        'Content-Type': rendererContentTypes[extname(candidate).toLowerCase()] ?? 'application/octet-stream',
        'Content-Security-Policy': RENDERER_CONTENT_SECURITY_POLICY,
        'X-Content-Type-Options': 'nosniff',
      } })
    } catch { return new Response('Not found', { status: 404 }) }
  })
}

/** Resolves a renderer URL path without relying on a platform-specific separator. */
export function resolveRendererAssetPath(rendererRoot: string, decodedPath: string): string | null {
  if (!decodedPath.startsWith('/') || decodedPath.includes('\0') || decodedPath.includes('\\')) return null
  const pathApi = /^[A-Za-z]:[\\/]/.test(rendererRoot) ? win32Path : { resolve, relative, isAbsolute }
  const candidate = pathApi.resolve(rendererRoot, `.${decodedPath === '/' ? '/index.html' : decodedPath}`)
  const relativePath = pathApi.relative(rendererRoot, candidate)
  if (!relativePath || relativePath.startsWith('..') || pathApi.isAbsolute(relativePath)) return null
  return candidate
}

function resolveRendererUrl(): string {
  const developmentUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
  if (!developmentUrl) return app.isPackaged ? PACKAGED_RENDERER_URL : pathToFileURL(join(__dirname, '../renderer/index.html')).href
  const parsed = new URL(developmentUrl)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
    throw new Error('ELECTRON_RENDERER_URL must use an uncredentialed loopback HTTP(S) origin')
  }
  return parsed.href
}

function isAllowedBrowserUrl(raw: string): boolean {
  if (raw === 'about:blank') return true
  try { const url = new URL(raw); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password } catch { return false }
}

export function hardenRenderer(window: BrowserWindow, trustedUrl: () => string = () => trustedRendererUrl): void {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('context-menu', (_event, params) => {
    if (params.mediaType !== 'image' || !params.hasImageContents) return
    const contents = window.webContents
    Menu.buildFromTemplate([{
      label: 'Copy Image',
      click: () => { if (!window.isDestroyed() && !contents.isDestroyed()) contents.copyImageAt(params.x, params.y) },
    }]).popup({ window })
  })
  window.webContents.on('will-attach-webview', (event, preferences, params) => {
    delete preferences.preload
    preferences.nodeIntegration = false
    preferences.nodeIntegrationInSubFrames = false
    preferences.contextIsolation = true
    preferences.sandbox = true
    preferences.webSecurity = true
    preferences.allowRunningInsecureContent = false
    // A guest page must never be able to attach a nested guest of its own.
    preferences.webviewTag = false
    const partition = typeof params.partition === 'string' ? params.partition : ''
    if (partition !== BROWSER_PARTITION || !isAllowedBrowserUrl(params.src)) event.preventDefault()
  })
  window.webContents.on('did-attach-webview', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event, target) => { if (!isAllowedBrowserUrl(target)) event.preventDefault() })
    contents.on('will-redirect', (event) => { if (!isAllowedBrowserUrl(event.url)) event.preventDefault() })
    contents.on('will-frame-navigate', (event) => { if (!isAllowedBrowserUrl(event.url)) event.preventDefault() })
    contents.once('destroyed', () => downloads?.cancelOwner(contents.id))
    // Guests reaching this point passed the will-attach-webview partition and
    // URL gates above, which makes them eligible for agent control.
    agentBrowser?.approveGuest(contents)
  })
  window.webContents.on('will-navigate', (event, target) => {
    const current = window.webContents.getURL()
    if (target !== current) event.preventDefault()
  })
  // Server redirects and sub-frame navigations bypass will-navigate; hold them
  // to the same trusted-renderer predicate the IPC gate uses.
  window.webContents.on('will-redirect', (event) => {
    if (!isTrustedRendererUrl(event.url, trustedUrl())) event.preventDefault()
  })
  window.webContents.on('will-frame-navigate', (event) => {
    if (!isTrustedRendererUrl(event.url, trustedUrl())) event.preventDefault()
  })
}

interface InitialRendererWindow {
  loadURL(url: string): Promise<unknown>
  isDestroyed(): boolean
  destroy(): void
}

export async function loadInitialRenderer(window: InitialRendererWindow, rendererUrl: string): Promise<void> {
  try {
    await window.loadURL(rendererUrl)
  } catch (error) {
    if (!window.isDestroyed()) window.destroy()
    throw error
  }
}

/** Work that would be lost by quitting: in-flight agent turns and armed schedules. */
export interface ActiveShutdownWork {
  runningAgents: number
  activeSchedules: boolean
}

export interface ShutdownPrompt {
  message: string
  detail: string
}

export function activeShutdownWork(runtimes: readonly RuntimeInfo[], hasActiveSchedules: boolean): ActiveShutdownWork {
  const running = runtimes.filter((runtime) => runtime.isStreaming
    || runtime.isCompacting === true
    || runtime.sessionActions?.active !== undefined
    || (runtime.sessionActions?.queuedCount ?? 0) > 0)
  return { runningAgents: running.length, activeSchedules: hasActiveSchedules }
}

/** Null when nothing is active, which is the signal to close without a prompt. */
export function shutdownPrompt(work: ActiveShutdownWork): ShutdownPrompt | null {
  const details: string[] = []
  if (work.runningAgents > 0) {
    details.push(work.runningAgents === 1
      ? 'An agent run is still in progress and will be stopped.'
      : `${work.runningAgents} agent runs are still in progress and will be stopped.`)
  }
  if (work.activeSchedules) details.push('Scheduled automations will not run while GooeyPi is closed.')
  if (details.length === 0) return null
  return {
    message: work.runningAgents > 0 ? 'Close GooeyPi while an agent is running?' : 'Close GooeyPi?',
    detail: details.join(' '),
  }
}

export async function confirmAppClose(window: BrowserWindow | null, prompt: ShutdownPrompt): Promise<boolean> {
  const options = {
    type: 'warning' as const,
    buttons: ['Cancel', 'Close GooeyPi'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'GooeyPi',
    ...prompt,
  }
  const { response } = window && !window.isDestroyed()
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options)
  return response === 1
}

function pendingShutdownPrompt(): ShutdownPrompt | null {
  const runtimes = [...(agents?.list() ?? []), ...(piAgents?.list() ?? []), ...(loomAgents?.list() ?? [])]
  return shutdownPrompt(activeShutdownWork(runtimes, automation?.hasActiveSchedules() ?? false))
}

/**
 * The one confirmation path for both ✕ and Quit: the dialog is async so agent
 * RPC, IPC, and schedule ticks keep running while it is open, and the approved
 * flag lets the programmatic quit through without re-asking.
 */
function requestShutdown(window: BrowserWindow | null, prompt: ShutdownPrompt): void {
  confirmingShutdown = true
  void confirmAppClose(window, prompt).then((approved) => {
    if (!approved) return
    shutdownApproved = true
    app.quit()
  }).catch((error: unknown) => {
    console.error(`GooeyPi close confirmation failed: ${boundedErrorMessage(error)}`)
  }).finally(() => { confirmingShutdown = false })
}

export function interfaceZoomFactor(): number {
  return (store?.getSettings().interfaceFontScale ?? 110) / 100
}

/**
 * App windows only: embedded browser guests and their views keep their own
 * zoom, so the app scale is applied through the window list rather than to
 * every webContents in the process.
 */
function applyInterfaceZoom(scale: number): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue
    const contents = window.webContents
    if (!contents.isDestroyed()) contents.setZoomFactor(scale / 100)
  }
}

type ResolvedTheme = Exclude<ThemeMode, 'system'>

function windowsTitleBarOverlay(theme: ResolvedTheme): { color: string; symbolColor: string; height: number } {
  return theme === 'dark'
    ? { color: '#171716', symbolColor: '#f1f1ee', height: 32 }
    : { color: '#ffffff', symbolColor: '#20201e', height: 32 }
}

function resolvedWindowTheme(theme: ThemeMode | undefined): ResolvedTheme {
  if (theme === 'dark') return 'dark'
  if (theme === 'system' && nativeTheme.shouldUseDarkColors) return 'dark'
  return 'light'
}

export function mainWindowChromeOptions(platform: NodeJS.Platform = process.platform, theme: ResolvedTheme = 'light'): BrowserWindowConstructorOptions {
  if (platform === 'darwin') return {
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    vibrancy: 'sidebar',
    visualEffectState: 'active',
  }
  if (platform === 'win32') return {
    // The native caption controls share a dedicated menu row. GooeyPi's own
    // 52px toolbar remains a separate application surface below it.
    titleBarStyle: 'hidden',
    titleBarOverlay: windowsTitleBarOverlay(theme),
    autoHideMenuBar: true,
  }
  if (platform === 'linux') return {
    titleBarStyle: 'hidden',
    titleBarOverlay: { height: 52 },
    autoHideMenuBar: true,
  }
  return { titleBarStyle: 'default' }
}

export function isMacWindowCloseShortcut(
  input: Pick<Input, 'type' | 'key' | 'shift' | 'control' | 'alt' | 'meta'>,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'darwin'
    && input.type === 'keyDown'
    && input.key.toLowerCase() === 'q'
    && input.meta
    && !input.shift
    && !input.control
    && !input.alt
}

export function popupApplicationMenu(sender: WebContents, menuName: ApplicationMenuName, x: number, y: number): boolean {
  const window = BrowserWindow.fromWebContents(sender)
  const applicationMenu = Menu.getApplicationMenu()
  const menuItem = applicationMenu?.items.find((item) => item.label.replaceAll('&', '').toLowerCase() === menuName)
  if (!window || window.isDestroyed() || !menuItem?.submenu) return false
  const zoom = sender.getZoomFactor()
  menuItem.submenu.popup({ window, x: Math.round(x * zoom), y: Math.round(y * zoom) })
  return true
}

export function setTitleBarTheme(sender: WebContents, theme: ResolvedTheme): boolean {
  const window = BrowserWindow.fromWebContents(sender)
  if (process.platform !== 'win32' || !window || window.isDestroyed()) return false
  window.setTitleBarOverlay(windowsTitleBarOverlay(theme))
  return true
}

async function createWindow(): Promise<BrowserWindow | null> {
  if (shutdownStarted) return null
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#f5f5f4',
    icon: appIconPath(),
    ...mainWindowChromeOptions(process.platform, resolvedWindowTheme(store?.getSettings().theme)),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      zoomFactor: interfaceZoomFactor(),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: true,
    },
  })
  mainWindow = window
  const renderer = window.webContents
  const rendererId = renderer.id
  hardenRenderer(window)
  renderer.on('before-input-event', (event, input) => {
    if (!isMacWindowCloseShortcut(input)) return
    event.preventDefault()
    if (!window.isDestroyed()) window.close()
  })
  renderer.on('did-finish-load', () => {
    if (renderer.isDestroyed()) return
    // A reload resets the zoom factor, so the persisted scale is re-applied
    // on every load rather than only at window creation.
    renderer.setZoomFactor(interfaceZoomFactor())
    if (isTrustedRendererUrl(renderer.getURL(), trustedRendererUrl)) ipc?.authorize(renderer)
  })
  renderer.on('did-start-navigation', (_event, url, _isInPlace, isMainFrame) => {
    if (isMainFrame && !isTrustedRendererUrl(url, trustedRendererUrl)) ipc?.revoke(rendererId)
  })
  renderer.on('render-process-gone', () => ipc?.revoke(rendererId))
  let rendererLoaded = false
  let readyToShow = false
  window.once('ready-to-show', () => {
    readyToShow = true
    if (!keepTestWindowsHidden && !backgroundMode?.isBackgrounded() && rendererLoaded && !shutdownStarted && !window.isDestroyed() && mainWindow === window) window.show()
  })
  window.on('close', (event) => {
    if (shutdownStarted || shutdownApproved) return
    if (backgroundMode?.handleWindowClose(window)) {
      event.preventDefault()
      return
    }
    const prompt = pendingShutdownPrompt()
    if (!prompt) return
    event.preventDefault()
    if (!confirmingShutdown) requestShutdown(window, prompt)
  })
  window.on('closed', () => {
    ipc?.revoke(rendererId)
    if (mainWindow === window) mainWindow = null
  })
  try {
    await loadInitialRenderer(window, trustedRendererUrl)
  } catch (error) {
    ipc?.revoke(rendererId)
    if (mainWindow === window) mainWindow = null
    throw error
  }
  if (shutdownStarted || window.isDestroyed() || mainWindow !== window) {
    ipc?.revoke(rendererId)
    if (!window.isDestroyed()) window.destroy()
    if (mainWindow === window) mainWindow = null
    return null
  }
  rendererLoaded = true
  if (!keepTestWindowsHidden && !backgroundMode?.isBackgrounded() && readyToShow) window.show()
  return window
}

function ensureWindow(): Promise<BrowserWindow | null> {
  if (shutdownStarted) return Promise.resolve(null)
  if (mainWindow && !mainWindow.isDestroyed()) return windowCreation ?? Promise.resolve(mainWindow)
  if (windowCreation) return windowCreation
  const creation = createWindow()
  windowCreation = creation
  const clearCreation = () => { if (windowCreation === creation) windowCreation = null }
  void creation.then(clearCreation, clearCreation)
  return creation
}

function boundedErrorMessage(error: unknown, maxLength = 512): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[\r\n\t]+/g, ' ').slice(0, maxLength) || 'Unknown error'
}

export interface StartupFailureDialog {
  title: string
  detail: string
}

export function startupFailureDialog(error: unknown): StartupFailureDialog | null {
  if (error instanceof StateMigrationError) {
    return { title: 'GooeyPi state migration failed', detail: boundedErrorMessage(error, 2_048) }
  }
  if (error instanceof StateCompatibilityError) {
    return { title: 'GooeyPi update required', detail: boundedErrorMessage(error, 2_048) }
  }
  return null
}

/** Filesystem locations of the shared capabilities injected into Pi Work. */
export interface CapabilityExtensionPaths {
  schedule: string
  browser: string
  askUser: string
}

/**
 * Runtime environment for Pi Work: capability-broker variables from the
 * schedule and browser bridges plus extension paths passed through the Pi
 * adapter as --extension arguments.
 */
export function extensionRuntimeEnvironment(
  scheduleBridgeEnvironment: NodeJS.ProcessEnv,
  browserBridgeEnvironment: () => NodeJS.ProcessEnv,
  extensionPaths: CapabilityExtensionPaths,
  askUserEnabled = true,
  browserEnabled = true,
): NodeJS.ProcessEnv {
  const { PRIME_WORK_SCHEDULE_SKILL_PATH: _scheduleSkill, ...scheduleEnvironment } = scheduleBridgeEnvironment
  const browserEnvironment = browserEnabled ? browserBridgeEnvironment() : {}
  const { PRIME_WORK_BROWSER_SKILL_PATH: _browserSkill, ...runtimeBrowserEnvironment } = browserEnvironment
  return {
    ...scheduleEnvironment,
    ...runtimeBrowserEnvironment,
    PRIME_WORK_SCHEDULE_EXTENSION_PATH: extensionPaths.schedule,
    PRIME_WORK_BROWSER_EXTENSION_PATH: browserEnabled ? extensionPaths.browser : undefined,
    PRIME_WORK_ASK_USER_EXTENSION_PATH: askUserEnabled ? extensionPaths.askUser : undefined,
    GOOEYPI_MANAGES_ASK_USER: '1',
  }
}

export async function settleShutdown(
  steps: ReadonlyArray<PromiseLike<unknown>>,
  options: { watchdogMs?: number; log?: (message: string) => void } = {},
): Promise<void> {
  const log = options.log ?? ((message: string) => console.error(message))
  const watchdogMs = options.watchdogMs ?? 10_000
  const settled = Promise.allSettled(steps).then((results) => {
    for (const result of results) {
      if (result.status === 'rejected') log(`GooeyPi shutdown step failed: ${boundedErrorMessage(result.reason)}`)
    }
  })
  let timer: NodeJS.Timeout | undefined
  const watchdog = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      log(`GooeyPi shutdown did not finish within ${watchdogMs} ms; quitting anyway`)
      resolve()
    }, watchdogMs)
    timer.unref?.()
  })
  try {
    await Promise.race([settled, watchdog])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function requestWindow(reason: 'activation' | 'second instance' | 'menu bar' | 'settings', afterOpen?: (window: BrowserWindow) => void): void {
  void ensureWindow().then((window) => {
    if (!window || shutdownStarted || window.isDestroyed()) return
    if (!keepTestWindowsHidden) {
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
    }
    afterOpen?.(window)
  }).catch((error: unknown) => {
    if (!shutdownStarted) console.error(`GooeyPi failed to open a window after ${reason}: ${boundedErrorMessage(error)}`)
  })
}

function revealApplication(reason: 'activation' | 'second instance'): void {
  if (backgroundMode) backgroundMode.open()
  else requestWindow(reason)
}

export function routeAllWindowsClosed(
  shutdownInProgress: boolean,
  background: Pick<MacBackgroundController, 'handleAllWindowsClosed'> | null,
  quit: () => void,
): void {
  if (shutdownInProgress) return
  if (!background?.handleAllWindowsClosed()) quit()
}

async function bootstrap(): Promise<void> {
  const userDataPath = app.getPath('userData')
  configureGooeyPiAgentMessageSigning(loadOrCreateGooeyPiAgentMessageKey(join(userDataPath, 'agent-message-signing.key')))
  const stateStore = await openDesktopStateStore(userDataPath)
  store = stateStore
  backgroundMode = new MacBackgroundController({
    iconPath: appIconPath(),
    getSettings: () => stateStore.getSettings(),
    onOpen: () => requestWindow('menu bar'),
    onSettings: () => requestWindow('settings', (window) => {
      if (!window.webContents.isDestroyed()) window.webContents.send('app:open-settings')
    }),
    onQuit: () => app.quit(),
    startInBackground,
  })
  const discovery = new HarnessDiscoveryService(() => stateStore.getSettings().runtimePaths, { requirePrivateProfiles: true, profileEnvironment: (harness) => profiles[harness].environment })
  const primeExecutable = () => discovery.executable('prime')
  const piExecutable = () => discovery.executable('pi')
  const loomExecutable = () => discovery.executable('loom')
  const profiles = await (await import('./runtime-profiles')).initializeRuntimeProfiles(userDataPath, piExecutable, async (url) => { await shell.openExternal(url, { activate: true }) }, loomExecutable)
  const initialHarnesses = await discovery.refresh()
  await reconcileActiveHarness(stateStore, initialHarnesses)
  if (shutdownStarted) return
  const { enterprise, accountScope, connectionImport } = await (await import('./enterprise/connection-config')).initializeEnterpriseService(userDataPath, {
    // Hidden test runs open no browser and save no sign-in.
    openExternal: async (url) => { if (!keepTestWindowsHidden) await shell.openExternal(url, { activate: true }) },
    persistSession: !keepTestWindowsHidden,
  })
  let enterpriseAccountScope = accountScope
  let accountScopeChanging = false
  const assertAccountScopeReady = (): void => {
    if (accountScopeChanging) throw new Error('账号切换中，请稍后重试')
  }
  const workspaceRootForAccount = (accountScope: string | undefined) => accountScope
    ? join(userDataPath, 'workspaces', 'accounts', accountScope)
    : join(userDataPath, 'workspaces')
  const personalWorkspaceForAccount = (harness: HarnessId, accountScope: string | undefined) => join(workspaceRootForAccount(accountScope), harness)
  const sessionRootForScope = (harness: HarnessId, accountScope: string | undefined) => join(userDataPath, 'agent-sessions', 'accounts', accountScope ?? 'signed-out', harness)
  const sessionRootForAccount = (harness: HarnessId, accountScope = enterpriseAccountScope) => sessionRootForScope(harness, accountScope)
  const sessions = new SessionService(stateStore, primeExecutable, undefined, { sessionRoot: sessionRootForAccount('prime'), environment: profiles.prime.environment })
  const piSessions = new SessionService(stateStore, null, undefined, { ...piSessionServiceOptions(), sessionRoot: sessionRootForAccount('pi'), environment: profiles.pi.environment })
  const loomSessions = new SessionService(stateStore, null, undefined, { ...loomSessionServiceOptions(sessionRootForAccount('loom')), environment: profiles.loom.environment })
  const projects = new ProjectService(stateStore, () => mainWindow)
  const piProjects = new ProjectService(stateStore, () => mainWindow, 'pi')
  const loomProjects = new ProjectService(stateStore, () => mainWindow, 'loom')
  const projectServicesByHarness = { prime: projects, pi: piProjects, loom: loomProjects } as const
  const projectServices = [projects, piProjects, loomProjects] as const
  const sessionServices = { prime: sessions, pi: piSessions, loom: loomSessions } as const
  for (const service of projectServices) service.setAccountScope(enterpriseAccountScope)
  {
    const roots = HARNESS_IDS.map((harness) => [sessionServices[harness], sessionRootForAccount(harness)] as const)
    await Promise.all(roots.map(([, root]) => mkdir(root, { recursive: true, mode: 0o700 })))
    for (const [service, root] of roots) await service.setSessionRoot(root)
  }
  await Promise.all(HARNESS_IDS.map((harness) => projectServicesByHarness[harness].ensurePersonalWorkspace(personalWorkspaceForAccount(harness, enterpriseAccountScope))))
  const repositoryUseGate = new RepositoryUseGate()
  const checkouts: Record<HarnessId, CheckoutService> = {
    prime: new CheckoutService(() => stateStore.getSettings().checkoutStrategy, projects, repositoryUseGate),
    pi: new CheckoutService(() => stateStore.getSettings().checkoutStrategy, piProjects, repositoryUseGate),
    loom: new CheckoutService(() => stateStore.getSettings().checkoutStrategy, loomProjects, repositoryUseGate),
  }
  // Git and terminals are harness-agnostic: a cwd (or bound session) is valid
  // when any harness's own grants authorize it. Prime is consulted first so
  // Prime-only setups keep their exact behavior and error text.
  const authorizeEitherCwd = async (cwd: string): Promise<string> => {
    assertAccountScopeReady()
    try { return await projects.authorizeCwd(cwd) } catch (error) {
      for (const fallback of [piProjects, loomProjects]) {
        try { return await fallback.authorizeCwd(cwd) } catch { /* try the next harness; the Prime error is rethrown */ }
      }
      throw error
    }
  }
  const authorizeEitherReadOnlyCwd = async (cwd: string): Promise<string> => {
    assertAccountScopeReady()
    try { return await projects.authorizeReadOnlyCwd(cwd) } catch (error) {
      for (const fallback of [piProjects, loomProjects]) {
        try { return await fallback.authorizeReadOnlyCwd(cwd) } catch { /* try the next harness; the Prime error is rethrown */ }
      }
      throw error
    }
  }
  const requireEitherSessionPath = async (path: string): Promise<string> => {
    assertAccountScopeReady()
    try { return await sessions.requireSessionPath(path) } catch (error) {
      for (const fallback of [piSessions, loomSessions]) {
        try { return await fallback.requireSessionPath(path) } catch { /* try the next harness; the Prime error is rethrown */ }
      }
      throw error
    }
  }
  const git = new GitService(authorizeEitherCwd, authorizeEitherReadOnlyCwd)
  // This matches the renderer's startup query so both consumers share SessionService's coalesced catalog scan.
  const listCatalogSessions = (): ReturnType<SessionService['list']> => sessions.list(undefined, true)

  const providers = profiles.providers
  providerService = providers
  const disabledProviders = () => new Set(stateStore.getSettings().disabledProviders)
  const disabledModels = () => new Set(stateStore.getSettings().disabledModels)
  const piDisabledProviders = () => new Set(stateStore.getSettings().piDisabledProviders)
  const piDisabledModels = () => new Set(stateStore.getSettings().piDisabledModels)
  const piCatalog = profiles.piCatalog
  agents = new AgentRpcManager(
    primeExecutable,
    (cwd) => projects.authorizeCwd(cwd),
    (path) => sessions.requireSessionPath(path),
    providers,
    disabledProviders,
  )
  agents.setDisabledModelsProvider(disabledModels)
  agents.setWorkspaceUseProvider((cwd, owner, retireIfIdle) => repositoryUseGate.beginWorkspaceUse(cwd, owner, retireIfIdle))
  const piManager = new AgentRpcManager(
    piExecutable,
    (cwd) => piProjects.authorizeCwd(cwd),
    (path) => piSessions.requireSessionPath(path),
    piCatalog,
    piDisabledProviders,
    PI_RPC_ADAPTER,
  )
  piManager.setDisabledModelsProvider(piDisabledModels)
  piManager.setWorkspaceUseProvider((cwd, owner, retireIfIdle) => repositoryUseGate.beginWorkspaceUse(cwd, owner, retireIfIdle))
  piAgents = piManager
  // Loom runs the providers connected for Prime Work, with their visibility settings.
  const loomCatalog = profiles.loomCatalog
  const loomManager = new AgentRpcManager(
    loomExecutable,
    (cwd) => loomProjects.authorizeCwd(cwd),
    (path) => loomSessions.requireSessionPath(path),
    loomCatalog,
    disabledProviders,
    LOOM_RPC_ADAPTER,
  )
  loomManager.setDisabledModelsProvider(disabledModels)
  loomManager.setWorkspaceUseProvider((cwd, owner, retireIfIdle) => repositoryUseGate.beginWorkspaceUse(cwd, owner, retireIfIdle))
  loomAgents = loomManager
  sessions.bindRuntimeHooks({
    get: (path) => agents?.getForSession(path),
    all: () => agents?.list() ?? [],
    stop: async (path) => { await agents?.stopForSession(path) },
    rename: async (path, title) => agents?.renameForSession(path, title) ?? false,
  })
  piSessions.bindRuntimeHooks({
    get: (path) => piAgents?.getForSession(path),
    all: () => piAgents?.list() ?? [],
    stop: async (path) => { await piAgents?.stopForSession(path) },
    rename: async (path, title) => piAgents?.renameForSession(path, title) ?? false,
  })
  loomSessions.bindRuntimeHooks({
    get: (path) => loomAgents?.getForSession(path),
    all: () => loomAgents?.list() ?? [],
    stop: async (path) => { await loomAgents?.stopForSession(path) },
    rename: async (path, title) => loomAgents?.renameForSession(path, title) ?? false,
  })
  terminals = new TerminalService(
    authorizeEitherCwd,
    () => stateStore.getSettings().terminalShell,
    requireEitherSessionPath,
    (cwd, owner) => repositoryUseGate.beginWorkspaceUse(cwd, owner),
  )
  projects.bindProviders({
    sessions: listCatalogSessions,
    branch: (cwd) => git.branch(cwd),
    stopProjectProcesses: async (roots) => {
      plugins.evictProjects(roots)
      await Promise.all([agents!.stopForProjectRoots(roots), terminals!.killForProjectRoots(roots)])
    },
  })
  piProjects.bindProviders({
    sessions: () => piSessions.list(undefined, true),
    branch: (cwd) => git.branch(cwd),
    stopProjectProcesses: async (roots) => {
      piPlugins.evictProjects(roots)
      await Promise.all([piManager.stopForProjectRoots(roots), terminals!.killForProjectRoots(roots)])
    },
  })
  loomProjects.bindProviders({
    sessions: () => loomSessions.list(undefined, true),
    branch: (cwd) => git.branch(cwd),
    stopProjectProcesses: async (roots) => {
      loomPlugins.evictProjects(roots)
      await Promise.all([loomManager.stopForProjectRoots(roots), terminals!.killForProjectRoots(roots)])
    },
  })
  downloads = new BrowserDownloadGuard(isAllowedBrowserUrl, app.getPath('downloads'))
  const settings = new SettingsService(
    stateStore,
    (shell) => terminals!.validateShell(shell),
    () => downloads?.cancelAll(true),
    (previous, next) => backgroundMode?.applySettings(previous, next),
  )
  const cuaDriver = new CuaDriverService()
  // The disabled-by-default integration probes PATH and may spawn a version
  // command. Defer that work until it is enabled or its settings UI is opened.
  if (stateStore.getSettings().computerUseEnabled) await cuaDriver.status()
  const voice = new VoiceService({
    secretPath: join(app.getPath('userData'), 'voice-secrets.json'),
    secretCodec: sessionOnlyVoiceSecretCodec,
    settings: () => stateStore.getSettings(),
    projects: { prime: projects, pi: piProjects, loom: loomProjects },
    agents: { prime: agents, pi: piManager, loom: loomManager },
    catalogs: { prime: providers, pi: piCatalog, loom: loomCatalog },
    runProcess,
  })
  const pets = new PetService({
    builtInRoot: app.isPackaged ? join(process.resourcesPath, 'pets') : join(app.getAppPath(), 'assets', 'pets'),
    codexRoot: join(homedir(), '.codex', 'pets'),
  })
  const browserProfile = session.fromPartition(BROWSER_PARTITION)
  browserProfile.on('will-download', (event, item, owner) => downloads?.handle(event, item, owner, settings.get().browserAskForDownloads))
  const scheduleSkillPath = app.isPackaged
    ? join(process.resourcesPath, 'skills', 'prime-work-schedules')
    : join(app.getAppPath(), 'assets', 'skills', 'prime-work-schedules')
  const browserSkillPath = app.isPackaged
    ? join(process.resourcesPath, 'skills', 'prime-work-browser')
    : join(app.getAppPath(), 'assets', 'skills', 'prime-work-browser')
  const computerUseSkillPath = app.isPackaged
    ? join(process.resourcesPath, 'skills', 'gooeypi-computer-use', 'SKILL.md')
    : join(app.getAppPath(), 'assets', 'skills', 'gooeypi-computer-use', 'SKILL.md')
  const extensionPathContext = {
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
  }
  const extensionPathFor = (harness: HarnessId, capability: ExtensionCapability): string =>
    resolveExtensionPath(extensionInjection(harness, capability).filename, extensionPathContext)
  const primeBrowserExtensionPath = extensionPathFor('prime', 'browser')
  const workBrowserExtensionPath = extensionPathFor('pi', 'browser')
  const workScheduleExtensionPath = extensionPathFor('pi', 'schedule')
  const askUserExtensionPath = extensionPathFor('pi', 'askUser')
  const collaborationExtensionPath = extensionPathFor('pi', 'collaboration')
  const enterpriseExtensionPath = extensionPathFor('pi', 'enterprise')
  const teamDevelopmentExtensionPath = extensionPathFor('pi', 'teamDevelopment')
  const piFastModeExtensionPath = extensionPathFor('pi', 'piFastMode')
  const computerUseSkill = async () => {
    const status = await cuaDriver.status()
    return {
      id: 'gooeypi-computer-use', name: 'Computer Use | TryCUA',
      description: 'Drive native apps through a separately installed TryCUA driver. Install the driver before enabling.',
      kind: 'extension' as const, location: 'system' as const, path: computerUseSkillPath,
      enabled: stateStore.getSettings().computerUseEnabled,
      availability: { available: status.available, detail: status.detail, actionUrl: status.available ? undefined : status.installUrl },
    }
  }
  const plugins = new PluginService(primeExecutable, (path) => projects.authorizeProjectRoot(path), {
    ...profiles.prime, isolated: true,
    builtInSkills: async () => [{
      id: 'prime-work-schedules', name: 'Scheduled tasks',
      description: 'Create and manage durable project and thread schedules from an agent.',
      kind: 'skill', location: 'system', path: scheduleSkillPath, enabled: true,
    }, {
      id: 'gooeypi-ask-user', name: 'Ask user',
      description: 'Ask focused multiple-choice questions in the GooeyPi app across Prime Agent and Pi Work.',
      kind: 'extension', location: 'system', path: askUserExtensionPath, enabled: stateStore.getSettings().askUserEnabled,
    }, {
      id: 'prime-work-browser', name: 'Browser',
      description: 'Drive the in-app browser for this thread: tabs, navigation, clicks, typing, and screenshots.',
      kind: 'skill', location: 'system', path: browserSkillPath, enabled: stateStore.getSettings().browserEnabled,
    }, await computerUseSkill(), ...providers.mcpCapabilities()],
  })
  const piPlugins = new PluginService(piExecutable, (path) => piProjects.authorizeProjectRoot(path), {
    ...profiles.pi, isolated: true,
    harness: 'pi',
    builtInSkills: async () => [{
      id: 'gooeypi-work-schedules', name: 'Scheduled tasks',
      description: 'Create and manage durable project and thread schedules from Pi Work.',
      kind: 'extension', location: 'system', path: workScheduleExtensionPath, enabled: true,
    }, {
      id: 'gooeypi-work-browser', name: 'Browser',
      description: 'Drive this thread\'s in-app browser from Pi Work.',
      kind: 'extension', location: 'system', path: workBrowserExtensionPath, enabled: stateStore.getSettings().browserEnabled,
    }, {
      id: 'gooeypi-ask-user', name: 'Ask user',
      description: 'Ask focused multiple-choice questions in the GooeyPi app from Pi Work.',
      kind: 'extension', location: 'system', path: askUserExtensionPath, enabled: stateStore.getSettings().askUserEnabled,
    }, await computerUseSkill()],
  })
  const loomPlugins = new PluginService(loomExecutable, (path) => loomProjects.authorizeProjectRoot(path), {
    ...profiles.loom, isolated: true,
    harness: 'loom',
    builtInSkills: async () => [await computerUseSkill()],
  })
  const heartbeats = new HeartbeatService(agents, primeExecutable, () => ({ ...profiles.prime.environment, PRIME_AGENT_SESSION_DIR: sessionRootForAccount('prime') }))
  const primeScheduledRuns = new ScheduledRunExecutor(
    projects,
    sessions,
    agents,
    providers,
    () => new Set(stateStore.getSettings().disabledProviders),
    () => new Set(stateStore.getSettings().disabledModels),
  )
  const piScheduledRuns = new ScheduledRunExecutor(
    piProjects,
    piSessions,
    piManager,
    piCatalog,
    () => new Set(stateStore.getSettings().piDisabledProviders),
    () => new Set(stateStore.getSettings().piDisabledModels),
  )
  const loomScheduledRuns = new ScheduledRunExecutor(
    loomProjects,
    loomSessions,
    loomManager,
    loomCatalog,
    disabledProviders,
    disabledModels,
  )
  const scheduledRuns: Record<HarnessId, ScheduledRunExecutor> = { prime: primeScheduledRuns, pi: piScheduledRuns, loom: loomScheduledRuns }
  const schedules = new AutomationService(stateStore, {
    initialOwnerScope: enterpriseAccountScope ?? null,
    accountScopeDrainTimeoutMs: 30_000,
    validateTarget: (target, harness) => scheduledRuns[harness].validateTarget(target),
    validateExecution: (execution, harness) => scheduledRuns[harness].validateExecution(execution),
    validatePrompt: assertNoMcpAuthenticationCommand,
    run: (task) => scheduledRuns[task.harness].run(task),
  })
  automation = schedules
  await schedules.start()
  const scheduleBridge = new AgentScheduleBridge({
    service: schedules,
    harness: 'prime',
    skillPath: scheduleSkillPath,
    resolveScope: async ({ cwd, sessionPath }) => {
      const catalog = await projects.list()
      const canonicalCwd = resolve(cwd)
      const project = catalog.find((candidate) => !candidate.inferred && candidate.folders.some((folder) => {
        const root = resolve(folder)
        return canonicalCwd === root || canonicalCwd.startsWith(`${root}${process.platform === 'win32' ? '\\' : '/'}`)
      }))
      if (!project) throw new Error('The agent is not running in an explicitly granted Prime Work project')
      if (!sessionPath) return { projectId: project.id }
      const scheduledSession = (await sessions.list(undefined, true)).find((candidate) => resolve(candidate.filePath) === resolve(sessionPath))
      return { projectId: project.id, sessionId: scheduledSession?.id }
    },
  })
  const piScheduleBridge = new AgentScheduleBridge({
    service: schedules,
    harness: 'pi',
    skillPath: scheduleSkillPath,
    resolveScope: async ({ cwd, sessionPath }) => {
      const catalog = await piProjects.list()
      const canonicalCwd = resolve(cwd)
      const project = catalog.find((candidate) => !candidate.inferred && candidate.folders.some((folder) => {
        const root = resolve(folder)
        return canonicalCwd === root || canonicalCwd.startsWith(`${root}${process.platform === 'win32' ? '\\' : '/'}`)
      }))
      if (!project) throw new Error('The agent is not running in an explicitly granted Pi Work project')
      if (!sessionPath) return { projectId: project.id }
      const scheduledSession = (await piSessions.list(undefined, true)).find((candidate) => resolve(candidate.filePath) === resolve(sessionPath))
      return { projectId: project.id, sessionId: scheduledSession?.id }
    },
  })
  const loomScheduleBridge = new AgentScheduleBridge({
    service: schedules,
    harness: 'loom',
    skillPath: scheduleSkillPath,
    resolveScope: async ({ cwd, sessionPath }) => {
      const catalog = await loomProjects.list()
      const canonicalCwd = resolve(cwd)
      const project = catalog.find((candidate) => !candidate.inferred && candidate.folders.some((folder) => {
        const root = resolve(folder)
        return canonicalCwd === root || canonicalCwd.startsWith(`${root}${process.platform === 'win32' ? '\\' : '/'}`)
      }))
      if (!project) throw new Error('The agent is not running in an explicitly granted Loom Work project')
      if (!sessionPath) return { projectId: project.id }
      const scheduledSession = (await loomSessions.list(undefined, true)).find((candidate) => resolve(candidate.filePath) === resolve(sessionPath))
      return { projectId: project.id, sessionId: scheduledSession?.id }
    },
  })
  const browserService = new AgentBrowserService({
    getGuest: (webContentsId) => {
      const contents = webContents.fromId(webContentsId)
      return contents && !contents.isDestroyed() ? contents : undefined
    },
  })
  agentBrowser = browserService
  const browserBridge = new AgentBrowserBridge({ service: browserService, terminals, extensionPath: primeBrowserExtensionPath, skillPath: browserSkillPath })
  const collaborationBridge = new AgentCollaborationBridge({
    extensionPath: collaborationExtensionPath,
    sessions: { prime: sessions, pi: piSessions, loom: loomSessions },
    agents: { prime: agents, pi: piManager, loom: loomManager },
    catalogs: { prime: providers, pi: piCatalog, loom: loomCatalog },
    disabledProviders: { prime: disabledProviders, pi: piDisabledProviders, loom: disabledProviders },
    disabledModels: { prime: disabledModels, pi: piDisabledModels, loom: disabledModels },
  })
  const secretPromptRenderer = () => {
    const renderer = mainWindow?.webContents
    return renderer && !renderer.isDestroyed() && isTrustedRendererUrl(renderer.getURL(), trustedRendererUrl) && isTrustedRendererUrl(renderer.mainFrame.url, trustedRendererUrl) ? renderer : undefined
  }
  // Team run results return to the conversation that handed the work over.
  const { RunAttentionService } = await import('./enterprise/run-attention')
  const liveNotifications = new Set<Notification>()
  const runAttentionService = new RunAttentionService({
    stateDirectory: join(userDataPath, 'run-attention'),
    listRecentRunIds: () => enterprise.listRecentWorkRunIds(),
    lookupRuns: (runIds) => enterprise.lookupOwnedWorkRuns(runIds),
    listSessions: async () => (await Promise.all(HARNESS_IDS.map((harness) => sessionServices[harness].list(undefined, true)))).flat(),
    sendToRenderer: (channel, target) => {
      const renderer = secretPromptRenderer()
      if (!renderer) return false
      renderer.send(channel, target)
      return true
    },
    isWindowFocused: () => Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused()),
    revealWindow: () => new Promise<void>((done) => {
      if (backgroundMode) { backgroundMode.open(); void ensureWindow().then(() => done(), () => done()) }
      else requestWindow('activation', () => done())
    }),
    showSystemNotification: ({ title, body, onClick }) => {
      if (keepTestWindowsHidden || !Notification.isSupported()) return
      // Held until dismissed so a collected notification cannot lose its click handler.
      const notification = new Notification({ title, body })
      liveNotifications.add(notification)
      const release = () => liveNotifications.delete(notification)
      notification.on('click', () => { release(); onClick() })
      notification.on('close', release)
      notification.show()
    },
  })
  runAttention = runAttentionService
  runAttentionService.setAccount(enterpriseAccountScope)
  const confirmationWindows = new WeakSet<Electron.WebContents>()
  const actionConfirmations = new ActionConfirmations((request) => {
    const renderer = secretPromptRenderer()
    if (!renderer) return false
    if (!confirmationWindows.has(renderer)) {
      confirmationWindows.add(renderer)
      renderer.once('destroyed', () => actionConfirmations.cancelAll())
    }
    renderer.send('enterprise:action-confirmation', request)
    return true
  }, undefined, (id) => secretPromptRenderer()?.send('enterprise:action-confirmation', { id, closed: true }))
  const enterpriseBridge = new AgentEnterpriseBridge({
    service: enterprise,
    sessions: { prime: sessions, pi: piSessions, loom: loomSessions },
    extensionPath: enterpriseExtensionPath,
    storage: {
      directory: join(userDataPath, 'enterprise-handoffs'),
    },
    confirmAction: (request) => actionConfirmations.request(request),
    confirmOperation: (question) => operationPrompts.confirm(question),
  })
  const secretWindows = new WeakSet<Electron.WebContents>()
  const secretPrompts = new SecretPrompts((request) => {
    const renderer = secretPromptRenderer()
    if (!renderer) return false
    if (!secretWindows.has(renderer)) {
      secretWindows.add(renderer)
      renderer.once('destroyed', () => secretPrompts.cancelAll())
    }
    renderer.send('enterprise:secret-prompt', request)
    return true
  }, undefined, (id) => secretPromptRenderer()?.send('enterprise:secret-prompt', { id, closed: true }))
  const operationWindows = new WeakSet<Electron.WebContents>()
  const operationPrompts = new OperationPrompts((request) => {
    const renderer = secretPromptRenderer()
    if (!renderer) return false
    if (!operationWindows.has(renderer)) {
      operationWindows.add(renderer)
      renderer.once('destroyed', () => operationPrompts.cancelAll())
    }
    renderer.send('enterprise:operation-prompt', request)
    return true
  }, undefined, (id) => secretPromptRenderer()?.send('enterprise:operation-prompt', { id, closed: true }))
  const developmentBridge = new TeamDevelopmentAgentBridge({
    requestSecret: (prompt) => secretPrompts.request(prompt),
    confirmOperation: (question) => operationPrompts.confirm(question),
    revealSecrets: (secret) => operationPrompts.reveal(secret),
    // Team packages go only where the person points the dialog.
    saveTeamPackage: async (suggestedName, contents) => {
      const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
      if (!window) return undefined
      const chosen = await dialog.showSaveDialog(window, { title: '导出团队', defaultPath: join(app.getPath('documents'), suggestedName), filters: [{ name: '团队导出文件', extensions: ['json'] }] })
      if (chosen.canceled || !chosen.filePath) return undefined
      await writeFile(chosen.filePath, contents, 'utf8')
      return basename(chosen.filePath)
    },
    openTeamPackage: async () => {
      const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
      if (!window) return undefined
      const chosen = await dialog.showOpenDialog(window, { title: '导入团队', properties: ['openFile'], filters: [{ name: '团队导出文件', extensions: ['json'] }] })
      const path = chosen.canceled ? undefined : chosen.filePaths[0]
      if (!path) return undefined
      if ((await stat(path)).size > 4 * 1024 * 1024) throw new Error('团队导出文件不能超过 4 MiB')
      return { name: basename(path), contents: await readFile(path, 'utf8') }
    },
    accountKey: () => enterprise.accountKey(),
    developer: async () => { const session = await enterprise.getSession(); if (session.status !== 'signed-in' || !session.permissions?.includes('teams:develop') || !session.user?.id) throw new Error('当前账号没有团队开发权限'); return { accountId: session.user.id } },
    teams: async () => (await enterprise.getDevelopmentOverview()).teams.filter((team) => team.status !== 'archived').map((team) => ({ id: team.id, name: team.name, objective: team.objective })),
    team: (teamId, accountId) => enterprise.teamWorkspace({ action: 'get', teamId, accountId }) as Promise<TeamWorkspace>,
    workspace: (command: TeamWorkspaceCommand) => enterprise.teamWorkspace(command),
    catalog: () => enterprise.getBusinessCapabilityCatalog(),
    extensionPath: teamDevelopmentExtensionPath,
    storage: {
      directory: join(userDataPath, 'team-development-proposals'),
    },
  })
  await Promise.all([
    scheduleBridge.start(),
    piScheduleBridge.start(),
    loomScheduleBridge.start(),
    browserBridge.start(),
    collaborationBridge.start(),
    enterpriseBridge.start(),
    developmentBridge.start(),
  ])
  agentScheduleBridges = [scheduleBridge, piScheduleBridge, loomScheduleBridge]
  // Loom receives the same capabilities as Pi Work through a local MCP server
  // that runs the shared extension modules; loaded on demand.
  const { LoomCapabilityHost } = await import('./loom-capabilities')
  const { loomCapabilityExtensions } = await import('./loom-capability-extensions')
  const typebox = await import('typebox').then((module) => (module as { Type?: unknown }).Type).catch(() => undefined)
  const capabilityHost = new LoomCapabilityHost({ directory: join(userDataPath, 'loom-capabilities'), typebox })
  await capabilityHost.start()
  loomCapabilityHost = capabilityHost
  agentBrowserBridge = browserBridge
  agentCollaborationBridge = collaborationBridge
  agentEnterpriseBridge = enterpriseBridge
  teamDevelopmentBridge = developmentBridge
  const revokeRuntimeCapabilities = (environment: NodeJS.ProcessEnv, runtimeScheduleBridge: AgentScheduleBridge): void => {
    const claims: Array<[string, { revoke(token: string | undefined): boolean }, string | undefined]> = [
      ['schedule', runtimeScheduleBridge, environment.PRIME_WORK_SCHEDULE_TOKEN],
      ['browser', browserBridge, environment.PRIME_WORK_BROWSER_TOKEN],
      ['collaboration', collaborationBridge, environment.GOOEYPI_COLLABORATION_TOKEN],
      ['enterprise', enterpriseBridge, environment.GOOEYPI_ENTERPRISE_TOKEN],
      ['team-development', developmentBridge, environment.GOOEYPI_TEAM_DEVELOPMENT_TOKEN],
    ]
    for (const [name, bridge, token] of claims) {
      try { bridge.revoke(token) } catch (error) {
        console.error(`GooeyPi failed to revoke ${name} runtime capability: ${boundedErrorMessage(error)}`)
      }
    }
  }
  agents.setRuntimeEnvironmentProvider((scope) => {
    assertAccountScopeReady()
    return {
      ...profiles.prime.environment,
      ...scheduleBridge.environmentFor(scope),
      ...(stateStore.getSettings().browserEnabled ? browserBridge.environmentFor(scope) : {}),
      ...collaborationBridge.environmentFor({ ...scope, harness: 'prime' }),
      ...enterpriseBridge.environmentFor({ ...scope, harness: 'prime' }),
      PRIME_AGENT_SESSION_DIR: sessionRootForAccount('prime'),
      PRIME_WORK_ASK_USER_EXTENSION_PATH: stateStore.getSettings().askUserEnabled && scope.interactive ? askUserExtensionPath : undefined,
      GOOEYPI_MANAGES_ASK_USER: '1',
      GOOEYPI_CUA_DRIVER_PATH: stateStore.getSettings().computerUseEnabled ? cuaDriver.executable() ?? undefined : undefined,
      GOOEYPI_COMPUTER_USE_SKILL_PATH: stateStore.getSettings().computerUseEnabled && cuaDriver.executable() ? computerUseSkillPath : undefined,
    }
  })
  agents.setRuntimeStartListener((environment, info) => {
    browserBridge.bindSession(environment.PRIME_WORK_BROWSER_TOKEN, info.sessionFile)
    collaborationBridge.bindSession(environment.GOOEYPI_COLLABORATION_TOKEN, info.sessionFile, info.runtimeId)
    enterpriseBridge.bindSession(environment.GOOEYPI_ENTERPRISE_TOKEN, info.sessionFile, info.runtimeId)
  })
  agents.setRuntimeEndListener((environment) => revokeRuntimeCapabilities(environment, scheduleBridge))
  const capabilityExtensionPaths: CapabilityExtensionPaths = {
    schedule: workScheduleExtensionPath,
    browser: workBrowserExtensionPath,
    askUser: askUserExtensionPath,
  }
  // Pi Work receives the shared capability surface through the GooeyPi extensions.
  piManager.setRuntimeEnvironmentProvider((scope) => {
    assertAccountScopeReady()
    return {
      ...profiles.pi.environment,
      ...extensionRuntimeEnvironment(piScheduleBridge.environmentFor(scope), () => browserBridge.environmentFor(scope), capabilityExtensionPaths, stateStore.getSettings().askUserEnabled && scope.interactive, stateStore.getSettings().browserEnabled),
      ...collaborationBridge.environmentFor({ ...scope, harness: 'pi' }),
      ...enterpriseBridge.environmentFor({ ...scope, harness: 'pi' }),
      ...(scope.interactive ? developmentBridge.environmentFor({ ...scope, harness: 'pi' }) : {}),
      PI_CODING_AGENT_SESSION_DIR: sessionRootForAccount('pi'), PI_SESSION_DIR: sessionRootForAccount('pi'),
      GOOEYPI_PI_FAST_MODE_EXTENSION_PATH: piFastModeExtensionPath,
      GOOEYPI_CUA_DRIVER_PATH: stateStore.getSettings().computerUseEnabled ? cuaDriver.executable() ?? undefined : undefined,
      GOOEYPI_COMPUTER_USE_SKILL_PATH: stateStore.getSettings().computerUseEnabled && cuaDriver.executable() ? computerUseSkillPath : undefined,
    }
  })
  piManager.setRuntimeStartListener((environment, info) => {
    developmentBridge.bindRuntime(environment.GOOEYPI_TEAM_DEVELOPMENT_TOKEN, info.runtimeId, info.sessionFile)
    browserBridge.bindSession(environment.PRIME_WORK_BROWSER_TOKEN, info.sessionFile)
    collaborationBridge.bindSession(environment.GOOEYPI_COLLABORATION_TOKEN, info.sessionFile, info.runtimeId)
    enterpriseBridge.bindSession(environment.GOOEYPI_ENTERPRISE_TOKEN, info.sessionFile, info.runtimeId)
  })
  piManager.setRuntimeEndListener((environment) => revokeRuntimeCapabilities(environment, piScheduleBridge))
  // Loom Work runs local tools and skills; the app's capabilities reach it as
  // MCP tools served by the capability host with this runtime's bridge tokens.
  loomManager.setRuntimeEnvironmentProvider((scope) => {
    assertAccountScopeReady()
    const settings = stateStore.getSettings()
    const bridges: NodeJS.ProcessEnv = {
      ...loomScheduleBridge.environmentFor(scope),
      ...(settings.browserEnabled ? browserBridge.environmentFor(scope) : {}),
      ...collaborationBridge.environmentFor({ ...scope, harness: 'loom' }),
      ...enterpriseBridge.environmentFor({ ...scope, harness: 'loom' }),
      ...(scope.interactive ? developmentBridge.environmentFor({ ...scope, harness: 'loom' }) : {}),
    }
    const capabilityConfig = capabilityHost.openRuntime(loomCapabilityExtensions({ askUser: settings.askUserEnabled && scope.interactive }), bridges)
    return {
      ...profiles.loom.environment,
      ...bridges,
      [LOOM_CAPABILITY_MCP_CONFIG]: capabilityConfig,
      LOOM_SESSION_DIR: sessionRootForAccount('loom'),
      GOOEYPI_CUA_DRIVER_PATH: stateStore.getSettings().computerUseEnabled ? cuaDriver.executable() ?? undefined : undefined,
      GOOEYPI_COMPUTER_USE_SKILL_PATH: stateStore.getSettings().computerUseEnabled && cuaDriver.executable() ? computerUseSkillPath : undefined,
    }
  })
  loomManager.setRuntimeStartListener((environment, info) => {
    developmentBridge.bindRuntime(environment.GOOEYPI_TEAM_DEVELOPMENT_TOKEN, info.runtimeId, info.sessionFile)
    browserBridge.bindSession(environment.PRIME_WORK_BROWSER_TOKEN, info.sessionFile)
    collaborationBridge.bindSession(environment.GOOEYPI_COLLABORATION_TOKEN, info.sessionFile, info.runtimeId)
    enterpriseBridge.bindSession(environment.GOOEYPI_ENTERPRISE_TOKEN, info.sessionFile, info.runtimeId)
  })
  loomManager.setRuntimeEndListener((environment) => {
    void capabilityHost.closeRuntime(environment[LOOM_CAPABILITY_MCP_CONFIG])
    revokeRuntimeCapabilities(environment, loomScheduleBridge)
  })
  const runtimeManagers = [agents, piManager, loomManager] as const
  let accountTransitionQueue: Promise<void> = Promise.resolve()
  const setAccountScope = async (nextScope: string | undefined, keepPaused: boolean, mayResume: () => boolean): Promise<void> => {
    const previousScope = enterpriseAccountScope
    const previousRoots = Object.fromEntries(HARNESS_IDS.map((harness) => [harness, sessionServices[harness].sessionRoot])) as Record<HarnessId, string>
    const changedRoots: HarnessId[] = []
    accountScopeChanging = true
    let scheduleGateStarted = false
    let terminalsPaused = false
    let managersResumed = false
    try {
      const drained = await schedules.beginAccountScopeTransition()
      scheduleGateStarted = true
      enterpriseBridge.invalidateAccount()
      developmentBridge.invalidateAccount()
      // A key being asked for belongs to the account that was signed in.
      secretPrompts.cancelAll()
      actionConfirmations.cancelAll()
      operationPrompts.cancelAll()
      if (!drained) {
        await Promise.all(runtimeManagers.map((manager) => manager.pauseStartsAndStop()))
        await terminals!.pauseCreationsAndKillAll()
        terminalsPaused = true
        if (!await schedules.waitForAccountScopeDrain()) {
          throw new Error('计划任务在 30 秒内未停止。账号范围已冻结，请先关闭桌面进程后重试切换。')
        }
      } else {
        await Promise.all(runtimeManagers.map((manager) => manager.pauseStartsAndStop()))
        await terminals!.pauseCreationsAndKillAll()
        terminalsPaused = true
      }
      if (nextScope !== previousScope) {
        for (const harness of HARNESS_IDS) {
          const root = sessionRootForScope(harness, nextScope)
          await mkdir(root, { recursive: true, mode: 0o700 })
          await sessionServices[harness].setSessionRoot(root)
          changedRoots.push(harness)
        }
        for (const service of projectServices) service.setAccountScope(nextScope)
        await Promise.all(HARNESS_IDS.map((harness) => projectServicesByHarness[harness].ensurePersonalWorkspace(personalWorkspaceForAccount(harness, nextScope))))
        enterpriseAccountScope = nextScope
      }
      await Promise.all(runtimeManagers.map((manager) => manager.requestRuntimeEnvironmentRefresh()))
      const resume = !keepPaused && mayResume()
      if (resume) {
        for (const manager of runtimeManagers) manager.resumeStarts()
        managersResumed = true
        terminals!.resumeCreations()
        terminalsPaused = false
        await schedules.completeAccountScopeTransition(nextScope)
        accountScopeChanging = false
      } else {
        accountScopeChanging = true
      }
    } catch (error) {
      let rollbackSucceeded = true
      if (managersResumed) {
        try { await Promise.all(runtimeManagers.map((manager) => manager.pauseStartsAndStop())) }
        catch { rollbackSucceeded = false }
      }
      if (!terminalsPaused) {
        try { await terminals!.pauseCreationsAndKillAll(); terminalsPaused = true }
        catch { rollbackSucceeded = false }
      }
      for (const service of projectServices) service.setAccountScope(previousScope)
      for (const harness of changedRoots.reverse()) {
        try {
          await mkdir(previousRoots[harness], { recursive: true, mode: 0o700 })
          await sessionServices[harness].setSessionRoot(previousRoots[harness])
        } catch { rollbackSucceeded = false }
      }
      enterpriseAccountScope = previousScope
      let previousSessionMatches = false
      try {
        const session = await enterprise.getSession()
        previousSessionMatches = previousScope === undefined
          ? session.status === 'signed-out'
          : session.status === 'signed-in' && enterprise.accountKeyForSession(session) === previousScope
      } catch { previousSessionMatches = false }
      const resume = rollbackSucceeded && !keepPaused && mayResume() && previousSessionMatches
      accountScopeChanging = true
      if (resume) {
        for (const manager of runtimeManagers) manager.resumeStarts()
        terminals!.resumeCreations()
        if (scheduleGateStarted) await schedules.completeAccountScopeTransition(previousScope)
        accountScopeChanging = false
      }
      throw error
    }
  }
  enterprise.setSessionScopeChangeHandler(async (changedSession, generation, phase) => {
    const transition = accountTransitionQueue.then(async () => {
      if (!enterprise.isSessionGenerationCurrent(generation)) return
      const nextScope = changedSession.status === 'signed-in' ? enterprise.accountKeyForSession(changedSession) : undefined
      await setAccountScope(nextScope, phase === 'sign-in-start', () => enterprise.isSessionGenerationCurrent(generation))
      if (!enterprise.isSessionGenerationCurrent(generation)) return
      runAttention?.setAccount(nextScope)
      const renderer = mainWindow?.webContents
      if (renderer && !renderer.isDestroyed()
        && isTrustedRendererUrl(renderer.getURL(), trustedRendererUrl)
        && isTrustedRendererUrl(renderer.mainFrame.url, trustedRendererUrl)) {
        renderer.send('enterprise:session-changed', changedSession)
      }
    })
    accountTransitionQueue = transition.catch(() => undefined)
    await transition
  })
  if (shutdownStarted) return
  const meta: AppMeta = {
    version: app.getVersion(),
    platform: process.platform,
    homeDir: homedir(),
    harnesses: initialHarnesses,
  }
  const updates = new UpdateService(getAutoUpdater(), {
    enabled: app.isPackaged && existsSync(join(process.resourcesPath, 'app-update.yml')),
  })
  updateService = updates
  const refreshHarnesses = async () => {
    const harnesses = await discovery.refresh()
    const currentSettings = await reconcileActiveHarness(stateStore, harnesses)
    meta.harnesses = harnesses
    return { meta: structuredClone(meta), settings: currentSettings }
  }
  const checkTeamDevelopmentInput = async (input: TeamDevelopmentContextInput) => {
    const signedIn = await enterprise.getSession()
    if (signedIn.status !== 'signed-in' || !signedIn.permissions?.includes('teams:develop') || signedIn.user?.id !== input.accountId) throw new Error('当前账号没有团队开发权限')
    const remote = await enterprise.teamWorkspace({ action: 'get', teamId: input.teamId, accountId: input.accountId }) as TeamWorkspace
    if (remote.revision !== input.revision) throw new Error('团队草稿已被其他开发者更新，请刷新后重试')
    return { accountKey: await enterprise.accountKey(), catalog: await enterprise.getBusinessCapabilityCatalog() }
  }
  const updateTeamDevelopment = async (runtimeId: string, input: TeamDevelopmentContextInput): Promise<void> => {
    const { accountKey, catalog } = await checkTeamDevelopmentInput(input)
    const runtime = [...piManager.list(), ...loomManager.list()].find((item) => item.runtimeId === runtimeId)
    if (!runtime) throw new Error('开发会话已结束，请重新打开')
    await developmentBridge.bindContext(runtimeId, { teamId: input.teamId, revision: input.revision, document: input.document, selected: input.selected, catalog }, accountKey)
  }
  trustedRendererUrl = resolveRendererUrl()
  ipc = registerIpc({
    meta, refreshHarnesses, projects, checkouts, sessions, agents, terminals, git, plugins, providers, settings, updates, enterprise, cuaDriver, heartbeats, schedules, browser: browserService, voice, pets,
    popupApplicationMenu, setTitleBarTheme, ...connectionImport,
    enterpriseBridge,
    runAttention: runAttentionService,
    teamDevelopmentBridge: developmentBridge,
    secretPrompts,
    actionConfirmations,
    operationPrompts,
    updateTeamDevelopment, getTeamDevelopmentProposal: (runtimeId: string) => developmentBridge.getProposal(runtimeId), getTeamDevelopmentState: (runtimeId: string) => developmentBridge.getState(runtimeId), getTeamDevelopmentStateForSession: (sessionFile: string) => developmentBridge.getStateForSession(sessionFile),
    pi: { projects: piProjects, sessions: piSessions, agents: piManager, catalog: piCatalog, providers: profiles.piProviders, plugins: piPlugins },
    loom: { projects: loomProjects, sessions: loomSessions, agents: loomManager, catalog: loomCatalog, plugins: loomPlugins },
    applyInterfaceZoom,
  }, trustedRendererUrl)
  // Both managers share the one renderer forwarding path: envelopes carry the
  // runtimeId and RuntimeInfo carries the harness, so the renderer can route.
  const forwardAgentEvent = (envelope: PrimeEventEnvelope): void => {
    const renderer = mainWindow?.webContents
    if (!shutdownStarted && renderer && !renderer.isDestroyed()
      && isTrustedRendererUrl(renderer.getURL(), trustedRendererUrl)
      && isTrustedRendererUrl(renderer.mainFrame.url, trustedRendererUrl)) {
      renderer.send('agent:event', envelope)
    }
  }
  agents.setEventSink(forwardAgentEvent)
  piManager.setEventSink(forwardAgentEvent)
  loomManager.setEventSink(forwardAgentEvent)
  providers.setEventSink((event: ProviderAuthEvent) => {
    const renderer = mainWindow?.webContents
    if (!shutdownStarted && renderer && !renderer.isDestroyed()
      && isTrustedRendererUrl(renderer.getURL(), trustedRendererUrl)
      && isTrustedRendererUrl(renderer.mainFrame.url, trustedRendererUrl)) {
      renderer.send('providers:auth-event', event)
    }
  })
  updates.setEventSink((state: AppUpdateState) => {
    const renderer = mainWindow?.webContents
    if (!shutdownStarted && renderer && !renderer.isDestroyed()
      && isTrustedRendererUrl(renderer.getURL(), trustedRendererUrl)
      && isTrustedRendererUrl(renderer.mainFrame.url, trustedRendererUrl)) {
      renderer.send('updates:changed', state)
    }
  })
  installApplicationMenu({
    appName: 'GooeyPi',
    updatesEnabled: updates.isEnabled(),
    closeWindow: () => {
      const window = mainWindow
      if (!window || window.isDestroyed()) app.quit()
      else window.close()
    },
    checkForUpdates: createManualUpdateCheck(() => updates.check(), async (notification) => {
      await dialog.showMessageBox({
        type: notification.type,
        title: 'GooeyPi',
        message: notification.message,
        detail: notification.detail,
      })
    }),
  })
  backgroundMode.start()
  const window = await ensureWindow()
  if (packagedSmokeMarkerFile) {
    await runPackagedSmoke(window, packagedSmokeMarkerFile)
    return
  }
  updates.start()
}

/**
 * Reports packaged readiness once the trusted renderer has completed an
 * authorized IPC round trip, then quits. The launcher owns the deadline, so
 * nothing here polls or waits on a timer.
 */
async function runPackagedSmoke(window: BrowserWindow | null, markerPath: string): Promise<void> {
  if (!window || window.isDestroyed()) throw new Error('Packaged smoke mode could not open the renderer window')
  if (!ipc) throw new Error('Packaged smoke mode has no registered IPC surface to observe')
  await ipc.whenRendererReady
  const marker = serializePackagedSmokeMarker(packagedSmokeMarker(trustedRendererUrl, app.getVersion()))
  await writeFile(markerPath, marker, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  console.log(`${PACKAGED_SMOKE_READY_EVENT} ${trustedRendererUrl}`)
  shutdownApproved = true
  app.quit()
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()
else void app.whenReady().then(async () => {
  // Parsed from the first instance's own argv only: a second-instance command
  // line must never be able to make a running application write a marker and quit.
  const requestedSmokeMarker = packagedSmokeMarkerPath(process.argv)
  if (requestedSmokeMarker) {
    if (!app.isPackaged) throw new Error('Packaged smoke mode is only available in packaged builds')
    packagedSmokeMarkerFile = requestedSmokeMarker
  }
  registerRendererProtocol()
  let wasOpenedAtLogin = false
  if (process.platform === 'darwin' && app.isPackaged) {
    try { wasOpenedAtLogin = app.getLoginItemSettings().wasOpenedAtLogin } catch { /* The explicit flag remains available if the OS lookup fails. */ }
  }
  startInBackground = shouldStartInBackground(process.argv, wasOpenedAtLogin)
  if (process.platform === 'darwin') {
    app.setActivationPolicy(startInBackground ? 'accessory' : 'regular')
    if (!startInBackground) app.dock?.setIcon(appIconPath())
  }
  const browserSession = session.defaultSession
  browserSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const mediaTypes = permission === 'media' && 'mediaTypes' in details ? details.mediaTypes : undefined
    callback(permission === 'media' && isAllowedRendererAudioPermission(contents.getURL(), contents.mainFrame.url, trustedRendererUrl, mediaTypes))
  })
  browserSession.setPermissionCheckHandler((contents, permission, _origin, details) => Boolean(contents && permission === 'media' && details.isMainFrame
    && isAllowedRendererAudioPermission(contents.getURL(), contents.mainFrame.url, trustedRendererUrl, details.mediaType ? [details.mediaType] : undefined)))
  const browserProfile = session.fromPartition(BROWSER_PARTITION)
  browserProfile.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  browserProfile.setPermissionCheckHandler(() => false)
  if (app.isPackaged) {
    browserSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [RENDERER_CONTENT_SECURITY_POLICY],
        },
      })
    })
  }
  await bootstrap()
  app.on('second-instance', () => {
    if (!shutdownStarted) revealApplication('second instance')
  })
  app.on('activate', () => {
    if (!shutdownStarted && (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible())) revealApplication('activation')
  })
}).catch((error: unknown) => {
  const failureDialog = startupFailureDialog(error)
  if (failureDialog) dialog.showErrorBox(failureDialog.title, failureDialog.detail)
  if (!shutdownStarted) console.error(`GooeyPi failed to start: ${boundedErrorMessage(error)}`)
  app.quit()
})

app.on('window-all-closed', () => {
  routeAllWindowsClosed(shutdownStarted, backgroundMode, () => app.quit())
})

app.on('before-quit', (event) => {
  if (shutdownStarted) return
  if (!shutdownApproved) {
    const prompt = pendingShutdownPrompt()
    if (prompt) {
      event.preventDefault()
      if (!confirmingShutdown) requestShutdown(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() ? mainWindow : null, prompt)
      return
    }
  }
  event.preventDefault()
  shutdownStarted = true

  const registration = ipc
  ipc = null
  registration?.dispose()
  backgroundMode?.dispose()
  updateService?.dispose()
  runAttention?.stop()
  agents?.beginShutdown()
  piAgents?.beginShutdown()
  loomAgents?.beginShutdown()
  beginProcessShutdown()
  beginPluginDiscoveryShutdown()
  downloads?.cancelAll()
  providerService?.cancelAll()
  agentBrowser?.beginShutdown()
  void settleShutdown([
    ...agentScheduleBridges.map((bridge) => bridge.stop()),
    agentBrowserBridge?.stop() ?? Promise.resolve(),
    agentCollaborationBridge?.stop() ?? Promise.resolve(),
    agentEnterpriseBridge?.stop() ?? Promise.resolve(),
    teamDevelopmentBridge?.stop() ?? Promise.resolve(),
    loomCapabilityHost?.stop() ?? Promise.resolve(),
    automation?.stop() ?? Promise.resolve(),
    terminals?.killAll() ?? Promise.resolve(),
    agents?.stopAll() ?? Promise.resolve(),
    piAgents?.stopAll() ?? Promise.resolve(),
    loomAgents?.stopAll() ?? Promise.resolve(),
    stopChildProcesses(),
  ]).then(async () => {
    // Await the drain so the final persist lands before the process exits.
    try { await store?.beginShutdown() } catch (error) { console.error(`GooeyPi store shutdown failed: ${boundedErrorMessage(error)}`) }
  }).finally(() => app.quit())
})
