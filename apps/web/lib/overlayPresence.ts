import rules from "./overlayPresenceRules.json";
export type PresenceBucket = { count: number; oldestConnectedAt: string | null };
export type OverlayPresence = { surfaces: Record<string, PresenceBucket>; widgets: Record<string, PresenceBucket>; scenes: Record<string, PresenceBucket>; totalSources: number; agent: { online: boolean }; lastLiveAt: string | null; sampledAt: string };
export function presenceCount(value: unknown): number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 100_000 ? value : 0; }
const record = (raw: unknown): Record<string, unknown> => raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
function buckets(raw: unknown): Record<string, PresenceBucket> {
  return Object.fromEntries(Object.entries(record(raw)).slice(0, 64).filter(([id]) => /^[a-z0-9-]{1,64}$/.test(id)).map(([id, raw]) => {
    const value = record(raw), at = value.oldestConnectedAt;
    return [id, { count: presenceCount(value.count), oldestConnectedAt: typeof at === "string" && Number.isFinite(Date.parse(at)) ? at : null }];
  }));
}
export function normalizePresence(raw: unknown): OverlayPresence | null {
  const value = record(raw);
  if (!value.surfaces || typeof value.sampledAt !== "string" || !Number.isFinite(Date.parse(value.sampledAt))) return null;
  return { surfaces: buckets(value.surfaces), widgets: buckets(value.widgets), scenes: buckets(value.scenes), totalSources: presenceCount(value.totalSources), agent: { online: record(value.agent).online === true }, lastLiveAt: typeof value.lastLiveAt === "string" && Number.isFinite(Date.parse(value.lastLiveAt)) ? value.lastLiveAt : null, sampledAt: value.sampledAt };
}
export function widgetPresence(snapshot: OverlayPresence, id: string, enabled: boolean) {
  const count = (snapshot.widgets[id]?.count ?? 0) + (enabled && id !== "ghost-build" ? snapshot.surfaces["all-in-one"]?.count ?? 0 : 0);
  const audio = enabled && rules.audioWidgets.includes(id) && count > 1;
  return { count, audio, unknown: !count && (snapshot.surfaces.unknown?.count ?? 0) > 0 };
}
