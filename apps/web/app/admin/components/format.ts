/**
 * Display helpers shared across admin tabs. Keep them pure (no DOM,
 * no hooks) so they're testable + import-cheap.
 */

const BYTE_UNITS = ["B", "kB", "MB", "GB", "TB"] as const;

/**
 * Render a byte count using metric units (1 kB = 1000 B), matching
 * how Atlas renders storage in its UI. We deliberately do NOT use
 * binary (KiB) — the admin dashboard's purpose is to compare
 * against the same numbers an admin sees in Atlas, so unit choice
 * has to match.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : value < 10 ? 2 : value < 100 ? 1 : 0;
  return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`;
}

/**
 * Human-readable time-since timestamp. Used in the Users list to
 * show "last seen 4d ago" etc. Returns "—" for null / invalid.
 */
export function timeSince(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

/**
 * Compact integer formatter — e.g. 13456 → "13.5k". Used in dense
 * tables where exact counts aren't useful but order-of-magnitude is.
 */
export function compactNumber(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) < 1000) return String(n);
  if (Math.abs(n) < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  if (Math.abs(n) < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

/**
 * Compose the success line for a "Rebuild opponents" call. Pre-
 * May-2026 the response only carried ``droppedRows``; the admin
 * tool now ALSO chains a SC2Pulse character-id backfill so the
 * summary surfaces the heal counters when any rows were touched.
 *
 * Returns a one-line string suitable for the existing
 * ``ResultLine`` render path — no JSX, no DOM, easy to unit-test
 * and easy to reuse from any of the three rebuild buttons (admin
 * tools page rebuilds-me + targeted-user, plus the per-user detail
 * page).
 */
export function formatRebuildSummary(resp: {
  userId: string;
  droppedRows: number;
  pulseBackfill?: {
    scanned: number;
    resolved: number;
    updated: number;
    skipped: number;
  } | null;
}): string {
  const head = `Rebuilt opponents for ${resp.userId} — dropped ${resp.droppedRows} rows.`;
  const heal = resp.pulseBackfill;
  if (!heal) return head;
  // Hide the heal phrase entirely when nothing was touched —
  // keeps the success line short on the common "nothing was
  // stuck" path.
  if (heal.scanned === 0 && heal.resolved === 0) return head;
  const parts: string[] = [];
  parts.push(`scanned ${heal.scanned}`);
  parts.push(`resolved ${heal.resolved}`);
  if (heal.skipped > 0) parts.push(`skipped ${heal.skipped}`);
  return `${head} Pulse heal: ${parts.join(", ")}.`;
}

/**
 * Friendly seconds-to-duration. Used for the Health tab uptime row.
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m ${seconds % 60}s`;
  return `${seconds}s`;
}
