/**
 * Shared accessible UI primitives for the spatial workbench.
 *
 * Design rules encoded here:
 * - status is always text + (optional) colour, never colour-only;
 * - click targets are >= 40x40 px (min-h-10);
 * - helper text >= 12px, body 14–16px;
 * - disabled controls show an explicit reason (MC-12: no decorative buttons);
 * - focus-visible is always visible; panels are proper dialogs with Escape.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, CheckCircle2, Info, Loader2, X, XCircle } from 'lucide-react';
import type { Tone } from '../../lib/labels';

export function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

export const MOTION = { feedback: 0.12, normal: 0.22, bridge: 0.42 } as const;

/* ------------------------------- tone tokens ------------------------------- */

interface ToneClasses {
  dot: string;
  text: string;
  badge: string;
  border: string;
  softBg: string;
  solidBg: string;
}

export const TONE_CLASSES: Record<Tone, ToneClasses> = {
  neutral: {
    dot: 'bg-ink-secondary',
    text: 'text-ink-primary',
    badge: 'border-white/15 bg-white/[0.04] text-ink-primary',
    border: 'border-white/10',
    softBg: 'bg-white/[0.04]',
    solidBg: 'bg-elevated',
  },
  accent: {
    dot: 'bg-anchor',
    text: 'text-anchor',
    badge: 'border-anchor/40 bg-anchor/10 text-anchor',
    border: 'border-anchor/35',
    softBg: 'bg-anchor/[0.08]',
    solidBg: 'bg-elevated',
  },
  pending: {
    dot: 'bg-pending',
    text: 'text-pending',
    badge: 'border-pending/40 bg-pending/10 text-pending',
    border: 'border-pending/35',
    softBg: 'bg-pending/[0.08]',
    solidBg: 'bg-elevated',
  },
  success: {
    dot: 'bg-accepted',
    text: 'text-accepted',
    badge: 'border-accepted/40 bg-accepted/10 text-accepted',
    border: 'border-accepted/35',
    softBg: 'bg-accepted/[0.08]',
    solidBg: 'bg-elevated',
  },
  danger: {
    dot: 'bg-failed',
    text: 'text-failed',
    badge: 'border-failed/40 bg-failed/10 text-failed',
    border: 'border-failed/40',
    softBg: 'bg-failed/[0.08]',
    solidBg: 'bg-elevated',
  },
  prospect: {
    dot: 'bg-prospect',
    text: 'text-prospect',
    badge: 'border-prospect/40 bg-prospect/10 text-prospect',
    border: 'border-prospect/35',
    softBg: 'bg-prospect/[0.08]',
    solidBg: 'bg-elevated',
  },
  muted: {
    dot: 'bg-ink-secondary/60',
    text: 'text-ink-secondary',
    badge: 'border-white/10 bg-white/[0.02] text-ink-secondary',
    border: 'border-white/8',
    softBg: 'bg-white/[0.02]',
    solidBg: 'bg-elevated',
  },
};

export function toneClasses(tone: Tone): ToneClasses {
  return TONE_CLASSES[tone] ?? TONE_CLASSES.neutral;
}

/* --------------------------------- badges --------------------------------- */

export interface StatusBadgeProps {
  label: string;
  tone?: Tone;
  /** Optional extra aria context, e.g. "模块状态". */
  ariaLabel?: string;
  className?: string;
  title?: string;
}

/** Text-first status: dot is decorative only, the label carries the meaning. */
export function StatusBadge({ label, tone = 'neutral', ariaLabel, className, title }: StatusBadgeProps): JSX.Element {
  const tokens = toneClasses(tone);
  return (
    <span
      className={cn('inline-flex min-h-[22px] items-center gap-1.5 rounded-full border px-2 text-xs leading-5', tokens.badge, className)}
      aria-label={ariaLabel ? `${ariaLabel}：${label}` : label}
      title={title ?? label}
    >
      <span aria-hidden="true" className={cn('h-1.5 w-1.5 rounded-full', tokens.dot)} />
      <span className="whitespace-nowrap">{label}</span>
    </span>
  );
}

export function Chip({ children, className, title }: { children: ReactNode; className?: string; title?: string }): JSX.Element {
  return (
    <span className={cn('inline-flex min-h-[22px] items-center gap-1 rounded border border-white/10 bg-white/[0.03] px-1.5 text-xs text-ink-secondary', className)} title={title}>
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }): JSX.Element {
  return <kbd className="rounded border border-white/15 bg-black/30 px-1.5 py-0.5 font-mono text-[11px] text-ink-secondary">{children}</kbd>;
}

/* --------------------------------- buttons --------------------------------- */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'quiet';
type ButtonSize = 'sm' | 'md' | 'lg';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-anchor text-black hover:bg-anchor/90 border-anchor disabled:bg-anchor/40 disabled:text-black/60',
  secondary: 'border-white/15 bg-white/[0.04] text-ink-primary hover:bg-white/[0.08] disabled:text-ink-secondary/60',
  ghost: 'border-transparent bg-transparent text-ink-secondary hover:bg-white/[0.06] hover:text-ink-primary',
  danger: 'border-failed/50 bg-failed/15 text-failed hover:bg-failed/25',
  quiet: 'border-white/10 bg-elevated text-ink-secondary hover:text-ink-primary hover:border-white/20',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'min-h-8 px-2.5 text-xs',
  md: 'min-h-10 px-3.5 text-sm',
  lg: 'min-h-12 px-5 text-base',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  busy?: boolean;
  /** When disabled, this reason is shown as visible helper text (MC-12). */
  disabledReason?: string | null;
  icon?: ReactNode;
}

export function Button({ variant = 'secondary', size = 'md', busy, disabledReason, icon, className, children, disabled, ...rest }: ButtonProps): JSX.Element {
  const reasonId = useId();
  const isDisabled = Boolean(disabled) || Boolean(disabledReason);
  const button = (
    <button
      type="button"
      className={cn(
        'ca-focus-ring inline-flex items-center justify-center gap-1.5 rounded border font-medium transition-colors duration-feedback disabled:cursor-not-allowed',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
      disabled={isDisabled}
      aria-busy={busy || undefined}
      aria-describedby={disabledReason ? reasonId : undefined}
      {...rest}
    >
      {busy ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : icon}
      {children}
    </button>
  );
  if (!disabledReason) return button;
  return (
    <span className="inline-flex flex-col gap-0.5">
      {button}
      <span id={reasonId} className="max-w-[28rem] text-[11px] leading-4 text-ink-secondary">
        {disabledReason}
      </span>
    </span>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required accessible name: icon-only controls never rely on the glyph. */
  label: string;
  size?: 'sm' | 'md';
}

export function IconButton({ label, size = 'md', className, children, ...rest }: IconButtonProps): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        'ca-focus-ring inline-flex items-center justify-center rounded border border-white/10 bg-white/[0.03] text-ink-secondary transition-colors duration-feedback hover:bg-white/[0.08] hover:text-ink-primary disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-8 w-8' : 'h-10 w-10',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/* --------------------------------- surfaces --------------------------------- */

export function Card({
  title,
  subtitle,
  actions,
  children,
  className,
  tone = 'neutral',
  as = 'section',
  ariaLabel,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  tone?: Tone;
  as?: 'section' | 'article' | 'div' | 'li';
  ariaLabel?: string;
}): JSX.Element {
  const Tag = as;
  return (
    <Tag className={cn('ca-hairline rounded-lg', toneClasses(tone).solidBg, 'p-3', className)} aria-label={ariaLabel}>
      {(title || actions) && (
        <div className="mb-2 flex items-start justify-between gap-2">
          <div className="min-w-0">
            {title && <h3 className="text-sm font-semibold text-ink-primary">{title}</h3>}
            {subtitle && <p className="mt-0.5 text-xs text-ink-secondary">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
        </div>
      )}
      {children}
    </Tag>
  );
}

export function SectionHeading({
  title,
  description,
  icon,
  actions,
  level = 'section',
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  level?: 'region' | 'section';
}): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <h2 className={cn('flex items-center gap-1.5 font-semibold text-ink-primary', level === 'region' ? 'text-base' : 'text-sm')}>
          {icon}
          <span>{title}</span>
        </h2>
        {description && <p className="mt-0.5 text-xs text-ink-secondary">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </div>
  );
}

/* ------------------------------- state blocks ------------------------------- */

export function EmptyState({ title, description, action, icon, compact }: { title: string; description?: ReactNode; action?: ReactNode; icon?: ReactNode; compact?: boolean }): JSX.Element {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-white/10 text-center', compact ? 'px-3 py-4' : 'px-4 py-8')}>
      {icon && <span className="text-ink-secondary">{icon}</span>}
      <p className="text-sm font-medium text-ink-primary">{title}</p>
      {description && <p className="max-w-sm text-xs text-ink-secondary">{description}</p>}
      {action}
    </div>
  );
}

export function LoadingBlock({ label = '正在读取…', compact }: { label?: string; compact?: boolean }): JSX.Element {
  return (
    <div role="status" aria-live="polite" className={cn('flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.02] text-xs text-ink-secondary', compact ? 'px-3 py-2' : 'px-4 py-6')}>
      <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
      <span>{label}</span>
    </div>
  );
}

export function InlineWarning({ children, tone = 'pending', title }: { children: ReactNode; tone?: Tone; title?: string }): JSX.Element {
  const tokens = toneClasses(tone);
  return (
    <div className={cn('flex items-start gap-2 rounded border px-2.5 py-2 text-xs', tokens.border, tokens.softBg)} role="note">
      <AlertTriangle aria-hidden="true" className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', tokens.text)} />
      <div className="min-w-0 text-ink-secondary">
        {title && <p className={cn('font-medium', tokens.text)}>{title}</p>}
        <div>{children}</div>
      </div>
    </div>
  );
}

export function DataList({ rows, className }: { rows: Array<{ label: string; value: ReactNode; hint?: ReactNode }>; className?: string }): JSX.Element {
  return (
    <dl className={cn('grid grid-cols-[minmax(5rem,auto)_1fr] gap-x-3 gap-y-1.5 text-xs', className)}>
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="text-ink-secondary">{row.label}</dt>
          <dd className="min-w-0 break-words text-ink-primary">
            {row.value}
            {row.hint && <span className="mt-0.5 block text-ink-secondary">{row.hint}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/* --------------------------------- fields --------------------------------- */

export function Field({ label, htmlFor, help, error, required, children }: { label: string; htmlFor: string; help?: ReactNode; error?: string | null; required?: boolean; children: ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-xs font-medium text-ink-primary">
        {label}
        {required && <span className="ml-0.5 text-failed">*</span>}
      </label>
      {children}
      {help && <p className="text-[11px] leading-4 text-ink-secondary">{help}</p>}
      {error && (
        <p role="alert" className="text-[11px] leading-4 text-failed">
          {error}
        </p>
      )}
    </div>
  );
}

const INPUT_CLASS = 'ca-focus-ring min-h-10 w-full rounded border border-white/15 bg-black/30 px-2.5 py-1.5 text-sm text-ink-primary placeholder:text-ink-secondary/60 disabled:opacity-60';

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>): JSX.Element {
  return <input className={cn(INPUT_CLASS, className)} {...rest} />;
}

export function TextArea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>): JSX.Element {
  return <textarea className={cn(INPUT_CLASS, 'min-h-[96px] resize-y leading-6', className)} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>): JSX.Element {
  return (
    <select className={cn(INPUT_CLASS, 'pr-8', className)} {...rest}>
      {children}
    </select>
  );
}

export function Checkbox({ label, help, className, id, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; help?: string }): JSX.Element {
  const generated = useId();
  const inputId = id ?? generated;
  return (
    <div className={cn('flex items-start gap-2', className)}>
      <input id={inputId} type="checkbox" className="ca-focus-ring mt-1 h-4 w-4 shrink-0 rounded border-white/30 bg-black/40 accent-anchor" {...rest} />
      <label htmlFor={inputId} className="min-w-0 text-xs leading-5 text-ink-primary">
        {label}
        {help && <span className="mt-0.5 block text-[11px] text-ink-secondary">{help}</span>}
      </label>
    </div>
  );
}

export function Toggle({ label, checked, onChange, disabled, disabledReason, help }: { label: string; checked: boolean; onChange: (next: boolean) => void; disabled?: boolean; disabledReason?: string; help?: string }): JSX.Element {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-3 py-1">
      <div className="min-w-0">
        <label htmlFor={id} className="text-xs font-medium text-ink-primary">
          {label}
        </label>
        {help && <p className="text-[11px] leading-4 text-ink-secondary">{help}</p>}
        {disabled && disabledReason && <p className="text-[11px] leading-4 text-pending">{disabledReason}</p>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn('ca-focus-ring relative mt-0.5 h-6 w-11 shrink-0 rounded-full border transition-colors duration-feedback', checked ? 'border-accepted/50 bg-accepted/30' : 'border-white/20 bg-white/10', disabled && 'cursor-not-allowed opacity-50')}
      >
        <span aria-hidden="true" className={cn('absolute top-0.5 h-4 w-4 rounded-full bg-ink-primary transition-transform duration-fast', checked ? 'translate-x-[22px]' : 'translate-x-0.5')} />
      </button>
    </div>
  );
}

/* --------------------------------- tabs --------------------------------- */

export function Tabs<T extends string>({ tabs, value, onChange, ariaLabel }: { tabs: Array<{ id: T; label: string; count?: number }>; value: T; onChange: (id: T) => void; ariaLabel: string }): JSX.Element {
  return (
    <div role="tablist" aria-label={ariaLabel} className="flex flex-wrap gap-1 border-b border-white/10 pb-1">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={value === tab.id}
          className={cn(
            'ca-focus-ring min-h-9 rounded px-2.5 text-xs transition-colors duration-feedback',
            value === tab.id ? 'bg-white/[0.08] font-medium text-ink-primary' : 'text-ink-secondary hover:text-ink-primary',
          )}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {tab.count != null && <span className="ml-1 text-ink-secondary">({tab.count})</span>}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------ overlay panels ------------------------------ */

export interface OverlayPanelProps {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  ariaLabel?: string;
  size?: 'md' | 'lg' | 'xl';
  reducedMotion?: boolean;
}

/**
 * Right-side dialog panel. Escape closes it (draft is kept in the view store),
 * focus moves into the panel and returns to the opener when it unmounts.
 */
export function OverlayPanel({ title, subtitle, onClose, children, footer, ariaLabel, size = 'lg', reducedMotion }: OverlayPanelProps): JSX.Element {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  useEffect(() => {
    const previouslyFocused = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
    const first = contentRef.current?.querySelector<HTMLElement>('[data-autofocus], button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    first?.focus();
    return () => {
      previouslyFocused?.focus?.();
    };
  }, []);
  const width = size === 'xl' ? 'max-w-[72rem]' : size === 'lg' ? 'max-w-[46rem]' : 'max-w-[36rem]';
  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="presentation">
      <button type="button" aria-label="关闭面板遮罩" className="absolute inset-0 bg-black/55" onClick={onClose} tabIndex={-1} />
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-label={ariaLabel ?? title}
        className={cn('ca-glass ca-scroll relative flex h-full w-full flex-col overflow-y-auto border-l border-white/10 shadow-2xl', width)}
        initial={reducedMotion ? false : { x: 24, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={reducedMotion ? undefined : { x: 24, opacity: 0 }}
        transition={{ duration: reducedMotion ? 0 : MOTION.normal, ease: 'easeOut' }}
      >
        <header className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-white/10 bg-elevated/95 px-4 py-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold text-ink-primary">
              {title}
            </h2>
            {subtitle && <div className="mt-0.5 text-xs text-ink-secondary">{subtitle}</div>}
          </div>
          <IconButton label="关闭面板（Escape）" onClick={onClose}>
            <X aria-hidden="true" className="h-4 w-4" />
          </IconButton>
        </header>
        <div ref={contentRef} className="flex-1 px-4 py-3">
          {children}
        </div>
        {footer && <footer className="sticky bottom-0 border-t border-white/10 bg-elevated/95 px-4 py-3">{footer}</footer>}
      </motion.div>
    </div>
  );
}

/* -------------------------------- feedback -------------------------------- */

const NOTICE_TONES: Record<'info' | 'success' | 'warning' | 'error', { tone: Tone; icon: JSX.Element }> = {
  info: { tone: 'prospect', icon: <Info aria-hidden="true" className="h-4 w-4" /> },
  success: { tone: 'success', icon: <CheckCircle2 aria-hidden="true" className="h-4 w-4" /> },
  warning: { tone: 'pending', icon: <AlertTriangle aria-hidden="true" className="h-4 w-4" /> },
  error: { tone: 'danger', icon: <XCircle aria-hidden="true" className="h-4 w-4" /> },
};

export interface NoticeItem {
  id: string;
  tone: 'info' | 'success' | 'warning' | 'error';
  title: string;
  detail?: string;
  traceId?: string | null;
}

export function NoticeStack({ notices, onDismiss }: { notices: NoticeItem[]; onDismiss: (id: string) => void }): JSX.Element {
  return (
    <div className="pointer-events-none fixed bottom-16 right-4 z-50 flex w-[min(92vw,26rem)] flex-col gap-2" aria-live="polite" aria-atomic="false">
      <AnimatePresence initial={false}>
        {notices.slice(-3).map((notice) => {
          const meta = NOTICE_TONES[notice.tone];
          const tokens = toneClasses(meta.tone);
          return (
            <motion.div
              key={notice.id}
              layout
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: MOTION.feedback }}
              className={cn('pointer-events-auto flex items-start gap-2 rounded-lg border p-2.5 shadow-lg', tokens.border, 'ca-solid')}
              role={notice.tone === 'error' ? 'alert' : 'status'}
            >
              <span className={cn('mt-0.5 shrink-0', tokens.text)}>{meta.icon}</span>
              <div className="min-w-0 flex-1">
                <p className={cn('text-xs font-medium', tokens.text)}>{notice.title}</p>
                {notice.detail && <p className="mt-0.5 break-words text-[11px] leading-4 text-ink-secondary">{notice.detail}</p>}
                {notice.traceId && <p className="mt-0.5 font-mono text-[10px] text-ink-secondary">trace: {notice.traceId}</p>}
              </div>
              <IconButton label="关闭提示" size="sm" className="border-transparent bg-transparent" onClick={() => onDismiss(notice.id)}>
                <X aria-hidden="true" className="h-3.5 w-3.5" />
              </IconButton>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

/** Full-page / section error surface: what happened, what was preserved, next step. */
export function ErrorNotice({
  title,
  message,
  guidance,
  traceId,
  onRetry,
  retryLabel = '重试',
  compact,
}: {
  title: string;
  message: string;
  guidance?: string[];
  traceId?: string | null;
  onRetry?: () => void;
  retryLabel?: string;
  compact?: boolean;
}): JSX.Element {
  return (
    <div role="alert" className={cn('rounded-lg border border-failed/40 bg-failed/[0.06]', compact ? 'p-2.5' : 'p-4')}>
      <p className="flex items-center gap-1.5 text-sm font-medium text-failed">
        <XCircle aria-hidden="true" className="h-4 w-4" />
        {title}
      </p>
      <p className="mt-1 break-words text-xs text-ink-primary">{message}</p>
      {guidance && guidance.length > 0 && (
        <ul className="mt-1.5 list-inside list-disc space-y-0.5 text-[11px] leading-4 text-ink-secondary">
          {guidance.map((tip) => (
            <li key={tip}>{tip}</li>
          ))}
        </ul>
      )}
      {traceId && <p className="mt-1 font-mono text-[10px] text-ink-secondary">trace: {traceId}</p>}
      {onRetry && (
        <div className="mt-2">
          <Button size="sm" variant="secondary" onClick={onRetry}>
            {retryLabel}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Disabled-state explanation used across mechanism control bars (MC-12). */
export function DisabledHint({ children }: { children: ReactNode }): JSX.Element {
  return <p className="text-[11px] leading-4 text-pending">{children}</p>;
}

/* -------------------------------- progress -------------------------------- */

/** Step-based progress only; never a fabricated overall percentage. */
export function StepProgress({ completed, total, label }: { completed: number | null; total: number | null; label?: string }): JSX.Element {
  if (completed == null || total == null || total <= 0) {
    return <span className="text-xs text-ink-secondary">{label ?? '步骤进度未知'}</span>;
  }
  const safe = Math.min(Math.max(0, completed), total);
  return (
    <div className="flex items-center gap-2">
      <span className="ca-tabular text-xs text-ink-secondary">
        {label ? `${label} ` : ''}
        {safe}/{total} 个步骤
      </span>
      <span className="relative h-1 w-24 overflow-hidden rounded bg-white/10" aria-hidden="true">
        <span className="absolute inset-y-0 left-0 rounded bg-anchor/80" style={{ width: `${(safe / total) * 100}%` }} />
      </span>
    </div>
  );
}

/* --------------------------------- helpers --------------------------------- */

const EditableContext = createContext(false);

/** Mark a subtree as containing a text editor (layer hotkeys must not intercept). */
export function EditableArea({ children }: { children: ReactNode }): JSX.Element {
  return <EditableContext.Provider value={true}>{children}</EditableContext.Provider>;
}

export function useIsEditableArea(): boolean {
  return useContext(EditableContext);
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const element = target as HTMLElement;
  const tag = element.tagName?.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || element.isContentEditable === true;
}

/** Framer-motion transition helper that disables motion when requested. */
export function motionFor(reduced: boolean, duration: number = MOTION.normal): { duration: number } {
  return { duration: reduced ? 0 : duration };
}

export function useStableCallback<T extends (...args: never[]) => void>(callback: T): T {
  const ref = useRef(callback);
  ref.current = callback;
  return useCallback(((...args: never[]) => ref.current(...args)) as T, []);
}
