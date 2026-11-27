/**
 * Measures Humdingers play time (ADRs 0102, 0103). Time counts while the page
 * is visible and the player gave input in the last five minutes, so an idle
 * tab stops the clock. Every report carries a random id for this visit, which
 * the API uses to keep one play session per visit with the account.
 */

export const IDLE_MS = 5 * 60_000;
export const REPORT_EVERY_SECONDS = 5 * 60;
/** The API accepts at most this many seconds per report. */
export const MAX_REPORT_SECONDS = 600;
export const LONG_PLAY_SECONDS = 60;

export type PlayProgress = { chapter: number; saved: boolean };
export type PlayReport = { session: string } & (
  | ({ type: "load" } & PlayProgress)
  | ({ type: "active"; seconds: number; longPlay: boolean } & PlayProgress)
);

export class PlayTracker {
  private pendingSeconds = 0;
  private totalSeconds = 0;
  private lastInputAt = Number.NEGATIVE_INFINITY;
  private longPlayReported = false;

  constructor(
    private readonly send: (report: PlayReport, keepalive: boolean) => void,
    private readonly progress: () => PlayProgress,
    private readonly now: () => number = Date.now,
    readonly session: string = newSessionId(),
  ) {}

  /** The game finished loading in its frame. */
  loaded(): void {
    this.lastInputAt = this.now();
    this.send({ session: this.session, type: "load", ...this.progress() }, false);
  }

  /** A key, pointer, touch or gamepad press from the player. */
  input(): void {
    this.lastInputAt = this.now();
  }

  /** Called once a second; reports every five minutes of play. */
  tick(visible: boolean): void {
    if (!visible || this.now() - this.lastInputAt >= IDLE_MS) return;
    this.pendingSeconds += 1;
    this.totalSeconds += 1;
    if (this.pendingSeconds >= REPORT_EVERY_SECONDS) this.report(false);
  }

  /** Sends the play time not yet reported (on a schedule, when hidden, or during page exit). */
  report(keepalive: boolean): void {
    if (this.pendingSeconds <= 0) return;
    const seconds = Math.min(this.pendingSeconds, MAX_REPORT_SECONDS);
    this.pendingSeconds -= seconds;
    const longPlay = !this.longPlayReported && this.totalSeconds >= LONG_PLAY_SECONDS;
    if (longPlay) this.longPlayReported = true;
    this.send({ session: this.session, type: "active", seconds, longPlay, ...this.progress() }, keepalive);
  }
}

/** A random id for one visit (the API accepts 8 to 64 of A-Z, a-z, 0-9, "_" and "-"). */
export function newSessionId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof cryptoApi?.getRandomValues === "function") cryptoApi.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
