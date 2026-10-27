import { API_BASE } from "./clientApi";
import { isCommandGuidePath } from "./commandGuideSearch";
import { guideMapPath } from "./guides/slugs";
import type { GuideIndexPayload } from "./guides/types";

export type CommandGuideMetadata = {
  readonly publishedPaths: ReadonlySet<string>;
  readonly maps: readonly Readonly<Pick<GuideIndexPayload["maps"][number], "map" | "slug">>[];
};
export type CommandGuideMetadataOptions = { signal?: AbortSignal; force?: boolean };
export const COMMAND_GUIDE_METADATA_TIMEOUT_MS = 6000;
export const COMMAND_GUIDE_METADATA_BYTES = 1024 * 1024;
export const COMMAND_GUIDE_METADATA_TTL_MS = 21600 * 1000;
// The existing sitemap adds hub, map-index and nine counter-index paths to
// at most 5,000 docs. Do not silently truncate that valid 5,011-entry protocol.
export const COMMAND_GUIDE_METADATA_PATHS = 5011;
const MAPS_MAX = 200;
type Flight = {
  controller: AbortController; promise: Promise<CommandGuideMetadata>;
  consumers: number; abandoned: boolean;
};
let flight: Flight | null = null;
let cached: { value: CommandGuideMetadata; expiresAt: number } | null = null;
let failure: Error | null = null;

function unavailable(): Error { return new Error("Public guide metadata unavailable"); }
function aborted(signal: AbortSignal): Error {
  return signal.reason instanceof Error || signal.reason instanceof DOMException
    ? signal.reason : new DOMException("Guide metadata request canceled", "AbortError");
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 2 * max
    && value.trim().length > 0 && Array.from(value).length <= max
    && !/[\p{Cc}\uD800-\uDFFF]/u.test(value);
}
function instant(value: unknown): boolean {
  return typeof value === "string" && value.length <= 40
    && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}
function computedAt(value: unknown): boolean { return value === null || instant(value); }
function cancelBody(response: Response): void {
  try { void response.body?.cancel().catch(() => undefined); } catch { /* Already released/locked. */ }
}

/** Abort still wins if an adapter ignores the signal; retire a late body too. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cancel = () => {
      if (settled) return;
      settled = true; signal.removeEventListener("abort", cancel); reject(aborted(signal));
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

/** Count streamed UTF-8 bytes, rather than trusting Content-Length. */
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw unavailable();
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  const parts: string[] = []; let bytes = 0, consumed = false;
  const cancel = () => { try { void reader.cancel().catch(() => undefined); } catch { /* Retired reader. */ } };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw aborted(signal);
      const next = await abortable(reader.read(), signal);
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > COMMAND_GUIDE_METADATA_BYTES) throw unavailable();
      parts.push(decoder.decode(next.value, { stream: true }));
    }
    if (signal.aborted) throw aborted(signal);
    parts.push(decoder.decode());
    const value: unknown = JSON.parse(parts.join("")); consumed = true; return value;
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!consumed) cancel();
    reader.releaseLock();
  }
}

function endpoint(path: "/v1/guides" | "/v1/guides/sitemap"): string {
  const base = new URL(API_BASE);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw unavailable();
  return new URL(`${API_BASE.replace(/\/+$/, "")}${path}`).href;
}

async function publicJson(path: "/v1/guides" | "/v1/guides/sitemap", signal: AbortSignal): Promise<unknown> {
  const url = endpoint(path), headers: Record<string, string> = { accept: "application/json" };
  if (path === "/v1/guides") headers["x-sc2tools-guide-index-version"] = "2";
  let response: Response | undefined;
  try {
    response = await abortable(fetch(url, {
      method: "GET", credentials: "omit", redirect: "error", cache: "no-store", headers, signal,
    }), signal, cancelBody);
    if (signal.aborted) throw aborted(signal);
    if (response.status !== 200 || response.redirected || response.url !== url) throw unavailable();
    if (response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw unavailable();
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > COMMAND_GUIDE_METADATA_BYTES)) throw unavailable();
    return await boundedJson(response, signal);
  } catch (error) {
    if (response && !response.body?.locked) cancelBody(response);
    throw error;
  }
}

function publishedPaths(value: unknown): ReadonlySet<string> {
  if (!record(value) || !computedAt(value.computedAt) || !Array.isArray(value.entries)
    || value.entries.length > COMMAND_GUIDE_METADATA_PATHS) throw unavailable();
  const paths = new Set<string>();
  for (const row of value.entries) {
    if (!record(row) || typeof row.path !== "string" || !instant(row.lastModified)
      || !(row.path === "/guides/maps" || isCommandGuidePath(row.path)) || paths.has(row.path)) throw unavailable();
    paths.add(row.path);
  }
  return paths;
}

/** Only these two leaves of the actual index maps enter the search catalog. */
function publicMaps(value: unknown): CommandGuideMetadata["maps"] {
  if (!record(value) || !computedAt(value.computedAt) || typeof value.era !== "string" || !["before", "after"].includes(value.era)
    || !text(value.patch, 200) || !Array.isArray(value.matchups) || value.matchups.length > 9
    || !Array.isArray(value.videos) || !Object.hasOwn(value, "channel")
    || !(value.channel === null || record(value.channel)) || !Array.isArray(value.maps) || value.maps.length > MAPS_MAX) throw unavailable();
  const seen = new Set<string>();
  return Object.freeze(value.maps.map(row => {
    if (!record(row) || !text(row.map, 200) || !text(row.slug, 80)
      || !Number.isSafeInteger(row.games) || Number(row.games) < 0
      || guideMapPath(row.map) !== `/guides/maps/${row.slug}` || seen.has(row.slug)) throw unavailable();
    seen.add(row.slug);
    return Object.freeze({ map: row.map, slug: row.slug });
  }));
}

async function run(task: Flight): Promise<CommandGuideMetadata> {
  const timer = setTimeout(() => task.controller.abort(new DOMException("Guide metadata request timed out", "TimeoutError")), COMMAND_GUIDE_METADATA_TIMEOUT_MS);
  try {
    const [sitemap, index] = await Promise.all([
      publicJson("/v1/guides/sitemap", task.controller.signal), publicJson("/v1/guides", task.controller.signal),
    ]);
    if (task.controller.signal.aborted || task.abandoned || flight !== task) throw aborted(task.controller.signal);
    const value = Object.freeze({ publishedPaths: publishedPaths(sitemap), maps: publicMaps(index) });
    cached = { value, expiresAt: Date.now() + COMMAND_GUIDE_METADATA_TTL_MS }; return value;
  } catch (error) {
    const reason = error instanceof Error || error instanceof DOMException ? error : unavailable();
    if (!task.abandoned && flight === task) failure = reason;
    task.controller.abort(reason); throw reason;
  } finally {
    clearTimeout(timer); if (flight === task) flight = null;
  }
}

function subscribe(task: Flight, signal?: AbortSignal): Promise<CommandGuideMetadata> {
  task.consumers++;
  return new Promise((resolve, reject) => {
    let active = true;
    const finish = () => { active = false; task.consumers--; signal?.removeEventListener("abort", cancel); };
    const cancel = () => {
      if (!active || !signal) return;
      finish(); reject(aborted(signal));
      if (task.consumers === 0 && flight === task) {
        task.abandoned = true; flight = null; task.controller.abort();
      }
    };
    signal?.addEventListener("abort", cancel, { once: true });
    task.promise.then(value => { if (active) { finish(); resolve(value); } }, error => { if (active) { finish(); reject(error); } });
    if (signal?.aborted) cancel();
  });
}

/** Explicit open loads once. Failures require force:true (Retry), never a loop.
 * Closing the last subscriber aborts transport; closing one does not retire peers. */
export function loadCommandGuideMetadata({ signal, force = false }: CommandGuideMetadataOptions = {}): Promise<CommandGuideMetadata> {
  if (signal?.aborted) return Promise.reject(aborted(signal));
  if (flight) return subscribe(flight, signal);
  if (!force && cached && cached.expiresAt > Date.now()) {
    const value = cached.value;
    return Promise.resolve().then(() => { if (signal?.aborted) throw aborted(signal); return value; });
  }
  if (!force && failure) return Promise.reject(failure);
  cached = null; failure = null;
  const task: Flight = { controller: new AbortController(), consumers: 0, abandoned: false, promise: Promise.resolve(null as never) };
  flight = task; task.promise = run(task);
  return subscribe(task, signal);
}

/** Clears only the one anonymous in-memory catalog, including test teardown. */
export function resetCommandGuideMetadataCache(): void {
  if (flight) { flight.abandoned = true; flight.controller.abort(); flight = null; }
  cached = null; failure = null;
}
