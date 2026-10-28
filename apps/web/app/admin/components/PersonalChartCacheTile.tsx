import { Card } from "@/components/ui/Card";
import { formatBytes } from "./format";
import type { PersonalChartCacheHealth } from "./adminTypes";

const COUNTERS = ["hit", "miss", "entries", "bytes", "reserved_bytes"] as const;
const MAX_BYTES = 64 * 1024 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function count(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

/** Missing, partial or malformed reporting must never look like an OFF cache. */
export function readPersonalChartCache(value: unknown): PersonalChartCacheHealth | null {
  if (!record(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, "enabled")
    || !Object.hasOwn(value, "counters") || typeof value.enabled !== "boolean") return null;
  if (!value.enabled) return value.counters === null ? { enabled: false, counters: null } : null;
  const raw = value.counters;
  if (!record(raw) || Object.keys(raw).length !== COUNTERS.length || !COUNTERS.every(key => Object.hasOwn(raw, key))) return null;
  const { hit, miss, entries, bytes, reserved_bytes: reserved } = raw;
  if (!count(hit) || !count(miss) || !count(entries, 512) || !count(bytes, MAX_BYTES)
    || !count(reserved, MAX_BYTES) || bytes + reserved > MAX_BYTES) return null;
  return { enabled: true, counters: { hit, miss, entries, bytes, reserved_bytes: reserved } };
}

/** Uses only the existing health answer: no request, timer, toggle or activation. */
export function PersonalChartCacheTile({ snapshot }: { snapshot: unknown }) {
  const value = readPersonalChartCache(snapshot);
  return <Card aria-labelledby="personal-chart-cache-heading" padded={false} className="space-y-3 p-4">
    <h3 id="personal-chart-cache-heading" className="text-caption font-semibold uppercase tracking-wider text-text-dim">Personal chart cache</h3>
    <p role="status" className="text-2xl font-semibold text-text">{value ? value.enabled ? "Enabled" : "Off" : "Not reported"}</p>
    {!value ? <p className="text-caption text-text-muted">Cache status is unavailable from this API response.</p>
      : !value.enabled ? <p className="text-caption text-text-muted">Personal chart requests use the normal API path. Cache activity figures are hidden while it is off.</p>
        : <>
          <dl className="grid grid-cols-2 gap-3 text-caption">
            <Figure label="Cache hits" value={String(value.counters.hit)} />
            <Figure label="Cache misses" value={String(value.counters.miss)} />
            <Figure label="Stored entries" value={String(value.counters.entries)} />
            <Figure label="Accounted bytes" value={formatBytes(value.counters.bytes)} />
            <Figure label="Reserved bytes" value={formatBytes(value.counters.reserved_bytes)} />
          </dl>
          <p className="text-caption text-text-muted">Counts are for this API process since restart. Bytes account for cache storage and reservations, not total process memory.</p>
        </>}
  </Card>;
}

function Figure({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><dt className="text-text-muted">{label}</dt><dd className="break-words font-mono tabular-nums text-text">{value}</dd></div>;
}
