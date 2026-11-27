/** Stream Guardian warnings the agent raised for this streamer's OBS. The agent decides what is wrong; the Dock only shows it. */
export const GUARDIAN_COPY = {
  mic_muted: "Your microphone has been muted for a while and you are live.",
  stream_unstable: "OBS is dropping frames or reconnecting.",
  not_recording: "A game is running and OBS is neither streaming nor recording.",
  stuck_on_break: "You are still live on a break scene, long after your last game.",
} as const;
export type GuardianRule = keyof typeof GUARDIAN_COPY;
export type GuardianWarning = { rule: GuardianRule; since: number };
export type GuardianState = { warnings: GuardianWarning[]; receivedAt: number };
/** The agent repeats an active list every minute; three missed beats mean it went away. */
export const GUARDIAN_EXPIRES_MS = 180_000;

const isRule = (value: unknown): value is GuardianRule => typeof value === "string" && Object.hasOwn(GUARDIAN_COPY, value);

/** Known rules only, once each; anything else in the payload is ignored. */
export function readGuardian(raw: unknown): GuardianWarning[] {
  const rows = raw && typeof raw === "object" ? (raw as { warnings?: unknown }).warnings : null;
  if (!Array.isArray(rows)) return [];
  const seen = new Map<GuardianRule, GuardianWarning>();
  for (const row of rows) {
    const rule = row?.rule, since = row?.since;
    if (isRule(rule) && !seen.has(rule)) seen.set(rule, { rule, since: Number.isFinite(since) ? since : 0 });
  }
  return [...seen.values()];
}

/** Whole minutes a warning has been active, never below one. */
export const minutesActive = (since: number, now: number) => Math.max(1, Math.round((now - since) / 60_000));
