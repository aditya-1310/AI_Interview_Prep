// Brief tab: editable summary and "what they do" (debounced PATCH), source
// links, the role breakdown with its requirements, and Regenerate brief.

import { ExternalLink } from 'lucide-react';
import type { KitRecordDoc } from '../../api/kits';
import { Chip, ConfirmButton, focusRing } from '../primitives';
import { EditableText } from '../EditableText';
import { KIND_LABELS, PRIORITY_LABELS } from '../../lib/labels';
import type { KitMutations } from '../../lib/mutations';

export function BriefTab({
  record,
  m,
  regenBusy,
}: {
  record: KitRecordDoc;
  m: KitMutations;
  regenBusy: boolean;
}) {
  const k = record.kit;
  const brief = k?.company_brief;
  const role = k?.role;
  const sources = brief?.sources ?? [];
  const pagesUsed = k?.source?.pages_used ?? [];
  const requirements = role?.requirements ?? [];

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/60 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-200">Company brief</h3>
          <ConfirmButton
            label="Regenerate"
            confirmLabel="Replace brief?"
            note="Regenerating replaces the brief text. Your edits elsewhere in the kit are kept."
            onConfirm={() => m.regenerate('brief')}
            disabled={regenBusy}
          />
        </div>

        <div>
          <h4 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">
            Summary
          </h4>
          <EditableText
            value={brief?.summary ?? ''}
            label="brief summary"
            onSave={(v) => m.patchBrief({ summary: v })}
            rows={4}
            placeholder="Click to add a summary"
            displayClassName="text-sm text-slate-300"
          />
        </div>

        <div>
          <h4 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">
            What they do
          </h4>
          <EditableText
            value={brief?.what_they_do ?? ''}
            label="what they do"
            onSave={(v) => m.patchBrief({ what_they_do: v })}
            rows={4}
            placeholder="Click to describe what the company does"
            displayClassName="text-sm text-slate-300"
          />
        </div>

        <div>
          <h4 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-500">
            Sources
          </h4>
          {sources.length > 0 ? (
            <ul className="space-y-1">
              {sources.map((s) => (
                <li key={s}>
                  <a
                    href={s}
                    target="_blank"
                    rel="noreferrer"
                    className={`inline-flex max-w-full items-center gap-1 break-all text-xs text-indigo-300 underline-offset-2 hover:underline ${focusRing} rounded`}
                  >
                    <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
                    {s}
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-slate-500">No sources were recorded for this brief.</p>
          )}
          {pagesUsed.length > 0 ? (
            <Chip className="mt-2" title={pagesUsed.join('\n')}>
              {pagesUsed.length} page{pagesUsed.length === 1 ? '' : 's'} crawled during research
            </Chip>
          ) : null}
        </div>
      </section>

      <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/60 p-5">
        <h3 className="text-sm font-semibold text-slate-200">Role breakdown</h3>
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-slate-300">{role?.title || 'Role title pending'}</p>
          {role?.seniority ? <Chip>{role.seniority}</Chip> : null}
          {k?.source?.location ? <Chip>{k.source.location}</Chip> : null}
        </div>
        {role?.responsibilities?.length ? (
          <div>
            <h4 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-500">
              Responsibilities
            </h4>
            <ul className="list-inside list-disc space-y-1 text-sm text-slate-300">
              {role.responsibilities.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <div>
          <h4 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-500">
            Requirements ({requirements.length})
          </h4>
          {requirements.length > 0 ? (
            <ul className="space-y-2">
              {requirements.map((r) => (
                <li key={r.id} className="flex flex-wrap items-baseline gap-1.5">
                  <Chip
                    className={
                      r.priority === 'must'
                        ? 'border-indigo-500/50 bg-indigo-500/15 text-indigo-300'
                        : undefined
                    }
                    title={`${r.priority === 'must' ? PRIORITY_LABELS.must : PRIORITY_LABELS.nice} · ${KIND_LABELS[r.kind]}`}
                  >
                    {r.id}
                  </Chip>
                  <span className="min-w-0 flex-1 text-sm text-slate-300">{r.text}</span>
                  <Chip>{KIND_LABELS[r.kind]}</Chip>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-slate-500">
              Nothing was extracted from this posting — it may be very short.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
