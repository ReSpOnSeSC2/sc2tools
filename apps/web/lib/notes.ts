/**
 * One notes system: shared types and rules for opponent notes (one per exact
 * account, with tags, stream/private visibility and account/player scope),
 * private timestamped game notes and the game review queue.
 *
 * Mirrors apps/api/src/services/notesPolicy.js. The API enforces every rule;
 * the client applies the same ones so the editor never offers a state the
 * server would change (a Toxic note is private and silent).
 */

export const NOTE_TEXT_MAX = 500;
export const NOTE_TAGS_MAX = 8;
export const NOTE_TAG_MAX_LENGTH = 24;
export const GAME_NOTES_MAX = 200;
export const REVIEW_TAGS_MAX = 5;

/** Preset tags, in display order. */
export const PRESET_TAGS = ["Cheeser", "Proxy", "All-in", "Macro", "Smurf", "Off-race", "Rival", "Toxic"] as const;
/** Quick-add review tags for the review queue. */
export const REVIEW_TAG_PRESETS = ["Macro", "Build order", "Scouting", "Micro", "Decisions"] as const;
/** Tags that make a note private wherever it is shown. */
export const PRIVATE_TAGS: readonly string[] = ["Toxic"];

export type NoteVisibility = "stream" | "private";
export type NoteScope = "account" | "player";
export type NoteTarget = { kind: "opponent" | "game"; id: string };
export type ReviewState = "todo" | "done";

export interface NoteDto {
  id: string;
  target: NoteTarget;
  text: string;
  tags: string[];
  visibility: NoteVisibility;
  scope: NoteScope;
  pinned: boolean;
  readAloud: boolean;
  /** Whether the OBS overlay may show this note (stream and no private tag). */
  streamEligible: boolean;
  /** Moved from the original opponent notes; still shown on stream until changed. */
  migrated: boolean;
  gameTimeSec?: number | null;
  x?: number | null;
  y?: number | null;
  createdAt: string;
  updatedAt: string;
  /** Linked notes only: the other account's name (owner views only). */
  account?: string;
}

export interface GameReview {
  state: ReviewState | null;
  tags: string[];
  updatedAt?: string;
}

const PRESET_BY_KEY = new Map(PRESET_TAGS.map((tag) => [tag.toLowerCase(), tag]));
const PRIVATE_KEYS = new Set(PRIVATE_TAGS.map((tag) => tag.toLowerCase()));
const CONTROL = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** A tag in its stored spelling, or null when empty. Presets keep their case. */
export function canonicalTag(raw: string): string | null {
  const tag = raw.replace(CONTROL, "").replace(/\s+/g, " ").trim().replace(/^#+/, "").trim();
  if (!tag) return null;
  return PRESET_BY_KEY.get(tag.toLowerCase()) ?? tag;
}

/** Canonical, de-duplicated (case-insensitive) and capped tag list. */
export function normalizeTagList(tags: readonly string[], max = NOTE_TAGS_MAX): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const tag = canonicalTag(raw);
    if (!tag || Array.from(tag).length > NOTE_TAG_MAX_LENGTH) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= max) break;
  }
  return out;
}

export function isPrivateTag(tag: string): boolean {
  return PRIVATE_KEYS.has(tag.toLowerCase());
}

export function hasPrivateTag(tags: readonly string[]): boolean {
  return tags.some(isPrivateTag);
}

/** The visibility a note will be saved with: private tags win. */
export function effectiveVisibility(visibility: NoteVisibility, tags: readonly string[]): NoteVisibility {
  return hasPrivateTag(tags) ? "private" : visibility;
}

/** `m:ss` (or `h:mm:ss`) for a game time in seconds. */
export function formatGameClock(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

export const gameNotesPath = (gameId: string) => `/v1/games/${encodeURIComponent(gameId)}/notes`;
export const gameNotePath = (gameId: string, noteId: string) => `${gameNotesPath(gameId)}/${encodeURIComponent(noteId)}`;
export const gameReviewPath = (gameId: string) => `/v1/games/${encodeURIComponent(gameId)}/review`;
export const opponentNotePath = (pulseId: string) => `/v1/opponents/${encodeURIComponent(pulseId)}/notes`;
export const REVIEW_TAGS_PATH = "/v1/review-queue/tags";

/** Shape of a game-notes listing. */
export interface GameNotesResponse {
  items: NoteDto[];
  limit: number;
}

/** Body for creating a game note; the API validates every field again. */
export interface GameNoteInput {
  text: string;
  tags?: string[];
  pinned?: boolean;
  gameTimeSec?: number | null;
  x?: number | null;
  y?: number | null;
}

/** Re-create a deleted note exactly (Undo). */
export function undoInput(note: NoteDto): GameNoteInput {
  return {
    text: note.text,
    tags: note.tags,
    pinned: note.pinned,
    gameTimeSec: note.gameTimeSec ?? null,
    ...(typeof note.x === "number" && typeof note.y === "number" ? { x: note.x, y: note.y } : {}),
  };
}
