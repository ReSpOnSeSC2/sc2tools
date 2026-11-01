/** Per-viewer recent destinations: static pages and opponent dossiers. No catalogs, auth, network or module-level owner state. */
export const COMMAND_SEARCH_RECENT_KEY = "sc2tools:palette-recent:v1";
export const COMMAND_SEARCH_RECENT_MAX = 8;
/** Dossier entries show, and record, only where the navigation lists this key. */
export const COMMAND_SEARCH_RECENT_DOSSIERS = "opponents";
export type CommandRecentStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type CommandRecentEntry = Readonly<{ kind: "page"; id: string } | { kind: "opponent"; pulseId: string }>;
// Version 1 stored {version: 1, viewer, ids}; version 2 stores {version: 2, viewer, entries},
// newest first, and every write is version 2 (ADR 0069, 2026-11-01 amendment).
type RecentEnvelope = { viewer: string; entries: CommandRecentEntry[] };
type RecentRead = { kind: "ok"; envelope: RecentEnvelope } | { kind: "missing" | "invalid" | "error" };
const STORAGE_CHARS_MAX = 2_048;
const ALLOWED_IDS_MAX = 128;

function validViewer(viewer: unknown): viewer is string {
  return typeof viewer === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(viewer) && !/\s/.test(viewer);
}

function staticId(id: unknown): id is string {
  return typeof id === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(id) && !/\s/.test(id);
}

/** Toon-handle pulse IDs only, so a crafted dossier link's text never reaches storage. Example: "1-S2-1-267727". */
export function isDossierPulseId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && /^\d+-S2-\d+-\d+$/.test(value);
}

function entryKey(entry: CommandRecentEntry): string {
  return entry.kind === "page" ? `page:${entry.id}` : `opponent:${entry.pulseId}`;
}

function admittedIds(allowed: readonly string[]): ReadonlySet<string> {
  return new Set(allowed.length <= ALLOWED_IDS_MAX ? allowed.filter(staticId) : []);
}

function admits(entry: CommandRecentEntry, admitted: ReadonlySet<string>): boolean {
  return admitted.has(entry.kind === "page" ? entry.id : COMMAND_SEARCH_RECENT_DOSSIERS);
}

function browserStorage(injected?: CommandRecentStorage): CommandRecentStorage | null {
  if (injected) return injected;
  try { return typeof window === "undefined" ? null : window.localStorage; }
  catch { return null; }
}

function decodeEntry(value: unknown): CommandRecentEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>, keys = Object.keys(record).sort().join(",");
  if (keys === "id,kind" && record.kind === "page" && staticId(record.id)) return { kind: "page", id: record.id };
  if (keys === "kind,pulseId" && record.kind === "opponent" && isDossierPulseId(record.pulseId)) {
    return { kind: "opponent", pulseId: record.pulseId };
  }
  return null;
}

/** Any bad, repeated or extra part rejects the whole list. */
function storedEntries(value: unknown, version: 1 | 2): CommandRecentEntry[] | null {
  if (!Array.isArray(value) || value.length > COMMAND_SEARCH_RECENT_MAX) return null;
  const entries = value.map((item: unknown) => version === 2 ? decodeEntry(item)
    : staticId(item) ? { kind: "page" as const, id: item } : null);
  if (!entries.every((entry): entry is CommandRecentEntry => entry !== null)) return null;
  return new Set(entries.map(entryKey)).size === entries.length ? entries : null;
}

function decodeEnvelope(value: unknown): RecentEnvelope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>, keys = Object.keys(record).sort().join(",");
  if (!validViewer(record.viewer)) return null;
  const entries = record.version === 1 && keys === "ids,version,viewer" ? storedEntries(record.ids, 1)
    : record.version === 2 && keys === "entries,version,viewer" ? storedEntries(record.entries, 2) : null;
  return entries ? { viewer: record.viewer, entries } : null;
}

function readEnvelope(storage: CommandRecentStorage): RecentRead {
  let raw: string | null;
  try { raw = storage.getItem(COMMAND_SEARCH_RECENT_KEY); }
  catch { return { kind: "error" }; }
  if (raw === null) return { kind: "missing" };
  if (typeof raw !== "string" || raw.length > STORAGE_CHARS_MAX) return { kind: "invalid" };
  try {
    const envelope = decodeEnvelope(JSON.parse(raw));
    return envelope ? { kind: "ok", envelope } : { kind: "invalid" };
  } catch { return { kind: "invalid" }; }
}

function viewerEntries(read: RecentRead, viewer: string): CommandRecentEntry[] {
  return read.kind === "ok" && read.envelope.viewer === viewer ? [...read.envelope.entries] : [];
}

const pageIds = (entries: readonly CommandRecentEntry[]) => entries.flatMap(entry => entry.kind === "page" ? [entry.id] : []);

/** This viewer's admitted entries in visit order, newest first. Pages this navigation does not
 * list, and dossiers where it lists no Opponents, stay stored but hidden. Never writes.
 * Example: readCommandSearchRecentEntries(viewer, ["today", "opponents"]). */
export function readCommandSearchRecentEntries(
  viewer: string | null, allowed: readonly string[], storage?: CommandRecentStorage,
): CommandRecentEntry[] {
  if (!validViewer(viewer)) return [];
  const target = browserStorage(storage);
  if (!target) return [];
  const admitted = admittedIds(allowed);
  return viewerEntries(readEnvelope(target), viewer).filter(entry => admits(entry, admitted));
}

/** Reads only this viewer's admitted static NAV_ENTRY keys; keys this page does not admit stay stored.
 * Example: readCommandSearchRecent(viewer, ["today"]). */
export function readCommandSearchRecent(
  viewer: string | null, allowed: readonly string[], storage?: CommandRecentStorage,
): string[] {
  return pageIds(readCommandSearchRecentEntries(viewer, allowed, storage));
}

/** Moves one admitted entry to the front, at most eight, keeping this viewer's other stored
 * entries even when the current page does not list them. Null when nothing was written. */
function recordEntry(viewer: string, entry: CommandRecentEntry, allowed: readonly string[],
  storage?: CommandRecentStorage): CommandRecentEntry[] | null {
  if (!admits(entry, admittedIds(allowed))) return null;
  const target = browserStorage(storage);
  if (!target) return null;
  const read = readEnvelope(target);
  if (read.kind === "error") return null;
  const key = entryKey(entry);
  const entries = [entry, ...viewerEntries(read, viewer).filter(value => entryKey(value) !== key)].slice(0, COMMAND_SEARCH_RECENT_MAX);
  const raw = JSON.stringify({ version: 2, viewer, entries });
  if (raw.length > STORAGE_CHARS_MAX) return null;
  try { target.setItem(COMMAND_SEARCH_RECENT_KEY, raw); return entries; }
  catch { return null; }
}

/** Records a visit to one admitted static key; returns this viewer's stored page keys.
 * Example: recordCommandSearchRecent(viewer, "today", ids). */
export function recordCommandSearchRecent(
  viewer: string | null, id: string, allowed: readonly string[], storage?: CommandRecentStorage,
): string[] {
  if (!validViewer(viewer) || !staticId(id)) return [];
  return pageIds(recordEntry(viewer, { kind: "page", id }, allowed, storage) ?? []);
}

/** Records an opened dossier by its pulse ID only, where the navigation lists Opponents.
 * Example: recordCommandSearchRecentOpponent(viewer, "1-S2-1-267727", ids). */
export function recordCommandSearchRecentOpponent(
  viewer: string | null, pulseId: string, allowed: readonly string[], storage?: CommandRecentStorage,
): boolean {
  if (!validViewer(viewer) || !isDossierPulseId(pulseId)) return false;
  return recordEntry(viewer, { kind: "opponent", pulseId }, allowed, storage) !== null;
}

/** Removes only the current matching viewer envelope, of either version. Example: clearCommandSearchRecent(signedOutViewer). */
export function clearCommandSearchRecent(viewer: string | null, storage?: CommandRecentStorage): boolean {
  if (!validViewer(viewer)) return false;
  const target = browserStorage(storage);
  if (!target) return false;
  const read = readEnvelope(target);
  if (read.kind !== "ok" || read.envelope.viewer !== viewer) return false;
  try { target.removeItem(COMMAND_SEARCH_RECENT_KEY); return true; }
  catch { return false; }
}
