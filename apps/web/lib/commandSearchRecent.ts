/** Lightweight static destination history. No catalogs, auth, network or module-level owner state. */
export const COMMAND_SEARCH_RECENT_KEY = "sc2tools:palette-recent:v1";
export const COMMAND_SEARCH_RECENT_MAX = 8;
export type CommandRecentStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type RecentEnvelope = { version: 1; viewer: string; ids: string[] };
type RecentRead = { kind: "ok"; envelope: RecentEnvelope } | { kind: "missing" | "invalid" | "error" };
const STORAGE_CHARS_MAX = 2_048;
const ALLOWED_IDS_MAX = 128;

function validViewer(viewer: unknown): viewer is string {
  return typeof viewer === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(viewer) && !/\s/.test(viewer);
}

function staticId(id: unknown): id is string {
  return typeof id === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(id) && !/\s/.test(id);
}

function admittedIds(allowed: readonly string[]): ReadonlySet<string> {
  return new Set(allowed.length <= ALLOWED_IDS_MAX ? allowed.filter(staticId) : []);
}

function browserStorage(injected?: CommandRecentStorage): CommandRecentStorage | null {
  if (injected) return injected;
  try { return typeof window === "undefined" ? null : window.localStorage; }
  catch { return null; }
}

function storedIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > COMMAND_SEARCH_RECENT_MAX) return null;
  if (!value.every(staticId) || new Set(value).size !== value.length) return null;
  return value;
}

function decodeEnvelope(value: unknown): RecentEnvelope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.keys(value).sort().join(",") !== "ids,version,viewer") return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !validViewer(record.viewer)) return null;
  const ids = storedIds(record.ids);
  return ids ? { version: 1, viewer: record.viewer, ids } : null;
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

function viewerIds(read: RecentRead, viewer: string): string[] {
  return read.kind === "ok" && read.envelope.viewer === viewer ? [...read.envelope.ids] : [];
}

/** Reads only this viewer's admitted static NAV_ENTRY keys; keys this page does not admit stay stored.
 * Example: readCommandSearchRecent(viewer, ["today"]). */
export function readCommandSearchRecent(
  viewer: string | null, allowed: readonly string[], storage?: CommandRecentStorage,
): string[] {
  if (!validViewer(viewer)) return [];
  const target = browserStorage(storage);
  if (!target) return [];
  const admitted = admittedIds(allowed);
  return viewerIds(readEnvelope(target), viewer).filter(id => admitted.has(id));
}

/** Moves one admitted static key to the front, at most eight, keeping this
 * viewer's other stored keys even when the current page does not list them.
 * Example: recordCommandSearchRecent(viewer, "today", ids). */
export function recordCommandSearchRecent(
  viewer: string | null, id: string, allowed: readonly string[], storage?: CommandRecentStorage,
): string[] {
  if (!validViewer(viewer) || !staticId(id)) return [];
  const admitted = admittedIds(allowed);
  if (!admitted.has(id)) return [];
  const target = browserStorage(storage);
  if (!target) return [];
  const read = readEnvelope(target);
  if (read.kind === "error") return [];
  const previous = viewerIds(read, viewer);
  const ids = [id, ...previous.filter(value => value !== id)].slice(0, COMMAND_SEARCH_RECENT_MAX);
  try {
    target.setItem(COMMAND_SEARCH_RECENT_KEY, JSON.stringify({ version: 1, viewer, ids }));
    return ids;
  } catch { return []; }
}

/** Removes only the current matching viewer envelope. Example: clearCommandSearchRecent(signedOutViewer). */
export function clearCommandSearchRecent(viewer: string | null, storage?: CommandRecentStorage): boolean {
  if (!validViewer(viewer)) return false;
  const target = browserStorage(storage);
  if (!target) return false;
  const read = readEnvelope(target);
  if (read.kind !== "ok" || read.envelope.viewer !== viewer) return false;
  try { target.removeItem(COMMAND_SEARCH_RECENT_KEY); return true; }
  catch { return false; }
}
