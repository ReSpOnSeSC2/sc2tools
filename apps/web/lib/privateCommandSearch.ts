import { API_BASE } from "./clientApi";

// This leaf belongs to the intent-loaded command runtime. It has no retained
// response cache, storage, analytics, public-query normalization or navigation.
export const PRIVATE_COMMAND_SEARCH_PATH = "/v1/search/quick";
export const PRIVATE_COMMAND_SEARCH_BYTES = 64 * 1024;
export const PRIVATE_COMMAND_SEARCH_DEBOUNCE_MS = 200;
export const PRIVATE_COMMAND_SEARCH_TIMEOUT_MS = 5_000;
export const PRIVATE_COMMAND_SEARCH_REASONS = [
  "source_budget_exceeded", "invalid_data", "deferred", "missing_access_path", "deadline", "busy", "retired",
] as const;

export type PrivateSearchUnavailableReason = typeof PRIVATE_COMMAND_SEARCH_REASONS[number];
export type PrivateSearchOpponent = Readonly<{
  pulseId: string; displayNameSample: string; race: string | null; lastSeen: string | null;
}>;
export type PrivateSearchBuild = Readonly<{
  slug: string; name: string; race: string | null; vsRace: string | null;
  perspective: string | null; updatedAt: string | null;
}>;
export type PrivateSearchMap = Readonly<{ map: string }>;
export type PrivateSearchGroup<T> = Readonly<
  | { status: "ready"; items: readonly T[]; hasMore: boolean }
  | { status: "unavailable"; items: readonly []; hasMore: null; reason: PrivateSearchUnavailableReason }
>;
export type PrivateCommandSearchResponse = Readonly<{
  version: 2;
  groups: Readonly<{
    opponents: PrivateSearchGroup<PrivateSearchOpponent>;
    customBuilds: PrivateSearchGroup<PrivateSearchBuild>;
    maps: PrivateSearchGroup<PrivateSearchMap>;
  }>;
}>;
export type PrivateCommandTarget = Readonly<
  | { kind: "opponent"; pulseId: string }
  | { kind: "customBuild"; slug: string }
  | { kind: "map"; map: string }
  | { kind: "game"; gameId: string }
>;
export type PrivateCommandChoice = Readonly<{
  group: "opponents" | "customBuilds" | "maps" | "games";
  label: string;
  target: PrivateCommandTarget;
  href: string;
  /** Recent games only: map, result and date, and the matchup badge. */
  description?: string;
  matchup?: string;
}>;
export type PrivateCommandSearchErrorCode =
  | "invalid_query" | "authentication_required" | "invalid_response"
  | "response_too_large" | "unavailable" | "request_timeout";

export class PrivateCommandSearchError extends Error {
  constructor(readonly code: PrivateCommandSearchErrorCode) {
    super("Private search is unavailable. Try again.");
    this.name = "PrivateCommandSearchError";
  }
}
const invalid = (): never => { throw new PrivateCommandSearchError("invalid_response"); };
const abortError = () => new DOMException("Private search is no longer current.", "AbortError");

export function safeText(value: unknown, maximumUnits: number, allowEmpty = false): value is string {
  if (typeof value !== "string" || value.length > maximumUnits || (!allowEmpty && !value.length)
    || /\p{Cc}/u.test(value)) return false;
  for (const point of value) {
    const unit = point.charCodeAt(0);
    if (point.length === 1 && unit >= 0xd800 && unit <= 0xdfff) return false;
  }
  return true;
}
export function safeId(value: unknown, maximumUnits: number): value is string {
  return safeText(value, maximumUnits) && value !== "." && value !== "..";
}

/** Only outer whitespace is removed. Interior case, accents and spaces remain
 * literal; public normalizeCommandQuery/searchCommands must never process q. */
export function privateCommandQuery(raw: unknown): string | null {
  if (typeof raw !== "string" || !safeText(raw, raw.length)) return null;
  const query = raw.trim();
  if (query.length > 160) return null;
  const points = Array.from(query).length;
  return points >= 2 && points <= 80 && new TextEncoder().encode(query).byteLength <= 320 ? query : null;
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some(key => typeof key !== "string" || !keys.includes(key))) return invalid();
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return invalid();
    copy[key] = descriptor.value;
  }
  return copy;
}
function denseArray(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return invalid();
  const expected = ["length", ...Array.from({ length: value.length }, (_, index) => String(index))];
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length || keys.some(key => typeof key !== "string" || !expected.includes(key))) return invalid();
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return invalid();
    return descriptor.value as unknown;
  });
}
function optionalText(value: unknown): string | null {
  if (value === null) return null;
  return safeText(value, 16, true) ? value : invalid();
}
function nullableDate(value: unknown): string | null {
  if (value === null) return null;
  if (!safeText(value, 32)) return invalid();
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) return invalid();
  return value;
}
function opponent(value: unknown): PrivateSearchOpponent {
  const row = exactRecord(value, ["pulseId", "displayNameSample", "race", "lastSeen"]);
  if (!safeId(row.pulseId, 64) || !safeText(row.displayNameSample, 200)) return invalid();
  return Object.freeze({ pulseId: row.pulseId, displayNameSample: row.displayNameSample,
    race: optionalText(row.race), lastSeen: nullableDate(row.lastSeen) });
}
function customBuild(value: unknown): PrivateSearchBuild {
  const row = exactRecord(value, ["slug", "name", "race", "vsRace", "perspective", "updatedAt"]);
  if (!safeId(row.slug, 120) || !safeText(row.name, 200)) return invalid();
  return Object.freeze({ slug: row.slug, name: row.name, race: optionalText(row.race),
    vsRace: optionalText(row.vsRace), perspective: optionalText(row.perspective), updatedAt: nullableDate(row.updatedAt) });
}
function mapRow(value: unknown): PrivateSearchMap {
  const row = exactRecord(value, ["map"]);
  if (!safeText(row.map, 200)) return invalid();
  return Object.freeze({ map: row.map });
}

// Validate the server's order without sorting or scoring it. Mongo simple
// collation compares UTF-8 bytes, including astral characters, rather than UTF-16.
function keyOrder(left: string, right: string): number {
  const encoder = new TextEncoder(), a = encoder.encode(left), b = encoder.encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}
function group<T>(value: unknown, row: (value: unknown) => T,
  identity: (value: T) => string, date?: (value: T) => string | null): PrivateSearchGroup<T> {
  const status = value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "status") : undefined;
  if (!status || !Object.hasOwn(status, "value")) return invalid();
  if (status.value === "unavailable") {
    const dto = exactRecord(value, ["status", "items", "hasMore", "reason"]);
    if (dto.hasMore !== null || denseArray(dto.items, 0).length !== 0
      || !PRIVATE_COMMAND_SEARCH_REASONS.some(reason => reason === dto.reason)) return invalid();
    return Object.freeze({ status: "unavailable", items: Object.freeze([]) as readonly [],
      hasMore: null, reason: dto.reason as PrivateSearchUnavailableReason });
  }
  if (status.value !== "ready") return invalid();
  const dto = exactRecord(value, ["status", "items", "hasMore"]), items = denseArray(dto.items, 8).map(row);
  if (typeof dto.hasMore !== "boolean" || (dto.hasMore && items.length !== 8)) return invalid();
  const seen = new Set<string>();
  for (let index = 0; index < items.length; index += 1) {
    const key = identity(items[index]);
    if (seen.has(key)) return invalid();
    seen.add(key);
    if (!index) continue;
    const previous = items[index - 1], before = date?.(previous) ?? null, after = date?.(items[index]) ?? null;
    if ((before === null && after !== null)
      || (before !== null && after !== null && Date.parse(before) < Date.parse(after))
      || (before === after && keyOrder(identity(previous), key) > 0)) return invalid();
  }
  return Object.freeze({ status: "ready", items: Object.freeze(items), hasMore: dto.hasMore });
}

/** Strict wire DTO v2; no hrefs, query echo, counters, extra keys or partial
 * unavailable rows are accepted. The whole validated DTO is bounded as well. */
export function decodePrivateCommandSearch(value: unknown): PrivateCommandSearchResponse {
  const root = exactRecord(value, ["version", "groups"]);
  if (root.version !== 2) return invalid();
  const groups = exactRecord(root.groups, ["opponents", "customBuilds", "maps"]);
  const response = Object.freeze({ version: 2 as const, groups: Object.freeze({
    opponents: group(groups.opponents, opponent, item => item.pulseId, item => item.lastSeen),
    customBuilds: group(groups.customBuilds, customBuild, item => item.slug, item => item.updatedAt),
    maps: group(groups.maps, mapRow, item => item.map),
  }) });
  if (new TextEncoder().encode(JSON.stringify(response)).byteLength > PRIVATE_COMMAND_SEARCH_BYTES) return invalid();
  return response;
}

/** Construct only category-specific internal destinations from validated IDs.
 * This does not navigate; eventual selection must use the Settings dirty guard. */
export function privateCommandHref(value: PrivateCommandTarget): string {
  const kind = value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "kind") : undefined;
  if (!kind || !Object.hasOwn(kind, "value")) return invalid();
  if (kind.value === "opponent") {
    const target = exactRecord(value, ["kind", "pulseId"]);
    if (!safeId(target.pulseId, 64)) return invalid();
    return `/app/opponents/${encodeURIComponent(target.pulseId)}`;
  }
  if (kind.value === "customBuild") {
    const target = exactRecord(value, ["kind", "slug"]);
    if (!safeId(target.slug, 120)) return invalid();
    return `/builds/${encodeURIComponent(target.slug)}`;
  }
  if (kind.value === "game") {
    const target = exactRecord(value, ["kind", "gameId"]);
    if (!safeId(target.gameId, 200)) return invalid();
    return `/app/game/${encodeURIComponent(target.gameId)}`;
  }
  const target = exactRecord(value, ["kind", "map"]);
  if (target.kind !== "map" || !safeText(target.map, 200)) return invalid();
  return `/app/maps?focus=${encodeURIComponent(target.map)}`;
}
export function privateCommandChoices(response: PrivateCommandSearchResponse): readonly PrivateCommandChoice[] {
  const choices: PrivateCommandChoice[] = [];
  function append(group: PrivateCommandChoice["group"], label: string, target: PrivateCommandTarget) {
    const frozenTarget = Object.freeze(target);
    choices.push(Object.freeze({ group, label, target: frozenTarget, href: privateCommandHref(frozenTarget) }));
  }
  if (response.groups.opponents.status === "ready") for (const item of response.groups.opponents.items) {
    append("opponents", item.displayNameSample, { kind: "opponent", pulseId: item.pulseId });
  }
  if (response.groups.customBuilds.status === "ready") for (const item of response.groups.customBuilds.items) {
    append("customBuilds", item.name, { kind: "customBuild", slug: item.slug });
  }
  if (response.groups.maps.status === "ready") for (const item of response.groups.maps.items) {
    append("maps", item.map, { kind: "map", map: item.map });
  }
  return Object.freeze(choices);
}

export function cancelBody(response: Response): void {
  try { void response.body?.cancel().catch(() => undefined); } catch { /* Already locked or retired. */ }
}
export function abortable<T>(promise: Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cancel = () => {
      if (settled) return;
      settled = true; signal.removeEventListener("abort", cancel); reject(abortError());
    };
    signal.addEventListener("abort", cancel, { once: true });
    promise.then(value => {
      if (settled) { late?.(value); return; }
      settled = true; signal.removeEventListener("abort", cancel); resolve(value);
    }, error => {
      if (settled) return;
      settled = true; signal.removeEventListener("abort", cancel); reject(error);
    });
    if (signal.aborted) cancel();
  });
}
/** Reads at most PRIVATE_COMMAND_SEARCH_BYTES of strict UTF-8 JSON, checking currency at every await. */
export async function boundedJson(response: Response, signal: AbortSignal, assertCurrent: () => void): Promise<unknown> {
  if (!response.body) return invalid();
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  const parts: string[] = []; let bytes = 0, consumed = false;
  const cancel = () => { try { void reader.cancel().catch(() => undefined); } catch { /* Already retired. */ } };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      assertCurrent();
      const next = await abortable(reader.read(), signal);
      assertCurrent();
      if (next.done) break;
      // A native Response may provide another realm's Uint8Array (including
      // Undici under jsdom). Use the intrinsic brand, never instanceof or a
      // spoofable own Symbol.toStringTag, while retaining the raw byte bound.
      const brand = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)?.get;
      if (!ArrayBuffer.isView(next.value) || brand?.call(next.value) !== "Uint8Array") return invalid();
      bytes += next.value.byteLength;
      if (bytes > PRIVATE_COMMAND_SEARCH_BYTES) throw new PrivateCommandSearchError("response_too_large");
      parts.push(decoder.decode(next.value, { stream: true }));
    }
    parts.push(decoder.decode());
    assertCurrent();
    const value: unknown = JSON.parse(parts.join("")); consumed = true; return value;
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!consumed) cancel();
    try { reader.releaseLock(); } catch { /* A retired adapter can retain its read. */ }
  }
}
/** The absolute URL of a fixed API path on a plain http(s) API base. */
export function apiEndpoint(path: string): string {
  const base = new URL(API_BASE);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) return invalid();
  return new URL(`${API_BASE.replace(/\/+$/, "")}${path}`).href;
}

/** Must run inside useOwnerRequestScope. The assertion additionally owns the
 * query/opening/route epoch, and runs before/after every asynchronous boundary. */
export async function requestPrivateCommandSearch(query: string, getToken: () => Promise<string | null>,
  signal: AbortSignal, assertCurrent: () => void): Promise<PrivateCommandSearchResponse> {
  let response: Response | undefined;
  try {
    assertCurrent();
    if (privateCommandQuery(query) !== query) throw new PrivateCommandSearchError("invalid_query");
    const token = await getToken();
    assertCurrent();
    if (!token) throw new PrivateCommandSearchError("authentication_required");
    const url = apiEndpoint(PRIVATE_COMMAND_SEARCH_PATH);
    response = await abortable(fetch(url, {
      method: "POST", body: JSON.stringify({ q: query }),
      headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${token}` },
      credentials: "omit", cache: "no-store", redirect: "error", signal,
    }), signal, cancelBody);
    assertCurrent();
    if (response.status !== 200) throw new PrivateCommandSearchError("unavailable");
    if (response.redirected || response.url !== url
      || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") return invalid();
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) return invalid();
    if (length !== null && Number(length) > PRIVATE_COMMAND_SEARCH_BYTES) throw new PrivateCommandSearchError("response_too_large");
    const raw = await boundedJson(response, signal, assertCurrent);
    assertCurrent();
    return decodePrivateCommandSearch(raw);
  } catch (error) {
    if (response && !response.body?.locked) cancelBody(response);
    if (signal.aborted || (error instanceof Error && error.name === "AbortError")) throw abortError();
    if (error instanceof PrivateCommandSearchError) throw error;
    // Never expose a provider/JSON error body, URL, q, token or exception text.
    throw new PrivateCommandSearchError("unavailable");
  }
}
