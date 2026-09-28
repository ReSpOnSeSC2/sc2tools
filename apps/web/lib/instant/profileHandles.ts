/**
 * Remember which toon handles belong to the signed-in user.
 *
 * After the visitor confirms "this is me" in the importer, their toon
 * handles are appended to `pulseIds` on their profile so future imports
 * (and the rest of the app) resolve them without asking again.
 *
 * `PUT /v1/me/profile` has REPLACE semantics and rejects unknown keys:
 * every accepted field that is absent gets cleared. So we always
 * GET → copy every accepted key verbatim → append toons → PUT, and skip
 * the PUT entirely when nothing new would be added.
 *
 * Example:
 *   await saveConfirmedToons(getToken, ["1-S2-1-267727"], apiCall);
 */
import { TOON_HANDLE_RE } from "./toonPath";

/** Keys `PUT /v1/me/profile` accepts (`additionalProperties: false`). */
export const PROFILE_PUT_KEYS = [
  "battleTag",
  "pulseId",
  "pulseIds",
  "region",
  "preferredRace",
  "displayName",
  "lastKnownMmr",
  "lastKnownMmrAt",
  "lastKnownMmrRegion",
] as const;

export type ProfilePutKey = (typeof PROFILE_PUT_KEYS)[number];

/** Server cap on `pulseIds` (`maxItems: 20`). */
export const MAX_PULSE_IDS = 20;

export type ProfilePutValue = string | number | string[];

export type ProfilePutBody = Partial<Record<ProfilePutKey, ProfilePutValue>>;

/** Same shape as `apiCall` in lib/clientApi.ts (injected, not imported). */
export type ApiCallFn = <T>(
  getToken: () => Promise<string | null>,
  path: string,
  init?: RequestInit,
) => Promise<T>;

export interface SaveToonsResult {
  changed: boolean;
  pulseIds: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function dedupe(values: ReadonlyArray<string>): string[] {
  return [...new Set(values)];
}

/**
 * Toon handles already known for the user: saved `pulseIds` plus the
 * server's `detectedPulseIds` (toons seen on uploaded games), filtered
 * to real toon handles (numeric SC2Pulse ids are skipped).
 *
 * Example:
 *   profileToons({ pulseIds: ["1-S2-1-5", "12345"], detectedPulseIds: ["2-S2-1-9"] });
 *   // -> ["1-S2-1-5", "2-S2-1-9"]
 */
export function profileToons(profile: unknown): string[] {
  if (!isRecord(profile)) return [];
  const all = [...stringList(profile.pulseIds), ...stringList(profile.detectedPulseIds)];
  return dedupe(all.map((id) => id.trim()).filter((id) => TOON_HANDLE_RE.test(id)));
}

/**
 * Value shapes the PUT schema accepts per key: `pulseIds` is the only
 * list, `lastKnownMmr` the only number, every other key is a string.
 * Anything else (null, a changed server shape) is left out rather than
 * sent and refused with a 400.
 */
function isPutValue(key: ProfilePutKey, value: unknown): value is ProfilePutValue {
  if (key === "pulseIds") {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
  }
  if (key === "lastKnownMmr") return typeof value === "number" && Number.isFinite(value);
  return typeof value === "string";
}

function existingPulseIds(profile: Record<string, unknown>): string[] {
  const list = stringList(profile.pulseIds);
  if (list.length > 0) return dedupe(list);
  return typeof profile.pulseId === "string" && profile.pulseId ? [profile.pulseId] : [];
}

/**
 * The PUT body that adds `toons` to the profile, or null when every
 * toon is already present (or there is no room under the 20-id cap).
 * Every accepted key from the GET is carried over unchanged, so the
 * REPLACE-semantics PUT never drops a field; `pulseId` stays
 * `pulseIds[0]`.
 *
 * Example:
 *   mergeProfileWithToons({ battleTag: "A#1", pulseIds: ["1-S2-1-5"] }, ["2-S2-1-9"]);
 *   // -> { battleTag: "A#1", pulseIds: ["1-S2-1-5", "2-S2-1-9"], pulseId: "1-S2-1-5" }
 */
export function mergeProfileWithToons(
  profile: unknown,
  toons: ReadonlyArray<string>,
): ProfilePutBody | null {
  const source = isRecord(profile) ? profile : {};
  const current = existingPulseIds(source);
  const additions = dedupe(toons.map((toon) => toon.trim()))
    .filter((toon) => TOON_HANDLE_RE.test(toon) && !current.includes(toon))
    .slice(0, Math.max(0, MAX_PULSE_IDS - current.length));
  if (additions.length === 0) return null;
  const body: ProfilePutBody = {};
  for (const key of PROFILE_PUT_KEYS) {
    const value = source[key];
    if (isPutValue(key, value)) body[key] = value;
  }
  const pulseIds = [...current, ...additions];
  body.pulseIds = pulseIds;
  body.pulseId = pulseIds[0];
  return body;
}

/**
 * GET the profile, merge the confirmed toons, and PUT only if something
 * new was added.
 *
 * Example:
 *   const { changed } = await saveConfirmedToons(getToken, [toon], apiCall);
 */
export async function saveConfirmedToons(
  getToken: () => Promise<string | null>,
  toons: ReadonlyArray<string>,
  apiCallImpl: ApiCallFn,
): Promise<SaveToonsResult> {
  const profile = await apiCallImpl<unknown>(getToken, "/v1/me/profile");
  const body = mergeProfileWithToons(profile, toons);
  if (!body) {
    return { changed: false, pulseIds: isRecord(profile) ? existingPulseIds(profile) : [] };
  }
  await apiCallImpl<unknown>(getToken, "/v1/me/profile", {
    method: "PUT",
    body: JSON.stringify(body),
  });
  return { changed: true, pulseIds: stringList(body.pulseIds) };
}
