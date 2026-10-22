// Amber, dismissible banner for kit warnings (research gaps etc.).
// Re-appears automatically when a new set of warnings arrives.

import { useEffect, useRef, useState } from 'react';
import { TriangleAlert, X } from 'lucide-react';
import type { Warning } from '@contracts';
import { focusRing } from './primitives';

export function WarningsBanner({ warnings }: { warnings: Warning[] }) {
  const [dismissed, setDismissed] = useState(false);
  const signature = warnings.map((w) => `${w.code}:${w.message}`).join('|');
  const signatureRef = useRef(signature);

  useEffect(() => {
    if (signatureRef.current !== signature) {
      signatureRef.current = signature;
      setDismissed(false);
    }
  }, [signature]);

  if (!warnings || warnings.length === 0 || dismissed) return null;

  return (
    <section
      aria-label="Warnings"
      className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-amber-200"
    >
      <div className="flex items-start gap-2.5">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Research notes</p>
          <ul className="mt-1.5 space-y-1">
            {warnings.map((w, i) => (
              <li key={`${w.code}-${i}`} className="break-words text-sm opacity-90">
                {w.message}
              </li>
            ))}
          </ul>
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss warnings"
          className={`rounded-md p-1 text-amber-300/80 transition-colors hover:text-amber-100 ${focusRing}`}
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </section>
  );
}
