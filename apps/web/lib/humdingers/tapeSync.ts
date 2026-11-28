/**
 * Humdingers run tapes (ADR 0113). When the host page asks, the game records
 * each visit as a tape: the button presses and the few outside values it read,
 * enough to replay the visit exactly (the game's js/systems/tape.js). The host
 * takes the new part of the tape from the frame every 30 seconds and when the
 * page hides, gzips it and uploads it with the visit's play session id
 * (ADR 0103); admins replay it on /admin/humdingers.
 */
import { accountFetch, type TokenCache } from "./saveSync";

export const TAPE_EVERY_MS = 30_000;
/** The API refuses longer chunks (characters of `data`). */
export const MAX_CHUNK_CHARS = 200_000;
/** Browsers cap all keepalive bodies of a page at 64 kB; page-exit request bodies stay under this many bytes in all. */
export const KEEPALIVE_MAX_BYTES = 60_000;
/** Chunks kept for a retry; past this the oldest is dropped and the replay shows a gap. */
export const MAX_WAITING = 40;
const RETRY_STATUS = 500;

/** What the game hands over (G.tape.take()): format 1, see the game's docs/api/tape.md. */
export type TapeChunk = {
  v: number; seq: number; build: string; seed: number; admin: boolean; from: number; to: number;
  ev?: unknown[]; end?: string; cut?: boolean; [key: string]: unknown;
};
export type TapeSummary = Partial<Record<"ticks" | "maps" | "fights" | "won" | "lost" | "ran" | "overs" | "levelups" | "saves" | "hints", number>> & { goal?: string };
export type TapeSource = { take(): TapeChunk | null; summary(): TapeSummary | null };
export type TapeUpload = {
  seq: number; enc: "gzip-b64" | "json"; data: string; build: string; from: number; to: number;
  final?: boolean; summary?: TapeSummary;
};
/** One stored chunk as the admin read returns it. */
export type StoredChunk = { seq: number; enc: string; data: string; from: number; to: number };

/**
 * What the game reads from its host window before it boots (the game's
 * js/systems/host.js): a player's visit says whether the player is a site
 * admin (the title's "Watch a demo" is for admins only) and whether to record;
 * the admin replay page hands over a tape instead.
 */
export type HumdingersHostConfig = { v: 1; admin: boolean; record: boolean } | { v: 1; replay: { chunks: TapeChunk[] } };
declare global {
  interface Window { HUMDINGERS_HOST?: HumdingersHostConfig }
}

/** Leaves the config for the game's frame to read when it loads (null removes it). */
export function setHostConfig(config: HumdingersHostConfig | null): void {
  if (config) window.HUMDINGERS_HOST = config;
  else delete window.HUMDINGERS_HOST;
}

/** Whether this browser can gzip; without it the visit is not recorded (an exit upload alone could not carry it). */
export function canRecordTapes(): boolean {
  return typeof CompressionStream === "function" && typeof DecompressionStream === "function";
}

/** The game's tape in a same-origin frame, or null before it loads. */
export function tapeSource(view: Window | null | undefined): TapeSource | null {
  try {
    const tape = (view as unknown as { G?: { tape?: Partial<TapeSource> } } | null | undefined)?.G?.tape;
    return tape && typeof tape.take === "function" && typeof tape.summary === "function" ? (tape as TapeSource) : null;
  } catch {
    return null;
  }
}

export async function gzipBase64(text: string): Promise<string> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

export async function gunzipBase64(data: string): Promise<string> {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

/** Stored chunks -> the game's chunks, in order. A chunk that will not decode is left out (the replay shows a gap). */
export async function decodeChunks(rows: StoredChunk[]): Promise<TapeChunk[]> {
  const out: TapeChunk[] = [];
  for (const row of [...rows].sort((a, b) => a.seq - b.seq)) {
    try {
      const text = row.enc === "gzip-b64" ? await gunzipBase64(row.data) : row.data;
      const chunk: unknown = JSON.parse(text);
      if (chunk && typeof chunk === "object" && (chunk as TapeChunk).v === 1) out.push(chunk as TapeChunk);
    } catch {
      /* a damaged chunk: skipped */
    }
  }
  return out;
}

/**
 * Takes the game's new chunks and uploads them, oldest first. A failed upload
 * (network, 5xx) waits for the next pull; one the API refuses (4xx: too large,
 * the tape is full) is dropped, so a bad chunk never blocks the rest.
 */
export class TapeUploader {
  private readonly waiting: TapeUpload[] = [];
  private busy = false;
  private ended = false;
  /** Taken from the game, still being gzipped: page exit sends it as it is. */
  private inflight: TapeChunk | null = null;

  constructor(
    private readonly tokens: TokenCache,
    private readonly session: string,
    private readonly source: () => TapeSource | null,
  ) {}

  /** The chunks waiting for a retry (tests, diagnostics). */
  get pending(): number { return this.waiting.length; }

  /** On a timer and when the page hides. */
  async pull(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const chunk = this.take();
      if (chunk) {
        this.inflight = chunk;
        const data = await gzipBase64(JSON.stringify(chunk));
        if (this.inflight === chunk && data.length <= MAX_CHUNK_CHARS) this.push(this.upload(chunk, "gzip-b64", data, false));
        this.inflight = null;
      }
      while (this.waiting.length) {
        const next = this.waiting[0];
        const sent = await this.send(next, false);
        if (!sent) break;
        this.waiting.shift();
      }
    } finally {
      this.busy = false;
    }
  }

  /** Page exit: everything waiting, then the newest part uncompressed (no time to gzip), within the keepalive budget. */
  pullOnExit(): void {
    const batch = [...this.waiting];
    this.waiting.length = 0;
    if (this.inflight) { batch.push(this.upload(this.inflight, "json", JSON.stringify(this.inflight), false)); this.inflight = null; }
    const chunk = this.take();
    if (chunk) batch.push(this.upload(chunk, "json", JSON.stringify(chunk), true));
    else if (batch.length) batch[batch.length - 1] = { ...batch[batch.length - 1], final: true };
    // The bodies themselves are measured: a plain JSON chunk grows when it is quoted again inside the request.
    const encoder = new TextEncoder();
    let budget = KEEPALIVE_MAX_BYTES;
    for (const upload of batch) {
      if (upload.data.length > MAX_CHUNK_CHARS) continue;
      const body = JSON.stringify(upload), size = encoder.encode(body).length;
      if (size > budget) continue;
      budget -= size;
      void this.post(body, true);
    }
  }

  private take(): TapeChunk | null {
    if (this.ended) return null;
    const tape = this.source();
    let chunk: TapeChunk | null = null;
    try { chunk = tape ? tape.take() : null; } catch { chunk = null; }
    if (chunk && chunk.end) this.ended = true;
    return chunk;
  }

  private upload(chunk: TapeChunk, enc: TapeUpload["enc"], data: string, final: boolean): TapeUpload {
    let summary: TapeSummary | null = null;
    try { summary = this.source()?.summary() ?? null; } catch { summary = null; }
    return {
      seq: chunk.seq, enc, data, build: chunk.build, from: chunk.from, to: chunk.to,
      ...(final || chunk.end ? { final: true } : {}),
      ...(summary ? { summary } : {}),
    };
  }

  private push(upload: TapeUpload): void {
    this.waiting.push(upload);
    while (this.waiting.length > MAX_WAITING) this.waiting.shift();
  }

  /** -> true when the chunk is done with (stored, or refused for good). */
  private send(upload: TapeUpload, keepalive: boolean): Promise<boolean> {
    return this.post(JSON.stringify(upload), keepalive);
  }

  private async post(body: string, keepalive: boolean): Promise<boolean> {
    try {
      const response = await accountFetch(this.tokens, `/v1/me/humdingers/tapes/${encodeURIComponent(this.session)}`, {
        method: "POST", body, keepalive,
      });
      return response.status < RETRY_STATUS;
    } catch {
      return false;
    }
  }
}
