import { clsx } from 'clsx';
import { Check, Loader2, X } from 'lucide-react';
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';

export const cx = clsx;

// ── Button ─────────────────────────────────────────────────
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle' | 'success';
type Size = 'sm' | 'md' | 'lg' | 'xl';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
  iconRight?: ReactNode;
  full?: boolean;
}

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand text-brand-ink hover:bg-brand-hover shadow-[0_1px_0_rgb(255_255_255/0.15)_inset,0_1px_2px_rgb(60_20_15/0.25)]',
  secondary: 'bg-surface text-ink border border-line-strong hover:bg-surface-2 hover:border-ink-3 shadow-card',
  ghost: 'text-ink-2 hover:text-ink hover:bg-sunken',
  subtle: 'bg-sunken text-ink hover:bg-line',
  danger: 'bg-surface text-danger border border-line-strong hover:bg-danger-soft hover:border-danger/40',
  success: 'bg-field text-white hover:brightness-110 shadow-[0_1px_2px_rgb(20_40_20/0.25)]',
};
const SIZES: Record<Size, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-lg',
  md: 'h-10 px-4 text-sm gap-2 rounded-[10px]',
  lg: 'h-12 px-5 text-[15px] gap-2 rounded-xl',
  xl: 'h-14 px-6 text-base gap-2.5 rounded-2xl',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, iconRight, full, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cx(
        'inline-flex select-none items-center justify-center whitespace-nowrap font-medium transition-[background,border,color,transform,box-shadow] duration-150 active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100',
        VARIANTS[variant],
        SIZES[size],
        full && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
      {iconRight}
    </button>
  );
});

export function IconButton({ label, children, className, size = 'md', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <button
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex items-center justify-center rounded-xl text-ink-2 transition hover:bg-sunken hover:text-ink active:scale-95 disabled:opacity-40',
        size === 'sm' ? 'size-8' : size === 'lg' ? 'size-12' : 'size-10',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

// ── Surfaces ───────────────────────────────────────────────
export function Card({ className, children, as: As = 'div', ...rest }: { className?: string; children: ReactNode; as?: any } & Record<string, any>) {
  return (
    <As className={cx('rounded-2xl border border-line bg-surface shadow-card', className)} {...rest}>
      {children}
    </As>
  );
}

export function SectionTitle({ children, action, className }: { children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cx('mb-3 flex items-end justify-between gap-3', className)}>
      <h2 className="text-[13px] font-semibold uppercase tracking-[0.08em] text-ink-3">{children}</h2>
      {action}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, eyebrow, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode; back?: ReactNode }) {
  return (
    <header className="mb-5 flex flex-col gap-4 sm:mb-7 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {back}
        {eyebrow && <div className="mb-1 text-[13px] font-medium text-ink-3">{eyebrow}</div>}
        <h1 className="font-display text-[28px] font-semibold leading-tight text-ink sm:text-[34px]">{title}</h1>
        {subtitle && <p className="mt-1 text-[15px] text-ink-2">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

// ── Badges ─────────────────────────────────────────────────
export type Tone = 'neutral' | 'brand' | 'field' | 'ochre' | 'danger' | 'slate';
const TONES: Record<Tone, string> = {
  neutral: 'bg-sunken text-ink-2',
  brand: 'bg-brand-soft text-brand-soft-ink',
  field: 'bg-field-soft text-field-soft-ink',
  ochre: 'bg-ochre-soft text-ochre-soft-ink',
  danger: 'bg-danger-soft text-danger-soft-ink',
  slate: 'bg-slate-soft text-slate-soft-ink',
};
const DOTS: Record<Tone, string> = { neutral: 'bg-ink-3', brand: 'bg-brand', field: 'bg-field', ochre: 'bg-ochre', danger: 'bg-danger', slate: 'bg-slate' };

export function Badge({ tone = 'neutral', children, dot, className, size = 'md' }: { tone?: Tone; children: ReactNode; dot?: boolean; className?: string; size?: 'sm' | 'md' }) {
  return (
    <span className={cx('inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full font-medium', size === 'sm' ? 'h-5 px-2 text-[11px]' : 'h-6 px-2.5 text-xs', TONES[tone], className)}>
      {dot && <span className={cx('size-1.5 rounded-full', DOTS[tone])} />}
      {children}
    </span>
  );
}

export function CountBubble({ n, tone = 'brand' }: { n: number; tone?: 'brand' | 'ochre' | 'neutral' }) {
  if (!n) return null;
  return (
    <span className={cx('inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular', tone === 'brand' ? 'bg-brand text-brand-ink' : tone === 'ochre' ? 'bg-ochre text-white' : 'bg-sunken text-ink-2')}>
      {n > 99 ? '99+' : n}
    </span>
  );
}

// ── Form fields ────────────────────────────────────────────
export function Field({ label, hint, error, children, className, htmlFor, optional }: { label?: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; className?: string; htmlFor?: string; optional?: boolean }) {
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      {label && (
        <label htmlFor={htmlFor} className="text-[13px] font-medium text-ink-2">
          {label}
          {optional && <span className="font-normal text-ink-3"> · optional</span>}
        </label>
      )}
      {children}
      {error ? <p className="text-[13px] text-danger">{error}</p> : hint ? <p className="text-[13px] text-ink-3">{hint}</p> : null}
    </div>
  );
}

const inputBase =
  'w-full rounded-[10px] border border-line-strong bg-surface px-3 text-[15px] text-ink shadow-[inset_0_1px_1px_rgb(0_0_0/0.03)] placeholder:text-ink-3 transition focus:border-brand focus:outline-none focus:ring-3 focus:ring-brand/15 disabled:bg-sunken disabled:text-ink-3';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { big?: boolean }>(function Input({ className, big, ...rest }, ref) {
  return <input ref={ref} className={cx(inputBase, big ? 'h-12 text-base' : 'h-10', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx(inputBase, 'min-h-24 py-2.5 leading-relaxed', className)} {...rest} />;
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cx(inputBase, 'h-10 appearance-none bg-[length:16px] bg-[right_10px_center] bg-no-repeat pr-9', className)}
      style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238a8378' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")" }}
      {...rest}
    >
      {children}
    </select>
  );
}

export function Segmented<T extends string>({ value, onChange, options, size = 'md', className, full }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; count?: number }[]; size?: 'sm' | 'md' | 'lg'; className?: string; full?: boolean }) {
  return (
    <div role="tablist" className={cx('inline-flex gap-1 rounded-xl bg-sunken p-1', full && 'flex w-full', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          type="button"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[9px] font-medium transition',
            size === 'sm' ? 'h-7 px-2.5 text-[13px]' : size === 'lg' ? 'h-11 px-4 text-[15px]' : 'h-8 px-3 text-sm',
            full && 'flex-1',
            value === o.value ? 'bg-surface text-ink shadow-card' : 'text-ink-2 hover:text-ink',
          )}
        >
          {o.label}
          {o.count != null && o.count > 0 && <span className={cx('tabular text-xs', value === o.value ? 'text-ink-3' : 'text-ink-3')}>{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; description?: ReactNode; disabled?: boolean }) {
  const id = useId();
  return (
    <label htmlFor={id} className={cx('flex cursor-pointer items-start justify-between gap-4 py-2', disabled && 'opacity-50')}>
      <span className="min-w-0">
        <span className="block text-[15px] font-medium text-ink">{label}</span>
        {description && <span className="mt-0.5 block text-[13px] text-ink-3">{description}</span>}
      </span>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx('relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition', checked ? 'bg-field' : 'bg-line-strong')}
      >
        <span className={cx('absolute top-0.5 size-5 rounded-full bg-white shadow transition-all', checked ? 'left-[22px]' : 'left-0.5')} />
      </button>
    </label>
  );
}

/** Large, tactile checkbox for the packing bench. */
export function BigCheck({ checked, onChange, label, disabled, size = 'lg' }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; size?: 'md' | 'lg' }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-xl border-2 transition-all duration-150 active:scale-90',
        size === 'lg' ? 'size-11' : 'size-8 rounded-lg',
        checked ? 'border-field bg-field text-white' : 'border-line-strong bg-surface hover:border-ink-3',
      )}
    >
      {checked && <Check className={cx('animate-pop', size === 'lg' ? 'size-6' : 'size-4')} strokeWidth={3} />}
    </button>
  );
}

// ── Feedback ───────────────────────────────────────────────
export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx('size-5 animate-spin text-ink-3', className)} aria-label="Loading" />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded-lg bg-sunken', className)} />;
}

export function LoadingBlock({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-16 rounded-2xl" />
      ))}
    </div>
  );
}

export function EmptyState({ icon, title, children, action, className, tone = 'neutral' }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode; className?: string; tone?: 'neutral' | 'field' }) {
  return (
    <div className={cx('flex flex-col items-center justify-center rounded-2xl border border-dashed border-line-strong px-6 py-12 text-center', className)}>
      {icon && <div className={cx('mb-4 flex size-14 items-center justify-center rounded-2xl', tone === 'field' ? 'bg-field-soft text-field' : 'bg-sunken text-ink-3')}>{icon}</div>}
      <h3 className="font-display text-xl font-semibold text-ink">{title}</h3>
      {children && <p className="mt-1.5 max-w-sm text-[15px] text-ink-2">{children}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const msg = error instanceof Error ? error.message : 'Something went wrong.';
  return (
    <div className="rounded-2xl border border-danger/25 bg-danger-soft px-5 py-4 text-danger-soft-ink" role="alert">
      <p className="font-medium">{msg}</p>
      {retry && (
        <button onClick={retry} className="mt-2 text-sm font-medium underline underline-offset-2">
          Try again
        </button>
      )}
    </div>
  );
}

export function Callout({ tone = 'slate', icon, title, children, action, className }: { tone?: Tone; icon?: ReactNode; title?: ReactNode; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cx('flex items-start gap-3 rounded-xl px-4 py-3', TONES[tone], className)}>
      {icon && <div className="mt-0.5 shrink-0">{icon}</div>}
      <div className="min-w-0 flex-1 text-[14px] leading-relaxed">
        {title && <div className="font-semibold">{title}</div>}
        {children}
      </div>
      {action}
    </div>
  );
}

// ── Toasts ─────────────────────────────────────────────────
interface ToastItem {
  id: number;
  title: string;
  body?: string;
  tone: 'success' | 'error' | 'info';
  action?: { label: string; onClick: () => void };
}
const ToastCtx = createContext<(t: Omit<ToastItem, 'id'>) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((t: Omit<ToastItem, 'id'>) => {
    const id = Date.now() + Math.random();
    setItems((s) => [...s.slice(-2), { ...t, id }]);
    setTimeout(() => setItems((s) => s.filter((x) => x.id !== id)), t.tone === 'error' ? 6000 : 3200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      {createPortal(
        <div className="pointer-events-none fixed inset-x-0 bottom-[calc(84px+env(safe-area-inset-bottom))] z-[80] flex flex-col items-center gap-2 px-4 lg:bottom-6 lg:items-end lg:pr-6" aria-live="polite">
          {items.map((t) => (
            <div
              key={t.id}
              className={cx(
                'pointer-events-auto flex w-full max-w-sm animate-rise items-start gap-3 rounded-2xl px-4 py-3 shadow-float',
                t.tone === 'error' ? 'bg-danger text-white' : 'bg-ink text-bg',
              )}
            >
              <span className={cx('mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full', t.tone === 'success' ? 'bg-field text-white' : t.tone === 'error' ? 'bg-white/20' : 'bg-white/15')}>
                {t.tone === 'error' ? <X className="size-3.5" strokeWidth={3} /> : <Check className="size-3.5 animate-pop" strokeWidth={3} />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-semibold leading-snug">{t.title}</div>
                {t.body && <div className="mt-0.5 text-[13px] opacity-80">{t.body}</div>}
              </div>
              {t.action && (
                <button onClick={t.action.onClick} className="shrink-0 text-[13px] font-semibold underline underline-offset-2">
                  {t.action.label}
                </button>
              )}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastCtx.Provider>
  );
}

// ── Overlays ───────────────────────────────────────────────
function useLockScroll(open: boolean) {
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);
}

function useEscape(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
}

/** Right-side drawer on desktop, bottom sheet on mobile. */
export function Sheet({ open, onClose, title, children, footer, width = 'md', subtitle }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: 'md' | 'lg'; subtitle?: ReactNode }) {
  useLockScroll(open);
  useEscape(open, onClose);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) setTimeout(() => ref.current?.querySelector<HTMLElement>('[data-autofocus], input, textarea, select')?.focus(), 60);
  }, [open]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[70]" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
      <div className="absolute inset-0 animate-fade bg-[rgb(20_16_12/0.45)] backdrop-blur-[2px]" onClick={onClose} />
      <div
        ref={ref}
        className={cx(
          'absolute flex flex-col bg-surface shadow-float',
          'inset-x-0 bottom-0 max-h-[92dvh] animate-sheet rounded-t-3xl',
          'md:inset-y-0 md:right-0 md:left-auto md:max-h-none md:animate-drawer md:rounded-none md:rounded-l-3xl',
          width === 'lg' ? 'md:w-[640px]' : 'md:w-[480px]',
        )}
      >
        <div className="mx-auto mt-2.5 h-1.5 w-10 rounded-full bg-line-strong md:hidden" />
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 pb-4 pt-3 md:pt-5">
          <div className="min-w-0">
            <h2 className="font-display text-xl font-semibold text-ink">{title}</h2>
            {subtitle && <p className="mt-0.5 text-sm text-ink-2">{subtitle}</p>}
          </div>
          <IconButton label="Close" onClick={onClose} className="-mr-2 -mt-1">
            <X className="size-5" />
          </IconButton>
        </div>
        <div className="flex-1 overflow-y-auto overscroll-contain px-5 py-5">{children}</div>
        {footer && <div className="safe-bottom border-t border-line bg-surface-2 px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Dialog({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: ReactNode; children?: ReactNode; footer?: ReactNode }) {
  useLockScroll(open);
  useEscape(open, onClose);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[75] flex items-end justify-center p-0 sm:items-center sm:p-4" role="alertdialog" aria-modal="true">
      <div className="absolute inset-0 animate-fade bg-[rgb(20_16_12/0.45)]" onClick={onClose} />
      <div className="relative w-full max-w-md animate-rise rounded-t-3xl bg-surface p-6 shadow-float sm:rounded-3xl">
        <h2 className="font-display text-xl font-semibold text-ink">{title}</h2>
        {children && <div className="mt-2 text-[15px] text-ink-2">{children}</div>}
        {footer && <div className="safe-bottom mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function useConfirm() {
  const [state, setState] = useState<null | { title: string; body?: ReactNode; confirm: string; tone?: 'danger' | 'primary'; resolve: (v: boolean) => void }>(null);
  const ask = useCallback(
    (opts: { title: string; body?: ReactNode; confirm?: string; tone?: 'danger' | 'primary' }) =>
      new Promise<boolean>((resolve) => setState({ title: opts.title, body: opts.body, confirm: opts.confirm ?? 'Confirm', tone: opts.tone, resolve })),
    [],
  );
  const node = (
    <Dialog
      open={!!state}
      onClose={() => {
        state?.resolve(false);
        setState(null);
      }}
      title={state?.title}
      footer={
        <>
          <Button
            onClick={() => {
              state?.resolve(false);
              setState(null);
            }}
          >
            Go back
          </Button>
          <Button
            variant={state?.tone === 'danger' ? 'danger' : 'primary'}
            onClick={() => {
              state?.resolve(true);
              setState(null);
            }}
          >
            {state?.confirm}
          </Button>
        </>
      }
    >
      {state?.body}
    </Dialog>
  );
  return { ask, node };
}

// ── Misc ───────────────────────────────────────────────────
export function Avatar({ name, size = 'md', className }: { name: string; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const hue = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 6;
  const tones = ['bg-brand-soft text-brand-soft-ink', 'bg-field-soft text-field-soft-ink', 'bg-ochre-soft text-ochre-soft-ink', 'bg-slate-soft text-slate-soft-ink', 'bg-sunken text-ink-2', 'bg-brand-soft text-brand-soft-ink'];
  const parts = name.trim().split(/\s+/);
  const ini = ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  return (
    <span className={cx('inline-flex shrink-0 items-center justify-center rounded-full font-semibold', size === 'sm' ? 'size-7 text-[11px]' : size === 'lg' ? 'size-12 text-base' : 'size-9 text-[13px]', tones[hue], className)} aria-hidden>
      {ini}
    </span>
  );
}

export function KeyValue({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cx('flex items-start justify-between gap-4 py-2.5', className)}>
      <dt className="shrink-0 text-[14px] text-ink-3">{label}</dt>
      <dd className="min-w-0 text-right text-[14px] font-medium text-ink">{children}</dd>
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded-md border border-line-strong bg-surface-2 px-1.5 py-0.5 font-sans text-[11px] font-medium text-ink-3">{children}</kbd>;
}
