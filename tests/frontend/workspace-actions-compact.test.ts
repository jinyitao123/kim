import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceActions, type WorkspaceActionsDeps } from '../../src/hooks/useWorkspaceActions'
import type { PrimeModelDescriptor, PrimeWorkApi, ProjectRecord, RuntimeInfo, SessionRecord, TranscriptMessage, WorkspaceMaterialReference } from '../../src/types/api'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}

const project: ProjectRecord = {
  id: 'compact-project',
  harness: 'prime' as const,
  name: 'Compact project',
  path: '/compact-project',
  folders: ['/compact-project'],
  primaryFolder: '/compact-project',
  pinned: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastOpenedAt: '2026-01-01T00:00:00.000Z',
  sessionCount: 1,
}

const session = (status: SessionRecord['status'] = 'idle'): SessionRecord => ({
  id: 'compact-session',
  harness: 'prime',
  filePath: '/compact-project/session.jsonl',
  projectPath: '/compact-project',
  title: 'Compact session',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  status,
  depth: 0,
})

const runtime = (runtimeId = 'idle-runtime', isStreaming = false): RuntimeInfo => ({
  runtimeId,
  harness: 'prime',
  cwd: project.primaryFolder,
  sessionFile: session().filePath,
  isStreaming,
})

interface FixtureOptions {
  runtime?: RuntimeInfo | null
  sessionStatus?: SessionRecord['status']
  ownsStreaming?: boolean
  withSession?: boolean
  provider?: {
    model: string
    effort: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    fast: boolean
    selectedModel?: PrimeModelDescriptor
    resolveModelSelection?: () => Promise<{ model: PrimeModelDescriptor; effort: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'; fast: boolean } | undefined>
  }
}

function fixture({ runtime: configuredRuntime = null, sessionStatus = 'idle', ownsStreaming = false, withSession = true, provider = { model: 'auto', effort: 'medium', fast: false } }: FixtureOptions = {}) {
  let currentRuntime = configuredRuntime
  let messages: TranscriptMessage[] = []
  const currentSession = withSession ? session(sessionStatus) : undefined
  const workspaceRef = {
    current: {
      generation: 1,
      project,
      session: currentSession,
      cwd: project.primaryFolder,
      sessionFile: currentSession?.filePath,
    },
  }
  const runtimeIdRef = { current: ownsStreaming && configuredRuntime ? configuredRuntime.runtimeId : null as string | null }
  const runtimeOwnerRef = {
    current: ownsStreaming && configuredRuntime
      ? { runtimeId: configuredRuntime.runtimeId, generation: 1 }
      : null as { runtimeId: string; generation: number } | null,
  }
  const command = vi.fn(async (_runtimeId: string, _command: Record<string, unknown>, _delivery?: unknown) => ({}))
  const start = vi.fn(async () => ({ ...runtime('started-runtime'), sessionFile: currentSession?.filePath }))
  const followUp = vi.fn(async () => true)
  const listSessions = vi.fn(async () => currentSession ? [currentSession] : [])
  const queuePrompt = vi.fn()
  const invalidateHandoff = vi.fn(async () => {})
  const setToast = vi.fn()
  const reportError = vi.fn()
  const workspace = {
    runtime: currentRuntime,
    workspaceRef,
    runtimeIdRef,
    runtimeOwnerRef,
    prepareForPrompt: () => true,
    attachRuntime: (next: RuntimeInfo | undefined) => { currentRuntime = next ?? null },
    setRuntime: (next: RuntimeInfo | ((current: RuntimeInfo | null) => RuntimeInfo | null)) => {
      currentRuntime = typeof next === 'function' ? next(currentRuntime) : next
    },
    setMessages: (next: TranscriptMessage[] | ((current: TranscriptMessage[]) => TranscriptMessage[])) => {
      messages = typeof next === 'function' ? next(messages) : next
    },
    queuePrompt,
    acceptSteer: vi.fn(),
    removeQueuedPrompt: vi.fn(),
    markQueuedPromptFlushFailed: vi.fn(),
  }
  const agentList = vi.fn(async () => configuredRuntime ? [configuredRuntime] : [])
  const bridge = {
    enterprise: { invalidateHandoff },
    agent: { list: agentList, command, start, stop: vi.fn(async () => false) },
    sessions: { followUp, list: listSessions },
  } as unknown as PrimeWorkApi
  const workspaceSessions = currentSession ? [currentSession] : []
  const actions = createWorkspaceActions(() => ({
    bridge,
    projects: [project],
    sessions: workspaceSessions,
    activeProject: project,
    workspace,
    settingsState: { settings: { activeHarness: 'prime' } },
    provider,
    submissionAdmissionRef: { current: { active: false, run: async (task: () => Promise<void>) => { await task(); return true } } },
    initialized: true,
    layout: {},
    pluginSkills: {},
    gitRequestRef: { current: 0 },
    demoTimerRef: { current: [] },
    setProjects: vi.fn(),
    setSessions: vi.fn(),
    setGitSnapshot: vi.fn(),
    setView: vi.fn(),
    setPaletteOpen: vi.fn(),
    setToast,
    setSubmitting: vi.fn(),
    refreshSchedules: vi.fn(),
    refreshHeartbeats: vi.fn(),
    resetBrowserView: vi.fn(),
    closeTerminalForSession: vi.fn(),
    clearSessionAttention: vi.fn(),
    reportError,
  } as unknown as WorkspaceActionsDeps))

  return { actions, command, start, followUp, listSessions, queuePrompt, invalidateHandoff, setToast, reportError, workspaceRef, messages: () => messages }
}

describe('/compact dispatch', () => {
  it('sends compact to an idle runtime without a prompt command or user message', async () => {
    const fixtureState = fixture({ runtime: runtime() })

    await fixtureState.actions.sendPrompt('/compact')

    expect(fixtureState.command).toHaveBeenCalledOnce()
    expect(fixtureState.command).toHaveBeenCalledWith('idle-runtime', { type: 'compact' })
    expect(fixtureState.command).not.toHaveBeenCalledWith('idle-runtime', expect.objectContaining({ type: 'prompt' }))
    expect(fixtureState.messages().filter((message) => message.role === 'user')).toHaveLength(0)
  })

  it('passes custom instructions to compact', async () => {
    const fixtureState = fixture({ runtime: runtime() })

    await fixtureState.actions.sendPrompt('/compact focus on auth')

    expect(fixtureState.command).toHaveBeenCalledWith('idle-runtime', { type: 'compact', customInstructions: 'focus on auth' })
  })

  it('queues compact for an owned streaming runtime', async () => {
    const fixtureState = fixture({ runtime: runtime('streaming-runtime', true), ownsStreaming: true })

    await fixtureState.actions.sendPrompt('/compact', [], 'steer')

    expect(fixtureState.command).not.toHaveBeenCalled()
    expect(fixtureState.queuePrompt).toHaveBeenCalledWith('/compact', 'queue')
    expect(fixtureState.setToast).toHaveBeenCalledWith('Compaction will run when the current turn finishes.')
  })

  it('does not start a runtime when there is nothing to compact', async () => {
    const fixtureState = fixture({ withSession: false })

    await fixtureState.actions.sendPrompt('/compact')

    expect(fixtureState.start).not.toHaveBeenCalled()
    expect(fixtureState.command).not.toHaveBeenCalled()
    expect(fixtureState.setToast).toHaveBeenCalledWith('Nothing to compact yet.')
  })

  it('does not follow up an externally running session', async () => {
    const fixtureState = fixture({ sessionStatus: 'running' })

    await fixtureState.actions.sendPrompt('/compact')

    expect(fixtureState.followUp).not.toHaveBeenCalled()
    expect(fixtureState.start).not.toHaveBeenCalled()
    expect(fixtureState.setToast).toHaveBeenCalledWith('Compaction is unavailable while this session is running outside GooeyPi.')
  })

  it('rejects image attachments', async () => {
    const fixtureState = fixture({ runtime: runtime() })

    await expect(fixtureState.actions.sendPrompt('/compact', [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }])).rejects.toThrow(/does not accept attachments/)

    expect(fixtureState.reportError).toHaveBeenCalledWith('/compact does not accept attachments. Remove the attachment and try again.')
    expect(fixtureState.command).not.toHaveBeenCalled()
    expect(fixtureState.start).not.toHaveBeenCalled()
  })

  it('queues compact for a non-owned streaming runtime instead of steering it', async () => {
    const fixtureState = fixture({ runtime: runtime('external-streaming-runtime', true) })

    await fixtureState.actions.sendPrompt('/compact', [], 'steer')

    expect(fixtureState.command).not.toHaveBeenCalled()
    expect(fixtureState.followUp).not.toHaveBeenCalled()
    expect(fixtureState.queuePrompt).toHaveBeenCalledWith('/compact', 'queue')
    expect(fixtureState.setToast).toHaveBeenCalledWith('Compaction will run when the current turn finishes.')
  })
})

describe('new runtime model admission', () => {
  const model: PrimeModelDescriptor = {
    key: 'anthropic/claude-fixture', provider: 'anthropic', id: 'claude-fixture', name: 'Claude Fixture', reasoning: true,
    input: ['text'], contextWindow: 200_000, maxTokens: 8_192, availableThinkingLevels: ['low', 'medium', 'high'],
    fastModeSupported: false, available: true,
  }

  it('waits for the current catalog selection before starting a new runtime', async () => {
    const resolveModelSelection = vi.fn(async () => ({ model, effort: 'medium' as const, fast: false }))
    const f = fixture({ provider: { model: '', effort: 'medium', fast: false, resolveModelSelection } })
    f.start.mockResolvedValue({ ...runtime('started-runtime'), sessionFile: session().filePath })

    await f.actions.sendPrompt('Start with the newly detected model')

    expect(resolveModelSelection).toHaveBeenCalledOnce()
    expect(f.start).toHaveBeenCalledWith(expect.objectContaining({ model: 'anthropic/claude-fixture', thinking: 'medium', fast: false, harness: 'prime' }))
    expect(f.command).toHaveBeenCalledWith('started-runtime', expect.objectContaining({ type: 'prompt' }), { employeeInput: { text: 'Start with the newly detected model', materials: [] } })
  })

  it('does not start into another workspace when model resolution finishes late', async () => {
    const pendingSelection = deferred<{ model: PrimeModelDescriptor; effort: 'medium'; fast: false }>()
    const resolveModelSelection = vi.fn(() => pendingSelection.promise)
    const f = fixture({ provider: { model: '', effort: 'medium', fast: false, resolveModelSelection } })
    const sending = f.actions.sendPrompt('Do not deliver after navigating')
    await vi.waitFor(() => expect(resolveModelSelection).toHaveBeenCalledOnce())

    f.workspaceRef.current = {
      ...f.workspaceRef.current,
      generation: 2,
      project: { ...project, harness: 'pi' },
      cwd: '/pi-project',
      sessionFile: '/pi-project/other-session.jsonl',
    }
    pendingSelection.resolve({ model, effort: 'medium', fast: false })
    await sending

    expect(f.start).not.toHaveBeenCalled()
    expect(f.command).not.toHaveBeenCalled()
    expect(f.reportError).not.toHaveBeenCalled()
  })
})


describe('queued employee input invalidates enterprise handoff', () => {
  it('revokes before storing a local queue entry even though no runtime command is sent', async () => {
    const f = fixture({ runtime: runtime('streaming', true), ownsStreaming: true })
    let finish!: () => void
    f.invalidateHandoff.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
    const sending = f.actions.sendPrompt('先别发', [], 'queue')
    expect(f.invalidateHandoff).toHaveBeenCalledWith('streaming')
    expect(f.queuePrompt).not.toHaveBeenCalled()
    finish()
    await sending
    expect(f.queuePrompt).toHaveBeenCalledWith('先别发', 'queue', undefined, undefined, undefined, undefined, undefined, { text: '先别发', materials: [] })
    expect(f.command).not.toHaveBeenCalled()
  })
  it('does not silently queue an employee change when revocation fails', async () => {
    const f = fixture({ runtime: runtime('streaming', true), ownsStreaming: true })
    f.invalidateHandoff.mockRejectedValueOnce(new Error('bridge disconnected'))
    await expect(f.actions.sendPrompt('先别发', [], 'queue')).rejects.toThrow('bridge disconnected')
    expect(f.queuePrompt).not.toHaveBeenCalled()
  })
})

describe('workspace text attachment prompt binding', () => {
  const attachment: WorkspaceMaterialReference = {
    projectId: project.id,
    harness: 'prime',
    workspacePath: project.primaryFolder,
    name: 'source.md',
    path: '材料/附件/opaque/source.md',
    sha256: 'a'.repeat(64),
    bytes: 14,
    mimeType: 'text/markdown',
  }

  it('sends the exact attachment reference block that is stored in the Pi user turn', async () => {
    const f = fixture({ runtime: runtime() })

    await f.actions.sendPrompt('请阅读这个文件', [], 'queue', undefined, undefined, [attachment])

    const command = f.command.mock.calls[0]?.[1] as { type?: string; message?: string }
    const userMessage = f.messages().find((message) => message.role === 'user')
    expect(command.type).toBe('prompt')
    expect(command.message).toContain('材料/附件/opaque/source.md')
    expect(command.message).toContain(attachment.sha256)
    expect(userMessage?.parts.find((part) => part.type === 'text')?.text).toBe(command.message)
    expect(f.command.mock.calls[0]?.[2]).toEqual({ employeeInput: { text: '请阅读这个文件', materials: [attachment] } })
  })

  it('retains captured employee text and selected files through an idle queue flush without decorating twice', async () => {
    const active = runtime('queued-runtime', true)
    const f = fixture({ runtime: active, ownsStreaming: true })
    const raw = '请递交本轮附件'
    await f.actions.sendPrompt(raw, [], 'queue', undefined, undefined, [attachment])
    const queued = f.queuePrompt.mock.calls[0]!
    const full = queued[0] as string, input = queued[7] as import('../../src/types/api').EmployeePromptInput
    expect(input).toEqual({ text: raw, materials: [attachment] })
    active.isStreaming = false
    await f.actions.sendPrompt(full, [], 'queue', 'queued-input', undefined, [], undefined, undefined, input)
    expect(f.command.mock.calls[0]?.[1].message).toBe(full)
    expect(f.command.mock.calls[0]?.[2]).toEqual({ employeeInput: input })
    expect(full.match(/gooeypi-workspace-materials:v1/g)).toHaveLength(1)
  })

  it('rejects a file reference after the active project changes', async () => {
    const f = fixture({ runtime: runtime() })
    f.workspaceRef.current.project = { ...project, id: 'another-project' }

    await expect(f.actions.sendPrompt('请阅读这个文件', [], 'queue', undefined, undefined, [attachment])).rejects.toThrow(/different workspace/)

    expect(f.command).not.toHaveBeenCalled()
    expect(f.messages().some((message) => message.role === 'user')).toBe(false)
  })
})

describe('plain employee input capture through the actual workspace delivery chain', () => {
  const text = '生效日期2026年10月9日，到期2027年10月8日。按刚才名称转成合同草稿，先不提交审批。'
  it.each(['send', 'queue', 'steer'] as const)('preserves original text and empty materials for %s through Host capture', async (mode) => {
    const active = runtime('plain-input-runtime', mode !== 'send')
    const f = fixture({ runtime: active, ownsStreaming: mode !== 'send' })
    await f.actions.sendPrompt(text, [], mode === 'steer' ? 'steer' : 'queue')
    if (mode === 'queue') {
      const queued = f.queuePrompt.mock.calls[0]!
      const input = queued[7] as import('../../src/types/api').EmployeePromptInput
      expect(input).toEqual({ text, materials: [] })
      expect(f.command).not.toHaveBeenCalled()
      active.isStreaming = false
      await f.actions.sendPrompt(queued[0] as string, [], 'queue', 'plain-queued', undefined, [], undefined, undefined, input)
    }
    const call = f.command.mock.calls.find(([, command]) => command.type === (mode === 'steer' ? 'steer' : 'prompt'))!
    expect(call).toBeDefined()
    const delivery = call[2] as { employeeInput: import('../../src/types/api').EmployeePromptInput }
    expect(delivery.employeeInput).toEqual({ text, materials: [] })
    const { captureEmployeeInput } = await import('../../electron/main/enterprise/employee-input')
    const captured = captureEmployeeInput(String(call[1].message), delivery.employeeInput, { harness: 'prime', cwd: project.primaryFolder } as Parameters<typeof captureEmployeeInput>[2])
    expect(captured).toEqual({ text, materials: [] })
  })
  it.each(['approval', 'business', 'returned'] as const)('does not mark generated %s opening text as employee input, including queue flush', async kind => {
    const active = runtime('generated-opening', true), f = fixture({ runtime: active, ownsStreaming: true })
    const approval = kind === 'approval' ? 'review-handle' : undefined
    const business = kind === 'business' ? 'business-handle' : undefined
    const returned = kind === 'returned' ? 'returned-handle' : undefined
    await f.actions.sendPrompt('系统生成只读打开上下文', [], 'queue', undefined, returned, [], business, approval)
    const queued = f.queuePrompt.mock.calls[0]!
    expect(queued.slice(4, 7)).toEqual([returned, business, approval]);expect(queued[7]).toBeUndefined()
    active.isStreaming = false
    await f.actions.sendPrompt(queued[0] as string, [], 'queue', 'opening-queued', returned, [], business, approval)
    const call = f.command.mock.calls.find(([, command]) => command.type === 'prompt')!
    expect(call).toBeDefined();expect(call[2]).not.toHaveProperty('employeeInput')
    expect(call[2]).toMatchObject(kind === 'approval' ? { approvalReviewContextHandle: approval } : kind === 'business' ? { workContinuationContextHandle: business } : { returnedApprovalContextHandle: returned })
  })
})
