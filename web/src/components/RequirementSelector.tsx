// Toggle chips for linking an item to requirements (used by the add-question
// and add-flashcard forms).

import type { Requirement } from '@contracts';
import { Chip, focusRing } from './primitives';

export function RequirementSelector({
  requirements,
  selected,
  onChange,
  ariaLabel = 'Covered requirements',
}: {
  requirements: Requirement[];
  selected: string[];
  onChange: (ids: string[]) => void;
  ariaLabel?: string;
}) {
  if (requirements.length === 0) {
    return <p className="text-xs text-slate-500">No requirements were extracted from this posting.</p>;
  }
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label={ariaLabel}>
      {requirements.map((r) => {
        const active = selected.includes(r.id);
        return (
          <li key={r.id}>
            <button
              type="button"
              aria-pressed={active}
              onClick={() =>
                onChange(active ? selected.filter((id) => id !== r.id) : [...selected, r.id])
              }
              title={`${r.id}: ${r.text} (${r.priority})`}
              className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${focusRing} ${
                active
                  ? 'border-indigo-400 bg-indigo-500/20 text-indigo-200'
                  : 'border-slate-700 bg-slate-900 text-slate-400 hover:border-slate-500 hover:text-slate-200'
              }`}
            >
              {r.id}
              <span className="ml-1 text-[10px] uppercase opacity-70">
                {r.priority === 'must' ? 'must' : 'nice'}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
