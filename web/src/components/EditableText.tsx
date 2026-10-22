// Controlled inline editor: display mode is a real button (keyboard reachable,
// space/enter to start editing); edit mode is an input/textarea that saves on a
// debounce (default 800ms), on blur, and on unmount — so no edit is ever lost.
// Escape cancels. A tiny indicator shows saving / saved / failed.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { Check, LoaderCircle, Pencil, TriangleAlert } from 'lucide-react';
import { useDebouncedCallback } from '../hooks/useDebouncedCallback';
import { focusRing, inputClasses } from './primitives';

export interface EditableTextProps {
  value: string;
  onSave: (next: string) => Promise<void>;
  /** Announced to screen readers, e.g. "day 2 focus". */
  label: string;
  multiline?: boolean;
  placeholder?: string;
  rows?: number;
  /** Renders a number input instead of text (still saves a string). */
  numeric?: boolean;
  displayClassName?: string;
  disabled?: boolean;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

function SaveIndicator({ state, floating }: { state: SaveState; floating?: boolean }) {
  if (state === 'idle') return null;
  const map: Record<Exclude<SaveState, 'idle'>, { icon: JSX.Element; text: string; cls: string }> = {
    saving: {
      icon: <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden />,
      text: 'Saving…',
      cls: 'text-indigo-300',
    },
    saved: {
      icon: <Check className="h-3 w-3" aria-hidden />,
      text: 'Saved',
      cls: 'text-emerald-400',
    },
    error: {
      icon: <TriangleAlert className="h-3 w-3" aria-hidden />,
      text: 'Save failed',
      cls: 'text-rose-400',
    },
  };
  const s = map[state];
  return (
    <span
      role="status"
      title={state === 'error' ? 'Could not save. Your text is kept here — try editing again.' : undefined}
      className={`inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium ${s.cls} ${
        floating ? 'bg-slate-950/80' : ''
      }`}
    >
      {s.icon}
      {s.text}
    </span>
  );
}

export function EditableText({
  value,
  onSave,
  label,
  multiline = true,
  placeholder = 'Click to add',
  rows = 3,
  numeric = false,
  displayClassName = '',
  disabled = false,
}: EditableTextProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const valueRef = useRef(value);
  valueRef.current = value;
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controlRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  const markIdleSoon = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => setSaveState('idle'), 1600);
  }, []);

  const performSave = useCallback(
    async (next: string) => {
      if (next === valueRef.current) {
        setSaveState('idle');
        return;
      }
      setSaveState('saving');
      try {
        await onSave(next);
        setSaveState('saved');
        markIdleSoon();
      } catch {
        setSaveState('error');
        markIdleSoon();
      }
    },
    [onSave, markIdleSoon],
  );

  const debounced = useDebouncedCallback((v: string) => {
    void performSave(v);
  }, 800);

  useEffect(
    () => () => {
      debounced.flush();
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    },
    [debounced],
  );

  const beginEdit = () => {
    if (disabled) return;
    setDraft(valueRef.current);
    setEditing(true);
    requestAnimationFrame(() => {
      const el = controlRef.current;
      if (!el) return;
      el.focus();
      const len = el.value.length;
      try {
        el.setSelectionRange(len, len);
      } catch {
        // number inputs do not support selection ranges
      }
    });
  };

  const commitOnBlur = () => {
    debounced.flush();
    setEditing(false);
  };

  const cancelOnEscape = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      debounced.cancel();
      setEditing(false);
    }
  };

  const sharedEditProps = {
    value: draft,
    onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setDraft(e.target.value);
      debounced.schedule(e.target.value);
    },
    onBlur: commitOnBlur,
    onKeyDown: cancelOnEscape,
    'aria-label': label,
  };

  if (!editing) {
    return (
      <span className="flex min-w-0 flex-1 items-start gap-1.5">
        <button
          type="button"
          onClick={beginEdit}
          disabled={disabled}
          aria-label={`Edit ${label}`}
          className={`group flex w-full items-start gap-2 rounded-lg px-2 py-1 text-left transition-colors hover:bg-slate-800/60 disabled:cursor-not-allowed disabled:opacity-60 ${focusRing} ${displayClassName}`}
        >
          <span className={value ? 'min-w-0 whitespace-pre-wrap break-words' : 'italic text-slate-500'}>
            {value || placeholder}
          </span>
          <Pencil
            className="mt-1 h-3 w-3 shrink-0 text-slate-500 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
            aria-hidden
          />
        </button>
        <span className="mt-1 shrink-0">
          <SaveIndicator state={saveState} />
        </span>
      </span>
    );
  }

  return (
    <span className="relative flex w-full flex-col gap-1">
      {multiline ? (
        <textarea
          ref={controlRef as RefObject<HTMLTextAreaElement>}
          rows={rows}
          className={`${inputClasses} resize-y`}
          {...sharedEditProps}
        />
      ) : (
        <input
          ref={controlRef as RefObject<HTMLInputElement>}
          type={numeric ? 'number' : 'text'}
          className={inputClasses}
          {...sharedEditProps}
        />
      )}
      <span className="absolute right-2 top-2">
        <SaveIndicator state={saveState} floating />
      </span>
    </span>
  );
}
