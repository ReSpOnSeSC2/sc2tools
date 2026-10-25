/** A held pre-reset fanout can arrive after the fresh session event. Once an
 * anchor is known, neither a legacy nor an older snapshot can restore it. */
export function newerSession<T extends { sessionAnchorAt?: string }>(current: T | null, next: T): T {
  const before = typeof current?.sessionAnchorAt === "string" ? Date.parse(current.sessionAnchorAt) : 0;
  const after = typeof next.sessionAnchorAt === "string" ? Date.parse(next.sessionAnchorAt) : 0;
  return current && Number.isFinite(before) && before > 0 && (!Number.isFinite(after) || after < before) ? current : next;
}
