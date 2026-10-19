import { ArrowUp, AtSign, ChevronDown, Clock3, Command, Edit3, Gauge, ImageIcon, LoaderCircle, MessageCirclePlus, Mic, Paperclip, Plus, Square, SquareTerminal, Trash2, X, Zap } from 'lucide-react'
import { memo, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type {
  BrowserAnnotation,
  CheckoutAction,
  CheckoutCatalog,
  HarnessId,
  MessageEnterAction,
  PrimeContextUsage,
  PrimeModelDescriptor,
  PrimeProviderDescriptor,
  PrimeThinkingLevel,
  SessionUsage,
  PrimeWorkApi,
  PromptDeliveryIntent,
  PromptImage,
  QueuedPrompt,
  SessionRecord,
  SkillRecord,
  TerminalPromptContext,
  TerminalSelectionContext,
  VoiceTranscriptionProvider,
  WorkspaceMaterialReference,
} from '@/types/api'
import { appendAnnotationsToPrompt } from '@/lib/browser-annotations'
import { appendCapabilityRouting } from '@/lib/capability-mentions'
import { appendTerminalContextToPrompt } from '@/lib/terminal-context'
import { appendSessionRouting, findSessionMentions } from '@/lib/session-mentions'
import { clearComposerDraft, readComposerDraft, saveComposerDraft, takeComposerDraft } from '@/lib/composer-draft'
import { contextDialLabel } from '@/lib/format-cost'
import { messageActionForKey } from '@/lib/message-shortcuts'
import { useComposerImages, type ComposerTextFile } from '@/hooks/useComposerImages'
import { useDictation } from '@/hooks/useDictation'
import { IconButton, SelectControl } from './ui'
import { ExecutingModelChip, type ExecutingModelChipProps } from './ExecutingModelChip'
import { ModelPicker } from './ModelPicker'
import { CheckoutPicker } from './CheckoutPicker'

interface ComposerProps {
  busy: boolean
  submitting?: boolean
  loading?: boolean
  disabled?: boolean
  model: string
  effort: PrimeThinkingLevel
  modelsByProvider: ReadonlyMap<string, PrimeModelDescriptor[]>
  providers: PrimeProviderDescriptor[]
  reasoningLevels: PrimeThinkingLevel[]
  fast: boolean
  fastSupported: boolean
  fastAvailable: boolean
  /** Active harness agent name for tooltips. */
  agentName?: string
  /** Active harness short name for inline copy. */
  shortName?: string
  harness?: HarnessId
  workspaceProjectId?: string
  personalWorkspace?: boolean
  imageInputSupported: boolean
  /** Primary action for Enter; Ctrl/Cmd+Enter selects the opposite action. */
  messageEnterAction?: MessageEnterAction
  contextUsage?: PrimeContextUsage
  executingModel?: ExecutingModelChipProps['executingModel']
  sessionUsage?: SessionUsage
  voice?: PrimeWorkApi['voice'] | null
  transcriptionProvider?: VoiceTranscriptionProvider
  skills: SkillRecord[]
  /** Other sidebar sessions in the active project, available as @title references. */
  sessions?: SessionRecord[]
  /** Browser annotations auto-attach as a composer attachment while any exist. */
  annotations?: BrowserAnnotation[]
  /** The active terminal is visible as context; selected text expands this attachment. */
  terminalSelection?: TerminalSelectionContext
  /** Reads the active xterm buffer only at submit time, avoiding output-driven renderer updates. */
  getTerminalContext?(): TerminalPromptContext | undefined
  /** Messages waiting for a turn boundary. */
  queuedMessages?: QueuedPrompt[]
  onDeleteQueuedMessage?(message: QueuedPrompt): void
  onEditQueuedMessage?(message: QueuedPrompt): void
  /** Each bump submits the current draft immediately (Ctrl/Cmd+Enter from the annotation popover). */
  sendSignal?: number
  onModelChange(value: string): void
  onEffortChange(value: PrimeThinkingLevel): void
  onFastChange(value: boolean): void
  checkoutCatalog?: CheckoutCatalog
  /** Branch/worktree name shown before or without the linked-worktree catalog. */
  checkoutLabel?: string
  checkoutsLoading?: boolean
  onExecuteCheckout?(action: CheckoutAction): Promise<void> | void
  onSend(prompt: string, images: PromptImage[], intent: PromptDeliveryIntent, textAttachments: WorkspaceMaterialReference[]): Promise<void> | void
  onImportTextFile?(name: string, bytes: Uint8Array): Promise<WorkspaceMaterialReference>
  onStop(): Promise<void> | void
  onRemoveAnnotation?(id: string): void
  /** Called after a send that included the annotations, and by the attachment's remove control. */
  onClearAnnotations?(): void
  onClearTerminalSelection?(): void
  /** Stable per-workspace key; without it the composer keeps no draft of its own. */
  draftKey?: string
}

const commands = [
  { command: '/review', detail: '检查当前改动' },
  { command: '/plan', detail: '制定实施计划' },
  { command: '/compact', detail: '压缩对话上下文' },
  { command: '/status', detail: '查看运行状态' },
]

const primeCommands = [
  ...commands,
  { command: '/mcp', detail: '查看 MCP 集成和本地服务' },
]

const reasoningLabels: Record<PrimeThinkingLevel, string> = {
  off: '关闭',
  minimal: '最少',
  low: '低',
  medium: '标准',
  high: '高',
  xhigh: '很高',
  max: '最高',
}

const MAX_IMAGE_PROMPT_BYTES = 2 * 1024 * 1024

const EMPTY_ANNOTATIONS: BrowserAnnotation[] = []
const noop = () => undefined

export const Composer = memo(function Composer({
  busy,
  submitting = false,
  loading = false,
  disabled,
  model,
  effort,
  modelsByProvider,
  providers,
  reasoningLevels,
  fast,
  fastSupported,
  fastAvailable,
  agentName = 'Prime Agent',
  shortName = 'Prime',
  harness = 'prime',
  workspaceProjectId,
  personalWorkspace = false,
  imageInputSupported,
  messageEnterAction = 'queue',
  contextUsage,
  executingModel,
  sessionUsage,
  voice,
  transcriptionProvider = 'openai-live',
  skills,
  sessions = [],
  annotations = EMPTY_ANNOTATIONS,
  terminalSelection,
  getTerminalContext,
  queuedMessages = [],
  onDeleteQueuedMessage,
  onEditQueuedMessage,
  sendSignal = 0,
  onModelChange,
  onEffortChange,
  onFastChange,
  checkoutCatalog,
  checkoutLabel,
  checkoutsLoading = false,
  onExecuteCheckout,
  onSend,
  onImportTextFile,
  onStop,
  onRemoveAnnotation = noop,
  onClearAnnotations = noop,
  onClearTerminalSelection = noop,
  draftKey,
}: ComposerProps) {
  const [value, setValue] = useState(() => (draftKey ? readComposerDraft(draftKey)?.text : undefined) ?? takeComposerDraft())
  const [menu, setMenu] = useState<'add' | 'mention' | 'command' | null>(null)
  const [sessionReferenceIds, setSessionReferenceIds] = useState<ReadonlyMap<string, string>>(() => new Map())
  const [activeSuggestion, setActiveSuggestion] = useState(0)
  const [annotationsOpen, setAnnotationsOpen] = useState(false)
  const [terminalSelectionOpen, setTerminalSelectionOpen] = useState(false)
  const imageAttachments = useComposerImages({ shortName, projectId: workspaceProjectId, harness, importTextFile: onImportTextFile })
  const { images, imagesRef, textFiles, textFilesRef, unsupportedFiles, unsupportedFilesRef, error: attachmentError, setError: setAttachmentError, processing: processingImages } = imageAttachments
  const pendingSubmissionAttachmentsRef = useRef<WorkspaceMaterialReference[]>([])
  const dictation = useDictation(voice, transcriptionProvider, setAttachmentError)
  const menuId = useId()
  const menuRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const acceptedMentionRef = useRef<{ start: number; text: string } | null>(null)
  const submittingRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const imageStatusId = useId()
  const annotationsRef = useRef(annotations)
  annotationsRef.current = annotations
  const mountedRef = useRef(true)
  const restoredDraftRef = useRef(false)
  const enabledSkills = useMemo(() => skills.filter((skill) => skill.enabled), [skills])

  useEffect(() => {
    if (!draftKey || restoredDraftRef.current) return
    restoredDraftRef.current = true
    const draft = readComposerDraft(draftKey)
    if (!draft) return
    const attachments = (draft.attachments ?? []).filter((attachment) => attachment.projectId === workspaceProjectId && attachment.harness === harness)
    if (attachments.length > 0) {
      const restored = imageAttachments.restoreTextFilesWithinLimits(attachments.map((reference): ComposerTextFile => ({
        id: `${reference.path}:${reference.sha256}`,
        reference,
        size: reference.bytes,
      })))
      if (restored.omitted > 0) setAttachmentError('附件数量已到上限，部分草稿附件没有恢复。')
    }
    if (draft.model && draft.model !== model) onModelChange(draft.model)
    if (draft.effort && draft.effort !== effort) onEffortChange(draft.effort as PrimeThinkingLevel)
    if (draft.fast !== undefined && draft.fast !== fast) onFastChange(draft.fast)
  }, [draftKey, effort, fast, harness, imageAttachments.restoreTextFilesWithinLimits, model, onEffortChange, onFastChange, onModelChange, setAttachmentError, workspaceProjectId])

  useEffect(() => {
    if (draftKey) saveComposerDraft(draftKey, { text: value, model, effort, fast, attachments: textFiles.length ? textFiles.map((file) => file.reference) : pendingSubmissionAttachmentsRef.current })
  }, [draftKey, effort, fast, model, textFiles, value])

  useEffect(() => {
    const mentionMatch = /(?:^|\s)@([^@\n]*)$/.exec(value)
    const mentionStart = mentionMatch ? value.length - mentionMatch[1].length - 1 : -1
    const acceptedMention = acceptedMentionRef.current
    const suppressAcceptedMention = Boolean(
      mentionMatch
      && acceptedMention
      && mentionStart === acceptedMention.start
      && value.slice(acceptedMention.start, acceptedMention.start + acceptedMention.text.length) === acceptedMention.text,
    )
    if (acceptedMention && !suppressAcceptedMention) acceptedMentionRef.current = null
    setMenu(value.startsWith('/') && !value.includes(' ') ? 'command' : mentionMatch && !suppressAcceptedMention ? 'mention' : null)
  }, [value])
  useEffect(() => {
    setSessionReferenceIds((current) => {
      if (!current.size) return current
      const mentionedTitles = new Set(findSessionMentions(value, sessions, current).map(({ session }) => session.title.trim().toLocaleLowerCase()))
      const next = new Map([...current].filter(([title]) => mentionedTitles.has(title)))
      return next.size === current.size ? current : next
    })
  }, [sessions, value])
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  useEffect(() => {
    if (annotations.length === 0) setAnnotationsOpen(false)
  }, [annotations.length])
  useEffect(() => {
    if (!terminalSelection?.text) setTerminalSelectionOpen(false)
  }, [terminalSelection?.text])

  useEffect(() => {
    if (!menu) return
    const close = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Node) || menuRef.current?.contains(target)) return
      if (target instanceof Element && target.closest('[data-composer-menu-trigger]')) return
      setMenu(null)
    }
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(null)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onEscape)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onEscape)
    }
  }, [menu])


  // Ctrl/Cmd+Enter in the annotation popover bumps sendSignal to submit the
  // draft (with the just-saved annotation) without switching focus here.
  const lastSendSignalRef = useRef(sendSignal)
  useEffect(() => {
    if (sendSignal === lastSendSignalRef.current) return
    lastSendSignalRef.current = sendSignal
    void submit()
  }, [sendSignal])

  const submit = async (intent: PromptDeliveryIntent = 'queue', valueOverride?: string) => {
    const currentImages = imagesRef.current
    const currentTextFiles = textFilesRef.current
    const currentUnsupportedFiles = unsupportedFilesRef.current
    const currentAnnotations = annotationsRef.current
    const currentTerminalContext = terminalSelection?.text ? getTerminalContext?.() : undefined
    const hasTerminalSelection = Boolean(currentTerminalContext?.text)
    const draftValue = valueOverride ?? value
    const prompt = draftValue.trim() || (currentImages.length > 0
      ? (currentImages.length === 1 ? '[Attached image]' : '[Attached images]')
      : currentTextFiles.length > 0 || currentUnsupportedFiles.length > 0 ? (currentTextFiles.length + currentUnsupportedFiles.length === 1 ? '[Attached file]' : '[Attached files]')
        : currentAnnotations.length > 0 ? '[Page annotations]' : '[Terminal selection]')
    if ((!draftValue.trim() && currentImages.length === 0 && currentTextFiles.length === 0 && currentUnsupportedFiles.length === 0 && currentAnnotations.length === 0 && !hasTerminalSelection) || loading || disabled || (intent !== 'steer' && !busy && (submitting || submittingRef.current))) return
    if (imageAttachments.hasPending()) {
      setAttachmentError('请等文件处理完再发送。')
      return
    }
    if (currentUnsupportedFiles.length > 0) {
      const first = currentUnsupportedFiles[0]
      const remainder = currentUnsupportedFiles.length - 1
      setAttachmentError(`${first.name}${remainder ? ` and ${remainder} more file${remainder === 1 ? '' : 's'}` : ''} cannot be sent to this model or agent. Remove ${remainder ? 'them' : 'it'} before sending.`)
      return
    }
    if (currentImages.length > 0 && !imageInputSupported) {
      setAttachmentError('当前模型不支持图片，请移除图片或换一个支持图片的模型。')
      return
    }
    const submittedImages = currentImages.map(({ type, data, mimeType }) => ({ type, data, mimeType }))
    const submittedTextFiles = currentTextFiles.map((file) => file.reference)
    // Recognized @ mentions carry explicit routing semantics; annotations then
    // ride along inside the prompt as their own delimited plain-text block.
    const referencedSessions = findSessionMentions(prompt, sessions, sessionReferenceIds)
    const sessionTitles = new Set(referencedSessions.map(({ session }) => session.title.trim().toLocaleLowerCase()))
    const promptWithSessions = appendSessionRouting(prompt, sessions, sessionReferenceIds)
    // If a session and capability share a display name, the session chosen
    // from the combined menu wins instead of silently routing both.
    const promptWithCapabilities = appendCapabilityRouting(promptWithSessions, enabledSkills.filter((skill) => !sessionTitles.has(skill.name.trim().toLocaleLowerCase())))
    const promptWithAnnotations = appendAnnotationsToPrompt(promptWithCapabilities, currentAnnotations)
    const promptWithContext = appendTerminalContextToPrompt(promptWithAnnotations, currentTerminalContext)
    const frame = `${JSON.stringify({ type: intent === 'steer' ? 'steer' : 'follow_up', message: promptWithContext, ...(submittedImages.length ? { images: submittedImages } : {}), id: '00000000-0000-0000-0000-000000000000' })}\n`
    if (new TextEncoder().encode(frame).byteLength > MAX_IMAGE_PROMPT_BYTES) {
      setAttachmentError('消息和附件太大，请缩短内容或移除附件。')
      return
    }
    submittingRef.current = true
    const submittedValue = draftValue
    const submittedComposerImages = currentImages
    const submittedComposerTextFiles = currentTextFiles
    pendingSubmissionAttachmentsRef.current = submittedTextFiles
    setValue('')
    imageAttachments.clear()
    setAttachmentError('')
    setMenu(null)
    try {
      await onSend(promptWithContext, submittedImages, intent, submittedTextFiles)
      pendingSubmissionAttachmentsRef.current = []
      if (draftKey) clearComposerDraft(draftKey)
      // The annotations were delivered: clear the attachment and page markers.
      if (currentAnnotations.length > 0) onClearAnnotations()
    } catch (error) {
      if (mountedRef.current) {
        setValue((current) => current || submittedValue)
        const restoration = imageAttachments.restoreWithinLimits(submittedComposerImages)
        const fileRestoration = imageAttachments.restoreTextFilesWithinLimits(submittedComposerTextFiles)
        pendingSubmissionAttachmentsRef.current = []
        if (restoration.omitted + fileRestoration.omitted > 0) {
          const restoredImages = restoration.restored > 0 ? `、${restoration.restored} 张图片` : ''
          const restoredFiles = fileRestoration.restored > 0 ? `、${fileRestoration.restored} 个文本文件` : ''
          setAttachmentError(`消息没有发出。已恢复草稿${restoredImages}${restoredFiles}，但附件数量已到上限，有 ${restoration.omitted + fileRestoration.omitted} 个附件没有恢复。`)
        } else if (submittedComposerImages.length > 0 || submittedComposerTextFiles.length > 0) {
          const cause = error instanceof Error ? error.message : ''
          setAttachmentError(cause ? `${cause} Your draft and attachments were restored.` : '消息没有发出，草稿和附件已恢复。')
        } else {
          const cause = error instanceof Error ? error.message : ''
          setAttachmentError(cause ? `${cause} Your draft was restored.` : '消息没有发出，草稿已恢复。')
        }
      }
    } finally {
      submittingRef.current = false
      if (mountedRef.current) textareaRef.current?.focus()
    }
  }

  const finishDictation = async (send: boolean) => {
    const transcript = await dictation.finish()
    if (!transcript) return
    const next = value.trimEnd() ? `${value.trimEnd()} ${transcript}` : transcript
    setValue(next)
    if (send) await submit('queue', next)
    else requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const insertAtCaret = (textarea: HTMLTextAreaElement, text: string) => {
    const start = textarea.selectionStart ?? textarea.value.length
    const end = textarea.selectionEnd ?? textarea.value.length
    textarea.setRangeText(text, start, end, 'end')
    setValue(textarea.value)
  }
  const insert = (text: string) => {
    const textarea = textareaRef.current
    if (textarea) insertAtCaret(textarea, text)
    else setValue((current) => `${current}${text}`)
    setMenu(null)
    textarea?.focus()
  }
  const insertMention = (label: string, session?: SessionRecord) => {
    const textarea = textareaRef.current
    const match = /(?:^|\s)@([^@\n]*)$/.exec(value)
    if (!match) { insert(`@${label} `); return }
    const query = match[1]
    const start = value.length - query.length
    const mentionStart = start - 1
    const acceptedText = `@${label} `
    if (textarea) {
      textarea.setRangeText(`${label} `, start, value.length, 'end')
      acceptedMentionRef.current = { start: mentionStart, text: acceptedText }
      setValue(textarea.value)
    } else {
      acceptedMentionRef.current = { start: mentionStart, text: acceptedText }
      setValue(`${value.slice(0, start)}${label} `)
    }
    if (session) {
      const key = session.title.trim().toLocaleLowerCase()
      setSessionReferenceIds((current) => new Map(current).set(key, session.id))
    }
    setMenu(null)
    textarea?.focus()
  }

  const mentionQuery = /(?:^|\s)@([^@\n]*)$/.exec(value)?.[1]?.toLocaleLowerCase().trim() ?? ''

  const suggestions =
    menu === 'command'
      ? (harness === 'prime' ? primeCommands : commands)
          .filter((item) => item.command.startsWith(value))
          .map((item) => ({
            key: item.command,
            label: item.command,
            detail: item.detail,
            icon: <Command size={14} />,
            choose: () => {
              setValue(`${item.command} `)
              setMenu(null)
              textareaRef.current?.focus()
            },
          }))
      : menu === 'mention'
        ? [
            ...sessions.filter((session) => session.title.toLocaleLowerCase().includes(mentionQuery)).slice(0, 6).map((session) => ({
              key: `session:${session.harness}:${session.id}`,
              label: `@${session.title}`,
              detail: `${session.harness.toUpperCase()} session · ${session.status}`,
              icon: <MessageCirclePlus size={14} />,
              choose: () => insertMention(session.title, session),
            })),
            ...enabledSkills.filter((skill) => skill.name.toLocaleLowerCase().includes(mentionQuery)).slice(0, 6).map((skill) => ({
              key: `skill:${skill.id}`,
              label: `@${skill.name}`,
              detail: skill.description,
              icon: <AtSign size={14} />,
              choose: () => insertMention(skill.name),
            })),
          ].slice(0, 8)
        : menu === 'add'
          ? [
              { key: 'files', label: '添加文件', detail: '添加图片、音视频或其他文件', icon: <Paperclip size={14} />, choose: () => { setMenu(null); fileInputRef.current?.click() } },
              { key: 'mention', label: '提及对话或技能', detail: '引用侧栏中的工作或已启用的能力', icon: <AtSign size={14} />, choose: () => insert('@') },
            ]
          : []

  useEffect(() => {
    setActiveSuggestion(0)
  }, [menu, value, suggestions.length])
  const chooseSuggestion = (index: number) => suggestions[index]?.choose()
  const contextPercent = contextUsage?.percent === null || contextUsage?.percent === undefined ? null : Math.min(100, Math.max(0, contextUsage.percent))
  const contextLabel = contextDialLabel(contextUsage, sessionUsage)
  const contextDisplayPercent = contextPercent === null ? null : Math.min(99, Math.round(contextPercent))
  const contextStyle = { '--context-percent': `${contextPercent ?? 0}%` } as CSSProperties
  const sendQueuedMessageImmediately = async (queued: QueuedPrompt) => {
    onDeleteQueuedMessage?.(queued)
    try {
      await onSend(queued.text, [], 'steer', [])
    } catch {
      // sendPrompt reports failures itself; there is no composer draft to restore.
    }
  }

  return (
    <div className="composer-wrap">
      {queuedMessages.length ? (
        <section className="composer-queue" aria-label="待发送的消息" aria-live="polite">
          <div className="composer-queue__header">
            <span><Clock3 size={13} />待发送的消息</span>
            <strong>{queuedMessages.length}</strong>
          </div>
          <div className="composer-queue__list">
            {queuedMessages.map((queued) => (
              <div className="composer-queue__item" key={queued.id}>
                <span className="composer-queue__text">{queued.text}</span>
                <span className="composer-queue__actions">
                  <button type="button" className="composer-queue__action" aria-label={`立即发送：${queued.text}`} title="立即发送" onClick={() => { void sendQueuedMessageImmediately(queued) }}><ArrowUp size={13} /></button>
                  <button type="button" className="composer-queue__action" aria-label={`编辑：${queued.text}`} title="编辑" onClick={() => { onEditQueuedMessage?.(queued); setValue(queued.text); requestAnimationFrame(() => textareaRef.current?.focus()) }}><Edit3 size={13} /></button>
                  <button type="button" className="composer-queue__action composer-queue__action--delete" aria-label={`删除：${queued.text}`} title="删除" onClick={() => onDeleteQueuedMessage?.(queued)}><Trash2 size={13} /></button>
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      <div
        className={`composer ${busy || submitting ? 'composer--busy' : ''} ${imageAttachments.dragging ? 'composer--image-dragging' : ''}`}
        {...imageAttachments.dragHandlers}
      >
        {imageAttachments.dragging ? <div className="composer-drop-feedback" aria-hidden="true"><Paperclip size={18} />松开以添加文件</div> : null}
        <div className="composer-input">
          <textarea
            ref={textareaRef}
            value={value}
            disabled={disabled || loading}
            rows={2}
            placeholder={disabled ? '正在准备工作空间…' : loading ? '正在加载…' : submitting ? '正在开始…' : personalWorkspace ? '说说你想完成什么，也可以添加文件' : `有什么要做的？@ 提及对话和技能，/ 使用命令`}
            aria-label={personalWorkspace ? '给工作助手发消息' : `给 ${shortName} 发消息`}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={Boolean(menu && suggestions.length)}
            aria-controls={menu ? menuId : undefined}
            aria-activedescendant={menu && suggestions.length ? `${menuId}-option-${activeSuggestion}` : undefined}
            onChange={(event) => setValue(event.target.value)}
            onPaste={(event) => {
              const files = [...event.clipboardData.items]
                .filter((item) => item.kind === 'file')
                .flatMap((item) => {
                  const file = item.getAsFile()
                  return file ? [file] : []
                })
              if (!files.length) return
              const pastedText = event.clipboardData.getData('text/plain')
              event.preventDefault()
              if (pastedText) insertAtCaret(event.currentTarget, pastedText)
              void imageAttachments.ingest(files)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Backspace') acceptedMentionRef.current = null
              if (menu && suggestions.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                event.preventDefault()
                setActiveSuggestion((current) => (event.key === 'ArrowDown' ? (current + 1) % suggestions.length : (current - 1 + suggestions.length) % suggestions.length))
                return
              }
              if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && !event.nativeEvent.isComposing && menu && suggestions.length) {
                event.preventDefault()
                chooseSuggestion(activeSuggestion)
                return
              }
              const intent = messageActionForKey(
                {
                  key: event.key,
                  ctrlKey: event.ctrlKey,
                  metaKey: event.metaKey,
                  altKey: event.altKey,
                  shiftKey: event.shiftKey,
                  isComposing: event.nativeEvent.isComposing,
                },
                messageEnterAction,
              )
              if (intent) {
                event.preventDefault()
                void submit(intent)
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                setMenu(null)
              }
            }}
          />
        </div>
        {menu && suggestions.length ? (
          <div ref={menuRef} id={menuId} className="composer-menu" role="listbox" aria-label={menu === 'command' ? '命令' : menu === 'mention' ? '对话和技能' : '添加上下文'}>
            {suggestions.map((suggestion, index) => (
              <button
                id={`${menuId}-option-${index}`}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={activeSuggestion === index}
                className={activeSuggestion === index ? 'is-active' : ''}
                key={suggestion.key}
                onMouseEnter={() => setActiveSuggestion(index)}
                onClick={suggestion.choose}
              >
                {suggestion.icon}
                <span>
                  <strong>{suggestion.label}</strong>
                  <small>{suggestion.detail}</small>
                </span>
              </button>
            ))}
          </div>
        ) : null}
        {annotationsOpen && annotations.length ? (
          <div className="composer-annotations" role="region" aria-label="网页标注详情">
            {annotations.map((annotation, index) => {
              return (
                <div className="composer-annotation" key={annotation.id}>
                  <span className="composer-annotation__badge" aria-hidden="true">
                    {index + 1}
                  </span>
                  <div className="composer-annotation__body">
                    <p>{annotation.comment}</p>
                    {annotation.stale ? <small>page changed since capture</small> : null}
                  </div>
                  <button type="button" aria-label={`移除标注 ${index + 1}`} onClick={() => onRemoveAnnotation(annotation.id)}>
                    <X size={12} />
                  </button>
                </div>
              )
            })}
          </div>
        ) : null}
        {terminalSelectionOpen && terminalSelection?.text ? (
          <div className="composer-terminal-selection" role="region" aria-label="选中的终端文本">
            <div>
              <SquareTerminal size={14} aria-hidden="true" />
              <strong>{terminalSelection.label}</strong>
              {terminalSelection.truncated ? <small>start truncated</small> : null}
            </div>
            <pre>{terminalSelection.text}</pre>
          </div>
        ) : null}
        {images.length || textFiles.length || unsupportedFiles.length || annotations.length || terminalSelection?.text ? (
          <div className="composer-attachments" aria-label="附件">
            {annotations.length ? (
              <div className="composer-attachment composer-attachment--annotations" title={`${annotations.length} 个网页标注`}>
                <button
                  type="button"
                  className="composer-attachment__expand"
                  aria-expanded={annotationsOpen}
                  aria-label={`查看 ${annotations.length} 个网页标注`}
                  onClick={() => setAnnotationsOpen((open) => !open)}
                >
                  <MessageCirclePlus size={13} />
                  <span>{annotations.length}</span>
                  <ChevronDown size={11} className={annotationsOpen ? 'is-open' : ''} />
                </button>
                <button
                  type="button"
                  className="composer-attachment__clear"
                  aria-label="移除网页标注"
                  onClick={() => {
                    setAnnotationsOpen(false)
                    onClearAnnotations()
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            ) : null}
            {terminalSelection?.text ? (
              <div className="composer-attachment composer-attachment--terminal has-selection" title={`来自 ${terminalSelection.label} 的选中文本`}>
                <button
                  type="button"
                  className="composer-attachment__expand"
                  aria-expanded={terminalSelectionOpen}
                  aria-label={`查看来自 ${terminalSelection.label} 的选中文本`}
                  onClick={() => setTerminalSelectionOpen((open) => !open)}
                >
                  <SquareTerminal size={13} />
                  <span>{terminalSelection.label}</span>
                  <small>selected</small><ChevronDown size={11} className={terminalSelectionOpen ? 'is-open' : ''} />
                </button>
                <button type="button" className="composer-attachment__clear" aria-label="清除终端选中" onClick={onClearTerminalSelection}><X size={12} /></button>
              </div>
            ) : null}
            {images.map((image) => (
              <div className="composer-attachment" key={image.id}>
                <img src={`data:${image.mimeType};base64,${image.data}`} alt="" />
                <span>
                  <ImageIcon size={12} />
                  {image.name}
                </span>
                <button
                  type="button"
                  aria-label={`移除 ${image.name}`}
                  onClick={() => imageAttachments.remove(image.id)}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
            {textFiles.map((file) => (
              <div className="composer-attachment" key={file.id}>
                <span>
                  <Paperclip size={12} />
                  {file.reference.name}
                </span>
                <button
                  type="button"
                  aria-label={`移除 ${file.reference.name}`}
                  onClick={() => imageAttachments.remove(file.id)}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
            {unsupportedFiles.map((file) => (
              <div className="composer-attachment" key={file.id}>
                <span>
                  <Paperclip size={12} />
                  {file.name}
                </span>
                <button
                  type="button"
                  aria-label={`移除 ${file.name}`}
                  onClick={() => imageAttachments.remove(file.id)}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {attachmentError ? (
          <p className="composer-attachment-error" role="alert">
            {attachmentError}
          </p>
        ) : null}
        <p id={imageStatusId} className="sr-only" role="status" aria-live="polite">
          {imageAttachments.dragging ? '松开以添加文件。' : processingImages ? '正在添加文件。' : images.length + textFiles.length + unsupportedFiles.length ? `已添加 ${images.length + textFiles.length + unsupportedFiles.length} 个文件。` : ''}
        </p>
        <div className="composer__footer">
          <div className="composer__controls">
            <IconButton
              label="添加上下文"
              data-composer-menu-trigger
              aria-expanded={menu === 'add'}
              aria-controls={menu === 'add' ? menuId : undefined}
              onClick={() => {
                setMenu((current) => (current === 'add' ? null : 'add'))
                requestAnimationFrame(() => textareaRef.current?.focus())
              }}
            >
              <Plus size={17} />
            </IconButton>
            <input
              ref={fileInputRef}
              className="sr-only"
              type="file"
              multiple
              accept=".txt,.md,.markdown,.csv,.json,.pdf,.docx,.xlsx,text/plain,text/markdown,text/csv,application/json,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,image/png,image/jpeg,image/gif,image/webp"
              tabIndex={-1}
              aria-label="选择要添加的文件"
              aria-describedby={imageStatusId}
              disabled={disabled || loading || submitting}
              onChange={(event) => {
                const files = Array.from(event.currentTarget.files ?? [])
                event.currentTarget.value = ''
                void imageAttachments.ingest(files)
              }}
            />
            <ModelPicker value={model} modelsByProvider={modelsByProvider} providers={providers} onChange={onModelChange} />
            <ExecutingModelChip executingModel={executingModel} />
            <SelectControl label="思考强度" compact icon={<Gauge size={12} />} value={effort} onChange={(event) => onEffortChange(event.target.value as PrimeThinkingLevel)}>
              {reasoningLevels.map((level) => (
                <option key={level} value={level}>
                  {reasoningLabels[level]}
                </option>
              ))}
            </SelectControl>
            {fastSupported ? (
              <button
                type="button"
                className={`fast-mode-toggle ${fast ? 'is-active' : ''}`}
                aria-pressed={fast}
                disabled={!fastAvailable}
                title={fastAvailable ? `使用 ${agentName} 优先服务档位` : `已安装的 ${agentName} 不支持快速模式`}
                onClick={() => onFastChange(!fast)}
              >
                <Zap size={12} fill={fast ? 'currentColor' : 'none'} /> <span className="fast-mode-toggle__label">快速</span>
              </button>
            ) : null}
            {!personalWorkspace ? <CheckoutPicker catalog={checkoutCatalog} fallbackLabel={checkoutLabel} loading={checkoutsLoading} onExecute={onExecuteCheckout} /> : null}
          </div>
          <div className="composer__actions">
            {dictation.state === 'connecting' || dictation.state === 'recording' ? <button type="button" className="context-usage-dial context-usage-dial--cancel" aria-label="取消听写" title="取消听写" onClick={dictation.cancel}><X size={14} /></button> : <span
              className={`context-usage-dial ${contextPercent === null ? 'is-unavailable' : contextPercent >= 95 ? 'is-critical' : contextPercent >= 80 ? 'is-warning' : ''}`}
              role="meter"
              tabIndex={0}
              aria-label="上下文用量"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={contextPercent === null ? undefined : Math.round(contextPercent)}
              aria-valuetext={contextLabel}
              title={contextLabel}
              data-tooltip={contextLabel}
              style={contextStyle}
            >
              <span>{contextDisplayPercent ?? '—'}</span>
            </span>}
            <button
              type="button"
              className={`dictation-button ${dictation.state === 'recording' ? 'is-recording' : ''}`}
              aria-label={dictation.state === 'recording' ? '停止并转写' : dictation.state === 'connecting' ? '正在连接麦克风' : dictation.state === 'transcribing' ? '正在转写' : '开始听写'}
              disabled={!voice || loading || disabled || submitting || dictation.state === 'connecting' || dictation.state === 'transcribing'}
              onClick={() => { if (dictation.state === 'recording') void finishDictation(false); else void dictation.start() }}
            >
              {dictation.state === 'recording' ? <Square size={10} fill="currentColor" /> : dictation.state === 'connecting' || dictation.state === 'transcribing' ? <LoaderCircle className="is-spinning" size={15} /> : <Mic size={15} />}
            </button>
            {dictation.state === 'recording' ? (
              <button type="button" className="send-button" aria-label="转写并发送" onClick={() => void finishDictation(true)}><ArrowUp size={17} /></button>
            ) : busy ? (
              <button type="button" className="send-button send-button--stop" aria-label={`停止 ${shortName}`} onClick={() => void onStop()}>
                <Square size={10} fill="currentColor" aria-hidden="true" />
              </button>
            ) : (
              <button
                type="button"
                className="send-button"
                aria-label="发送"
              disabled={(!value.trim() && images.length === 0 && textFiles.length === 0 && unsupportedFiles.length === 0 && annotations.length === 0 && !terminalSelection?.text) || processingImages || submitting || loading || disabled}
                onClick={() => void submit()}
              >
                <ArrowUp size={17} />
              </button>
            )}
          </div>
        </div>
      </div>
      <p className="composer-note">{personalWorkspace ? '重要内容和业务结果请在使用前确认。' : `${shortName} can make mistakes. Review commands and changes before committing.`}</p>
    </div>
  )
})
