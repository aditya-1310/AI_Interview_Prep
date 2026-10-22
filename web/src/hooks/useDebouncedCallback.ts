// A debounced callback that also supports flush (fire the pending call now)
// and cancel (drop it). flush() is used by inline editors when the field
// blurs or unmounts, so an edit is never lost to the debounce window.

import { useCallback, useRef } from 'react';

export interface Debounced<T extends unknown[]> {
  schedule: (...args: T) => void;
  flush: () => void;
  cancel: () => void;
}

export function useDebouncedCallback<T extends unknown[]>(
  fn: (...args: T) => void,
  delay: number,
): Debounced<T> {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const argsRef = useRef<T | null>(null);

  const schedule = useCallback(
    (...args: T) => {
      argsRef.current = args;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const pending = argsRef.current;
        argsRef.current = null;
        if (pending) fnRef.current(...pending);
      }, delay);
    },
    [delay],
  );

  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = argsRef.current;
    argsRef.current = null;
    if (pending) fnRef.current(...pending);
  }, []);

  const cancel = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    argsRef.current = null;
  }, []);

  return { schedule, flush, cancel };
}
