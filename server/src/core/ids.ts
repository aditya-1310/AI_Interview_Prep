// Stable id allocation inside a kit: r1..rN / q1..qN / f1..fN.

const ID_RE = /^(r|q|f)(\d+)$/;

function maxSuffix(ids: string[], prefix: 'r' | 'q' | 'f'): number {
  let max = 0;
  for (const id of ids) {
    const m = ID_RE.exec(id);
    if (m && m[1] === prefix) max = Math.max(max, parseInt(m[2], 10));
  }
  return max;
}

export function nextId(prefix: 'r' | 'q' | 'f', existingIds: string[]): string {
  return `${prefix}${maxSuffix(existingIds, prefix) + 1}`;
}

/** Numeric-aware comparison so q2 sorts before q10. */
export function compareIds(a: string, b: string): number {
  const ma = ID_RE.exec(a);
  const mb = ID_RE.exec(b);
  if (ma && mb && ma[1] === mb[1]) return parseInt(ma[2], 10) - parseInt(mb[2], 10);
  return a < b ? -1 : a > b ? 1 : 0;
}
