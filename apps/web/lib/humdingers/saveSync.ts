/**
 * Copies Humdingers saves between the player's browser and their account
 * (ADR 0102). The game keeps each save as JSON in localStorage under
 * "humdingers.save.<slot>"; the host page shares that storage because the
 * game runs in a same-origin frame.
 */
import { API_BASE } from "@/lib/apiBase";

export const SAVE_KEY_PREFIX = "humdingers.save.";
const SLOT_RE = /^[a-z0-9_]{1,24}$/;
const SAVE_FORMAT = "humdingers-save";
const RETRY_MS = 30_000;

export type CloudSave = { slot: string; data: string; when: number };
export type LocalSave = { slot: string; data: string };
export type TokenGetter = () => Promise<string | null>;
type SaveMeta = { when?: unknown; chapter?: unknown };

/** The slot of a save key, or null for every other key. */
export function slotOf(key: string | null): string | null {
  if (!key || !key.startsWith(SAVE_KEY_PREFIX)) return null;
  const slot = key.slice(SAVE_KEY_PREFIX.length);
  return SLOT_RE.test(slot) ? slot : null;
}

function saveMeta(data: string | null | undefined): SaveMeta | null {
  if (!data) return null;
  try {
    const envelope: unknown = JSON.parse(data);
    if (!envelope || typeof envelope !== "object") return null;
    const { fmt, meta } = envelope as { fmt?: unknown; meta?: unknown };
    return fmt === SAVE_FORMAT && meta && typeof meta === "object" ? (meta as SaveMeta) : null;
  } catch {
    return null;
  }
}

/** The save's own time in ms (meta.when), or null when it isn't a Humdingers save. */
export function saveTime(data: string | null | undefined): number | null {
  const when = Number(saveMeta(data)?.when);
  return Number.isSafeInteger(when) && when > 0 ? when : null;
}

/** Every Humdingers save in this browser, by slot. */
export function readLocalSaves(storage: Storage): Map<string, string> {
  const saves = new Map<string, string>();
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    const slot = slotOf(key);
    const data = slot && key ? storage.getItem(key) : null;
    if (slot && data) saves.set(slot, data);
  }
  return saves;
}

/** Per slot, the newer save wins and a tie keeps the local copy. */
export function planMerge(local: Map<string, string>, cloud: CloudSave[]): { writeLocal: CloudSave[]; upload: LocalSave[] } {
  const remote = new Map(cloud.filter((save) => slotOf(SAVE_KEY_PREFIX + save.slot) && saveTime(save.data) !== null)
    .map((save) => [save.slot, save]));
  const writeLocal: CloudSave[] = [];
  const upload: LocalSave[] = [];
  for (const [slot, data] of local) {
    const localWhen = saveTime(data);
    const stored = remote.get(slot);
    if (localWhen !== null && (!stored || stored.when < localWhen)) upload.push({ slot, data });
  }
  for (const [slot, save] of remote) {
    const localWhen = saveTime(local.get(slot));
    if (localWhen === null || save.when > localWhen) writeLocal.push(save);
  }
  return { writeLocal, upload };
}

/**
 * Writes an account save into this browser only while it is still newer than
 * the local copy, so a late download never overwrites a save the game just made.
 */
export function writeIfNewer(storage: Storage, save: CloudSave): boolean {
  const key = SAVE_KEY_PREFIX + save.slot;
  const current = saveTime(storage.getItem(key));
  const incoming = saveTime(save.data);
  if (incoming === null || (current !== null && current >= incoming)) return false;
  storage.setItem(key, save.data);
  return true;
}

/** What a play report says about progress: the furthest chapter and whether anything is saved. */
export function localProgress(storage: Storage): { chapter: number; saved: boolean } {
  let chapter = 0;
  let saved = false;
  for (const data of readLocalSaves(storage).values()) {
    const meta = saveMeta(data);
    if (!meta) continue;
    saved = true;
    const value = Math.floor(Number(meta.chapter));
    if (Number.isFinite(value)) chapter = Math.max(chapter, Math.min(99, Math.max(0, value)));
  }
  return { chapter, saved };
}

/** Remembers the latest session token so a page-exit request can go out without waiting. */
export class TokenCache {
  cached: string | null = null;
  constructor(private readonly getToken: TokenGetter) {}

  async get(): Promise<string | null> {
    this.cached = await this.getToken();
    return this.cached;
  }
}

/** One account API request; `keepalive` reuses the cached token so it can leave during page exit. */
export async function accountFetch(tokens: TokenCache, path: string, init: RequestInit = {}): Promise<Response> {
  const token = init.keepalive ? tokens.cached : await tokens.get();
  if (!token) throw new Error("signed_out");
  return fetch(`${API_BASE}${path}`, {
    ...init,
    cache: "no-store",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  });
}

/**
 * Brings newer account saves into this browser before the game starts and
 * returns the local saves the account is missing.
 */
export async function pullSaves(tokens: TokenCache, storage: Storage): Promise<LocalSave[]> {
  const response = await accountFetch(tokens, "/v1/me/humdingers/saves");
  if (!response.ok) throw new Error(`saves_${response.status}`);
  const body: unknown = await response.json();
  const saves = body && typeof body === "object" && Array.isArray((body as { saves?: unknown }).saves)
    ? (body as { saves: CloudSave[] }).saves : [];
  const plan = planMerge(readLocalSaves(storage), saves);
  for (const save of plan.writeLocal) writeIfNewer(storage, save);
  return plan.upload;
}

/**
 * Uploads changed slots shortly after the game saves. A newer account copy
 * (409) is written back to this browser; a failed upload retries later, and
 * the merge on the next visit catches anything still missed.
 */
export class SaveUploader {
  private readonly pending = new Map<string, string | null>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly tokens: TokenCache, private readonly storage: Storage, private readonly delayMs = 2_000) {}

  queue(slot: string, data: string | null): void {
    this.pending.set(slot, data);
    this.schedule(this.delayMs);
  }

  async flush(): Promise<void> {
    this.clearTimer();
    const batch = [...this.pending];
    this.pending.clear();
    for (const [slot, data] of batch) {
      try {
        await this.send(slot, data, false);
      } catch {
        if (!this.pending.has(slot)) this.pending.set(slot, data);
        this.schedule(RETRY_MS);
      }
    }
  }

  /** Last chance during page exit; a save this misses uploads on the next visit. */
  flushOnExit(): void {
    this.clearTimer();
    for (const [slot, data] of this.pending) void this.send(slot, data, true).catch(() => undefined);
    this.pending.clear();
  }

  dispose(): void {
    this.clearTimer();
  }

  private async send(slot: string, data: string | null, keepalive: boolean): Promise<void> {
    const path = `/v1/me/humdingers/saves/${slot}`;
    const response = data === null
      ? await accountFetch(this.tokens, path, { method: "DELETE", keepalive })
      : await accountFetch(this.tokens, path, { method: "PUT", body: JSON.stringify({ data }), keepalive });
    if (response.status === 409) {
      const body: unknown = await response.json().catch(() => null);
      const newer = body && typeof body === "object" ? (body as { save?: Partial<CloudSave> }).save : null;
      const when = saveTime(newer?.data);
      if (newer && typeof newer.data === "string" && when !== null) writeIfNewer(this.storage, { slot, data: newer.data, when });
      return;
    }
    // A save the API refuses (too large, malformed) stays local rather than retrying forever.
    if (response.status >= 500) throw new Error(`save_${response.status}`);
  }

  private schedule(delay: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => { void this.flush(); }, delay);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
