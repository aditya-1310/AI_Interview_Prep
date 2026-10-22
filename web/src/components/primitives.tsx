// Small shared primitives: buttons, chips, status chips, skeletons, error and
// empty states, confirm button, form field wrappers. Everything interactive is
// a real control with a visible focus ring.

import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import {
  LoaderCircle,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';

export const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950';

/* ------------------------------------------------------------------ Button */

type ButtonVariant = 'primary' | 'secondary' | 'success' | 'danger' | 'ghost' | 'danger-ghost';
type ButtonSize = 'sm' | 'md';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-indigo-500 text-white hover:bg-indigo-400',
  secondary: 'border border-slate-700 bg-slate-900 text-slate-200 hover:border-slate-500 hover:text-white',
  success: 'bg-emerald-500 text-slate-950 hover:bg-emerald-400',
  danger: 'bg-rose-600 text-white hover:bg-rose-500',
  ghost: 'text-slate-300 hover:bg-slate-800 hover:text-white',
  'danger-ghost': 'text-rose-400 hover:bg-rose-500/10 hover:text-rose-300',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'px-2.5 py-1.5 text-xs',
  md: 'px-3.5 py-2 text-sm',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIcon;
  pending?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'md',
  icon: Icon,
  pending = false,
  className = '',
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || pending}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${BUTTON_VARIANTS[variant]} ${BUTTON_SIZES[size]} ${focusRing} ${className}`}
      {...rest}
    >
      {pending ? (
        <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden />
      ) : (
        Icon && <Icon className="h-3.5 w-3.5" aria-hidden />
      )}
      {children}
    </button>
  );
}

/* -------------------------------------------------------- ConfirmButton */

export interface ConfirmButtonProps {
  onConfirm: () => void;
  label: string;
  confirmLabel?: string;
  /** Tooltip shown while armed, e.g. what regeneration preserves. */
  note?: string;
  icon?: LucideIcon;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
}

/** Two-step destructive/irreversible action: first click arms, second confirms. */
export function ConfirmButton({
  onConfirm,
  label,
  confirmLabel = 'Confirm',
  note,
  icon: Icon,
  variant = 'ghost',
  size = 'sm',
  disabled = false,
  className = '',
  'aria-label': ariaLabel,
}: ConfirmButtonProps) {
  const [armed, setArmed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const disarm = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setArmed(false);
  };

  const handleClick = () => {
    if (!armed) {
      setArmed(true);
      timerRef.current = setTimeout(disarm, 5000);
      return;
    }
    disarm();
    onConfirm();
  };

  return (
    <Button
      variant={armed ? 'danger' : variant}
      size={size}
      className={className}
      onClick={handleClick}
      disabled={disabled}
      aria-label={armed ? `Confirm: ${confirmLabel}` : ariaLabel ?? label}
      title={armed ? note : undefined}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && armed) {
          e.stopPropagation();
          disarm();
        }
      }}
    >
      {armed ? <TriangleAlert className="h-3.5 w-3.5" aria-hidden /> : Icon ? <Icon className="h-3.5 w-3.5" aria-hidden /> : null}
      {armed ? confirmLabel : label}
    </Button>
  );
}

/* ------------------------------------------------------------------- Chip */

export function Chip({
  children,
  className = '',
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex max-w-full items-center gap-1 truncate rounded-full border border-slate-700 bg-slate-800/60 px-2 py-0.5 text-[11px] font-medium text-slate-300 ${className}`}
    >
      {children}
    </span>
  );
}

/* ------------------------------------------------------------ StatusChip */

const STATUS_STYLES: Record<string, { dot: string; text: string; label: string }> = {
  pending: { dot: 'bg-amber-400', text: 'text-amber-300', label: 'Generating' },
  ready: { dot: 'bg-emerald-400', text: 'text-emerald-300', label: 'Ready' },
  failed: { dot: 'bg-rose-400', text: 'text-rose-300', label: 'Failed' },
  queued: { dot: 'bg-indigo-400', text: 'text-indigo-300', label: 'Queued' },
  running: { dot: 'bg-indigo-400', text: 'text-indigo-300', label: 'Running' },
  completed: { dot: 'bg-emerald-400', text: 'text-emerald-300', label: 'Completed' },
};

export function StatusChip({ status }: { status: string }) {
  const s = STATUS_STYLES[status] ?? {
    dot: 'bg-slate-400',
    text: 'text-slate-300',
    label: status,
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-900 px-2.5 py-0.5 text-xs font-medium capitalize ${s.text}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} aria-hidden />
      {s.label}
    </span>
  );
}

/* -------------------------------------------------------------- Skeletons */

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-slate-800/80 ${className}`} aria-hidden />;
}

export function SkeletonCard() {
  return (
    <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <Skeleton className="h-5 w-1/2" />
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-1/3" />
    </div>
  );
}

export function FullPageSpinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="grid min-h-[50vh] place-items-center" role="status">
      <div className="flex flex-col items-center gap-3 text-slate-400">
        <LoaderCircle className="h-7 w-7 animate-spin text-indigo-400" aria-hidden />
        <p className="text-sm">{label}</p>
        <span className="sr-only">{label}</span>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- ErrorBanner */

export function ErrorBanner({
  title,
  message,
  variant = 'error',
  children,
}: {
  title?: string;
  message: string;
  variant?: 'error' | 'warning';
  children?: ReactNode;
}) {
  const styles =
    variant === 'error'
      ? 'border-rose-500/40 bg-rose-500/10 text-rose-200'
      : 'border-amber-500/40 bg-amber-500/10 text-amber-200';
  return (
    <div role="alert" className={`rounded-xl border px-4 py-3 ${styles}`}>
      <div className="flex items-start gap-2.5">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-sm font-semibold">
            {title ?? (variant === 'error' ? 'Something went wrong' : 'Heads up')}
          </p>
          <p className="break-words text-sm opacity-90">{message}</p>
          {children ? <div className="flex flex-wrap gap-2">{children}</div> : null}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ EmptyState */

export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900/40 px-6 py-12 text-center">
      <Icon className="mx-auto h-8 w-8 text-slate-600" aria-hidden />
      <h3 className="mt-3 text-sm font-semibold text-slate-200">{title}</h3>
      {description ? (
        <p className="mx-auto mt-1 max-w-md text-sm text-slate-400">{description}</p>
      ) : null}
      {children ? <div className="mt-4 flex flex-wrap justify-center gap-2">{children}</div> : null}
    </div>
  );
}

/* ---------------------------------------------------------- Form pieces */

export const inputClasses =
  'w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400';

export function Field({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string;
  label: ReactNode;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-slate-300">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-rose-400" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-slate-500">{hint}</p>
      ) : null}
    </div>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className = '', ...rest } = props;
  return <input className={`${inputClasses} ${className}`} {...rest} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className = '', ...rest } = props;
  return <textarea className={`${inputClasses} ${className}`} {...rest} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { className = '', ...rest } = props;
  return <select className={`${inputClasses} ${className}`} {...rest} />;
}
