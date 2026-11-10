/**
 * Build library safety and organisation — web helpers for the private
 * library's version history, "Recently deleted" trash, pin and tags,
 * import/export and share codes, plus the saver side of community updates.
 *
 * Mirrors apps/api/src/routes/customBuildLibrary.js. Share codes and
 * imported files are hostile input: everything is size-checked, decoded
 * defensively and projected onto the fields the API accepts before it is
 * previewed; the API validates every build again.
 */

import { apiCall } from "@/lib/clientApi";
import { coerceSavedRules, SKILL_LEVELS } from "@/lib/build-rules";

type TokenGetter = () => Promise<string | null>;

export const TRASH_PATH = "/v1/custom-builds/trash";
export const IMPORT_BATCH_SIZE = 100;
export const LIBRARY_MAX_BUILDS = 500;
export const SHARE_CODE_MAX_CHARS = 8192;
/** Bigger import files than this are refused before they are parsed. */
export const IMPORT_MAX_BYTES = 2 * 1024 * 1024;
export const TAGS_MAX = 8;
export const TAG_MAX_LENGTH = 24;
export const UNDO_WINDOW_MS = 10_000;

export interface TrashItem {
  slug: string;
  name: string;
  race: string | null;
  vsRace: string | null;
  perspective: "you" | "opponent";
  deletedAt: string;
  purgeAt: string;
}

export interface TrashResponse {
  items: TrashItem[];
  total: number;
  retentionDays: number;
}

export interface BuildRevision {
  rev: number;
  savedAt: string;
  build: Record<string, unknown>;
}

export interface RevisionsResponse {
  slug: string;
  items: BuildRevision[];
}

export type ConflictChoice = "skip" | "copy" | "overwrite";

export type ImportStatus =
  | "new" | "conflict" | "invalid" | "created" | "overwritten" | "copied" | "skipped" | "failed";

export interface ImportResult {
  index: number;
  status: ImportStatus;
  slug?: string;
  name?: string;
  errors?: string[];
}

export interface ImportResponse {
  results: ImportResult[];
  libraryCount: number;
}

export interface CommunityVersion {
  slug: string;
  version: number;
  updatedAt: string | null;
}

export interface ForkProvenance {
  communitySlug?: string | null;
  version?: string | null;
  savedAt?: string | null;
}

/* ------------------------------------------------------------------
 * API
 * ------------------------------------------------------------------ */

/** Example: `buildPath("dt rush", "/restore")` → "/v1/custom-builds/dt%20rush/restore". */
export function buildPath(slug: string, suffix = ""): string {
  return `/v1/custom-builds/${encodeURIComponent(slug)}${suffix}`;
}

const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

/** Bring a build back from "Recently deleted" (privately, never republished). */
export function restoreDeletedBuild(getToken: TokenGetter, slug: string) {
  return apiCall<{ restored: boolean; slug: string }>(getToken, buildPath(slug, "/restore"), json({}));
}

export function restoreBuildRevision(getToken: TokenGetter, slug: string, rev: number) {
  return apiCall<{ saved: boolean; restoredRev: number }>(getToken, buildPath(slug, `/revisions/${rev}/restore`), json({}));
}

/** Pin and tags only; no history entry and no replay matching. */
export function patchBuildMeta(getToken: TokenGetter, slug: string, meta: { pinned?: boolean; tags?: string[] }) {
  return apiCall<{ slug: string; pinned?: boolean; tags?: string[] }>(getToken, buildPath(slug, "/meta"), {
    method: "PATCH",
    body: JSON.stringify(meta),
  });
}

export function fetchLibraryExport(getToken: TokenGetter) {
  return apiCall<{ format: string; version: number; exportedAt: string; builds: Record<string, unknown>[] }>(
    getToken, "/v1/custom-builds/export",
  );
}

export function importBuildBatch(
  getToken: TokenGetter,
  items: Array<{ build: Record<string, unknown>; onConflict?: ConflictChoice }>,
  opts: { dryRun?: boolean; reclassify?: boolean } = {},
) {
  return apiCall<ImportResponse>(getToken, "/v1/custom-builds/import", json({ items, ...opts }));
}

export function applyAuthorUpdate(getToken: TokenGetter, slug: string) {
  return apiCall<{ saved: boolean; version: number }>(getToken, buildPath(slug, "/apply-update"), json({}));
}

export function dismissAuthorUpdate(getToken: TokenGetter, slug: string, version: number) {
  return apiCall<{ slug: string; version: string }>(getToken, buildPath(slug, "/dismiss-update"), json({ version }));
}

/**
 * The batched versions lookup for saved community copies; null without
 * any. Example: `communityVersionsPath(["b", "a", "a"])` →
 * "/v1/community/builds/versions?slugs=a,b".
 */
export function communityVersionsPath(slugs: ReadonlyArray<string | null | undefined>): string | null {
  const unique = [...new Set(slugs.filter((slug): slug is string => !!slug && /^[a-zA-Z0-9._-]{1,80}$/.test(slug)))]
    .sort().slice(0, 50);
  return unique.length ? `/v1/community/builds/versions?slugs=${unique.join(",")}` : null;
}

/**
 * Whether the author changed a saved copy's community build since it was
 * saved. Copies record the publication version they took ("3"); copies
 * saved before versions existed recorded its update time instead.
 */
export function authorUpdated(fork: ForkProvenance | null | undefined, current: CommunityVersion | undefined): boolean {
  if (!fork?.communitySlug || !current) return false;
  const saved = (fork.version ?? "").trim();
  if (/^\d{1,9}$/.test(saved)) return Number(saved) < current.version;
  const updated = current.updatedAt ? Date.parse(current.updatedAt) : NaN;
  const since = Date.parse(saved || fork.savedAt || "");
  return Number.isFinite(updated) && Number.isFinite(since) && updated > since + 1000;
}

/* ------------------------------------------------------------------
 * Tags
 * ------------------------------------------------------------------ */

/**
 * Trimmed, single-spaced, case-insensitively unique tags, at most 8 of
 * 24 characters. Example: `normalizeTags([" Cheese", "cheese", "ZvP  macro"])`
 * → ["Cheese", "ZvP macro"].
 */
export function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const tag = raw.replace(/\s+/g, " ").trim().slice(0, TAG_MAX_LENGTH);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
    if (out.length === TAGS_MAX) break;
  }
  return out;
}

/* ------------------------------------------------------------------
 * Client validation (the API validates again)
 * ------------------------------------------------------------------ */

const RACES = ["Protoss", "Terran", "Zerg", "Random"];
const VS_RACES = [...RACES, "Any"];
const SKILL_IDS = new Set<string>(SKILL_LEVELS.map((level) => level.id));
const NOTE_LISTS = ["winConditions", "losesTo", "transitionsInto"] as const;

export type ValidatedBuild = { ok: true; build: Record<string, unknown> } | { ok: false; errors: string[] };

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function boundedText(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length <= max ? value : undefined;
}

function noteList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.slice(0, 280)).slice(0, 20);
}

/**
 * Project an untrusted build onto the fields an import or share code may
 * carry, refusing what the API would refuse. Private publication state is
 * never taken from a file.
 */
export function clientValidateBuild(raw: unknown): ValidatedBuild {
  if (!plainObject(raw)) return { ok: false, errors: ["Not a build."] };
  const errors: string[] = [];
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name || name.length > 120) errors.push("A name of 1–120 characters is required.");
  if (!RACES.includes(String(raw.race))) errors.push("Race must be Protoss, Terran, Zerg or Random.");
  if (raw.vsRace !== undefined && !VS_RACES.includes(String(raw.vsRace))) errors.push("Unknown opponent race.");
  if (Array.isArray(raw.rules) && raw.rules.length > 30) errors.push("At most 30 rules.");
  if (raw.description !== undefined && boundedText(raw.description, 4000) === undefined) errors.push("Description is too long.");
  if (raw.notes !== undefined && boundedText(raw.notes, 8000) === undefined) errors.push("Notes are too long.");
  if (errors.length) return { ok: false, errors };
  const build: Record<string, unknown> = { name, race: raw.race };
  if (typeof raw.slug === "string" && /^[a-zA-Z0-9._-]{1,80}$/.test(raw.slug)) build.slug = raw.slug;
  if (raw.vsRace !== undefined) build.vsRace = raw.vsRace;
  if (raw.perspective === "you" || raw.perspective === "opponent") build.perspective = raw.perspective;
  for (const [field, max] of [["description", 4000], ["notes", 8000]] as const) {
    const text = boundedText(raw[field], max);
    if (text !== undefined) build[field] = text;
  }
  const rules = coerceSavedRules(raw.rules);
  if (rules.length) {
    build.rules = rules;
    build.schemaVersion = 3;
  }
  if (typeof raw.skillLevel === "string" && SKILL_IDS.has(raw.skillLevel)) build.skillLevel = raw.skillLevel;
  for (const field of NOTE_LISTS) {
    const list = noteList(raw[field]);
    if (list && list.length) build[field] = list;
  }
  const tags = normalizeTags(raw.tags);
  if (tags.length) build.tags = tags;
  if (raw.pinned === true) build.pinned = true;
  return { ok: true, build };
}

/* ------------------------------------------------------------------
 * Share codes
 * ------------------------------------------------------------------ */

const SHARE_FIELDS = [
  "name", "race", "vsRace", "description", "perspective", "rules", "skillLevel",
  "winConditions", "losesTo", "transitionsInto",
] as const;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(code: string): Uint8Array {
  const padded = code.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(code.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/**
 * A copyable code for one build: its definition only (never notes, tags
 * or publication state), base64url JSON of at most 8 KB.
 * Throws "share_code_too_large" for a build that doesn't fit.
 */
export function encodeShareCode(build: Record<string, unknown>): string {
  const body: Record<string, unknown> = {};
  for (const field of SHARE_FIELDS) {
    if (build[field] !== undefined && build[field] !== null) body[field] = build[field];
  }
  const code = toBase64Url(new TextEncoder().encode(JSON.stringify({ v: 1, b: body })));
  if (code.length > SHARE_CODE_MAX_CHARS) throw new Error("share_code_too_large");
  return code;
}

/** Example: `shareImportHref("eyJ2…")` → "/builds/import#code=eyJ2…" (the code stays in the fragment). */
export function shareImportHref(code: string): string {
  return `/builds/import#code=${code}`;
}

/**
 * Decode a pasted share code (or a /builds/import#code= link) into a
 * validated build. Oversized, non-base64url, non-UTF-8, non-JSON and
 * wrong-shape input are all refused with a reason.
 */
export function decodeShareCode(input: string): ValidatedBuild {
  const code = input.trim().replace(/^.*#code=/, "");
  if (!code || code.length > SHARE_CODE_MAX_CHARS) return { ok: false, errors: ["That share code is empty or too long."] };
  if (!/^[A-Za-z0-9_-]+$/.test(code)) return { ok: false, errors: ["That isn't a share code."] };
  let envelope: unknown;
  try {
    envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fromBase64Url(code)));
  } catch {
    return { ok: false, errors: ["That share code is damaged. Copy it again."] };
  }
  if (!plainObject(envelope) || envelope.v !== 1 || !plainObject(envelope.b)) {
    return { ok: false, errors: ["That share code isn't from SC2 Tools."] };
  }
  return clientValidateBuild(envelope.b);
}

/* ------------------------------------------------------------------
 * Import sources
 * ------------------------------------------------------------------ */

export interface ImportCandidate {
  /** Position in the source, for messages. */
  index: number;
  label: string;
  build?: Record<string, unknown>;
  errors?: string[];
}

/**
 * Builds from an export file, a JSON array or object, or a share code.
 * At most LIBRARY_MAX_BUILDS candidates; each is validated on its own.
 */
export function parseImportSource(text: string): { candidates: ImportCandidate[]; error?: string } {
  const source = text.trim();
  if (!source) return { candidates: [], error: "Paste a share code or JSON, or choose a file." };
  if (source.length > IMPORT_MAX_BYTES) return { candidates: [], error: "That file is too large to import (2 MB at most)." };
  if (!source.startsWith("{") && !source.startsWith("[")) {
    const decoded = decodeShareCode(source);
    return { candidates: [toCandidate(decoded, 0, "Share code")] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return { candidates: [], error: "That isn't valid JSON." };
  }
  const list = Array.isArray(parsed) ? parsed
    : plainObject(parsed) && Array.isArray(parsed.builds) ? parsed.builds
      : plainObject(parsed) ? [parsed] : null;
  if (!list) return { candidates: [], error: "No builds found." };
  if (list.length > LIBRARY_MAX_BUILDS) return { candidates: [], error: `At most ${LIBRARY_MAX_BUILDS} builds can be imported at once.` };
  return { candidates: list.map((raw, index) => toCandidate(clientValidateBuild(raw), index, `Build ${index + 1}`)) };
}

function toCandidate(result: ValidatedBuild, index: number, fallback: string): ImportCandidate {
  if (result.ok) return { index, label: String(result.build.name || fallback), build: result.build };
  return { index, label: fallback, errors: result.errors };
}
