import { Check, ChevronDown, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type RefObject, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { createPortal } from 'react-dom'
import workbenchIcon from '../../assets/icon.svg'

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  size?: 'small' | 'regular'
}

export function IconButton({ label, size = 'regular', className = '', children, ...props }: IconButtonProps) {
  return (
    <button type="button" className={`icon-button icon-button--${size} ${className}`} aria-label={label} title={label} {...props}>
      {children}
    </button>
  )
}

export function BrowserGlobe({ size = 18 }: { size?: number }) {
  return (
    <svg
      className="browser-globe"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <ellipse cx="12" cy="12" rx="3.65" ry="9" />
      <path d="M3 12h18" />
    </svg>
  )
}

interface SelectControlProps extends SelectHTMLAttributes<HTMLSelectElement> {
  icon?: ReactNode
  compact?: boolean
  label: string
}

export function SelectControl({ icon, compact, className = '', label, children, ...props }: SelectControlProps) {
  return (
    <label className={`select-control ${compact ? 'select-control--compact' : ''} ${className}`} title={label}>
      <span className="select-control__icon" aria-hidden="true">{icon}</span>
      <span className="sr-only">{label}</span>
      <select aria-label={label} {...props}>{children}</select>
      <ChevronDown className="select-control__chevron" size={12} aria-hidden="true" />
    </label>
  )
}

export function ProductSelect<T extends string>({ value, options, label, disabled, onChange, className = '' }: {
  value: T
  options: Array<{ value: T; label: string; detail?: string }>
  label: string
  disabled?: boolean
  onChange(value: T): void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const listId = useId()
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value))
  const selected = options[selectedIndex]
  const close = (restoreFocus = false) => {
    setOpen(false)
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus())
  }
  const show = () => {
    if (disabled || !options.length) return
    setOpen(true)
    requestAnimationFrame(() => optionRefs.current[selectedIndex]?.focus())
  }
  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) close()
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [open])
  return <div className={`product-select ${className}`} ref={rootRef}>
    <button ref={triggerRef} type="button" className="product-select__trigger" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined} disabled={disabled || !options.length} onClick={() => open ? close() : show()} onKeyDown={(event) => {
      if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); show() }
    }}>
      <span><strong>{selected?.label ?? '暂无可选项'}</strong>{selected?.detail ? <small>{selected.detail}</small> : null}</span><ChevronDown size={14} aria-hidden="true"/>
    </button>
    {open ? <div id={listId} className="product-select__menu" role="listbox" aria-label={label} onKeyDown={(event) => {
      const current = optionRefs.current.indexOf(document.activeElement as HTMLButtonElement | null)
      if (event.key === 'Escape') { event.preventDefault(); close(true); return }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      event.preventDefault()
      const next = (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
      optionRefs.current[next]?.focus()
    }} onBlur={(event) => {
      if (event.relatedTarget instanceof Node && !rootRef.current?.contains(event.relatedTarget)) close()
    }}>
      {options.map((option, index) => <button ref={(element) => { optionRefs.current[index] = element }} type="button" role="option" aria-selected={option.value === value} className={option.value === value ? 'is-selected' : ''} key={option.value} onClick={() => { onChange(option.value); close(true) }}><span><strong>{option.label}</strong>{option.detail ? <small>{option.detail}</small> : null}</span>{option.value === value ? <Check size={14} aria-hidden="true"/> : null}</button>)}
    </div> : null}
  </div>
}

export function ProductField({ label, detail, className = '', ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; detail?: string }) {
  return <label className={`product-field ${className}`}><span><strong>{label}</strong>{detail ? <small>{detail}</small> : null}</span><input {...props}/></label>
}

export function ProductTextArea({ label, detail, className = '', ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; detail?: string }) {
  return <label className={`product-field product-field--textarea ${className}`}><span><strong>{label}</strong>{detail ? <small>{detail}</small> : null}</span><textarea {...props}/></label>
}

export function ProductSwitch({ checked, label, detail, disabled, onChange }: { checked: boolean; label: string; detail?: string; disabled?: boolean; onChange(value: boolean): void }) {
  return <button type="button" className={`product-switch ${checked ? 'is-checked' : ''}`} role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}><span><strong>{label}</strong>{detail ? <small>{detail}</small> : null}</span><i aria-hidden="true"><b/></i></button>
}

export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange(value: T): void
  label: string
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          className={value === option.value ? 'is-active' : ''}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state">
      {icon ? <div className="empty-state__icon">{icon}</div> : null}
      <h2>{title}</h2>
      <p>{children}</p>
      {action ? <div className="empty-state__action">{action}</div> : null}
    </div>
  )
}

const focusableSelector = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function useFocusTrap<T extends HTMLElement>(active: boolean, onEscape?: () => void): RefObject<T | null> {
  const containerRef = useRef<T>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const escapeRef = useRef(onEscape)
  escapeRef.current = onEscape
  useEffect(() => {
    if (!active || !containerRef.current) return
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const container = containerRef.current
    const focusInitial = () => {
      // A child may have already focused itself, or the employee may have
      // entered an editor before this frame. Keep that focus inside the modal.
      if (document.activeElement !== container && container.contains(document.activeElement)) return
      const preferred = container.querySelector<HTMLElement>('[autofocus]')
      const first = preferred ?? container.querySelector<HTMLElement>(focusableSelector)
      first?.focus()
    }
    const frame = requestAnimationFrame(focusInitial)
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.target instanceof Node) || !container.contains(event.target)) return
      if (event.key === 'Escape' && escapeRef.current) { event.preventDefault(); escapeRef.current(); return }
      if (event.key !== 'Tab') return
      const items = [...container.querySelectorAll<HTMLElement>(focusableSelector)].filter((item) => !item.hidden && item.getClientRects().length > 0)
      if (!items.length) { event.preventDefault(); container.focus(); return }
      const first = items[0]; const last = items.at(-1)!
      if (event.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', onKeyDown, true)
      const restore = previousFocus.current
      requestAnimationFrame(() => {
        if (!restore?.isConnected) return
        const focused = document.activeElement
        // A later user action or overlay owns its new focus; do not close its editor.
        if (focused && focused !== document.body && focused !== document.documentElement && !container.contains(focused)) return
        restore.focus()
      })
    }
  }, [active])
  return containerRef
}

// Overlays (modals, the command palette) share one refcount so stacked or
// sibling overlays only toggle the app shell's inert state on 0<->1 transitions.
let appShellOverlayCount = 0

export function useAppShellOverlay(active: boolean): void {
  useEffect(() => {
    if (!active) return
    const shell = document.querySelector<HTMLElement>('.app-shell')
    if (!shell) return
    appShellOverlayCount += 1
    if (appShellOverlayCount === 1) { shell.inert = true; shell.setAttribute('aria-hidden', 'true') }
    return () => {
      appShellOverlayCount -= 1
      if (appShellOverlayCount === 0) { shell.inert = false; shell.removeAttribute('aria-hidden') }
    }
  }, [active])
}

export function Modal({ title, children, onClose, footer }: { title: string; children: ReactNode; onClose(): void; footer?: ReactNode }) {
  const titleId = useId()
  const modalRef = useFocusTrap<HTMLElement>(true, onClose)
  useAppShellOverlay(true)
  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={modalRef} className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="modal__header"><h2 id={titleId}>{title}</h2><IconButton label="Close" onClick={onClose}><X size={16} /></IconButton></div>
        <div className="modal__body">{children}</div>
        {footer ? <div className="modal__footer">{footer}</div> : null}
      </section>
    </div>, document.body
  )
}

export function WorkbenchMark({ size = 24 }: { size?: number }) {
  return (
    <span className="workbench-mark" style={{ width: size, height: size }} role="img" aria-label="Kim">
      <img src={workbenchIcon} alt="" aria-hidden="true" />
    </span>
  )
}

export const PrimeMark = WorkbenchMark
export const PiMark = WorkbenchMark
export const LoomMark = WorkbenchMark
export const GooeyPiMark = WorkbenchMark
