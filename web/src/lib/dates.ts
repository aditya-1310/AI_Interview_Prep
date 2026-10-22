// Human-readable date formatting via Intl (no date library).

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const dateTimeFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const relativeFmt = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

function parse(iso?: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDate(iso?: string | null): string {
  const d = parse(iso);
  return d ? dateFmt.format(d) : '—';
}

export function formatDateTime(iso?: string | null): string {
  const d = parse(iso);
  return d ? dateTimeFmt.format(d) : '—';
}

/** "3 hours ago" style text; falls back to the formatted date. */
export function formatRelative(iso?: string | null): string {
  const d = parse(iso);
  if (!d) return 'never';
  const seconds = Math.round((d.getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return relativeFmt.format(seconds, 'second');
  if (abs < 3600) return relativeFmt.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return relativeFmt.format(Math.round(seconds / 3600), 'hour');
  if (abs < 30 * 86_400) return relativeFmt.format(Math.round(seconds / 86_400), 'day');
  return dateFmt.format(d);
}
