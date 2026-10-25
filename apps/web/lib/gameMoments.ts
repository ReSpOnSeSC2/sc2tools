import rules from "../../api/src/config/gameMomentRules.json";
import { isAlertVisualSelection, type AlertVisualSelection } from "./multichat/alerts";
import { isSoundEffectId } from "./multichat/soundEffects";
import { isPackSoundId } from "./multichat/soundPack";
import { CUSTOM_ID_RE } from "./multichat/sound";
import type { ChatEvent } from "./multichat/events";

export type GameMomentKind = "crossedMmrMark" | "newSeasonPeak" | "leagueChange" | "winStreak" | "lossStreakBroken" | "revengeWin" | "giantKiller" | "marathonWin" | "streamerOpponentWin";
export type GameMoment = { kind: GameMomentKind; headline: string; detail: string; gameId: string; atMs: number; isTest?: boolean };
export type GameMomentChoice = { enabled: boolean; preset: AlertVisualSelection; sound: string };
export type GameMomentConfig = { mmrStep: 100 | 250; botPost: boolean; moments: Record<GameMomentKind, GameMomentChoice> };
export const GAME_MOMENT_KINDS = rules.kinds.map(rule => rule.id as GameMomentKind);
export const GAME_MOMENT_LABELS = Object.fromEntries(rules.kinds.map(rule => [rule.id, rule.label])) as Record<GameMomentKind, string>;
export const MOMENT_FRESH_MS = 120_000;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const plain = (value: unknown, max: number) => typeof value === "string" ? value.replace(/<[^>]*>/g, "").replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
const soundId = (value: unknown) => value === "none" || isSoundEffectId(value) || isPackSoundId(value) || typeof value === "string" && CUSTOM_ID_RE.test(value);

/** Exact read mirror of the API's bounded, opt-in preference shape. */
export function sanitizeGameMomentConfig(raw: unknown): GameMomentConfig {
  const source = record(raw), rows = record(source.moments);
  const moments = {} as GameMomentConfig["moments"];
  for (const rule of rules.kinds) {
    const row = record(rows[rule.id]);
    moments[rule.id as GameMomentKind] = { enabled: row.enabled === true, preset: isAlertVisualSelection(row.preset) ? row.preset : rule.preset as AlertVisualSelection, sound: soundId(row.sound) ? row.sound as string : "none" };
  }
  return { mmrStep: source.mmrStep === 250 ? 250 : 100, botPost: source.botPost === true, moments };
}
export function sanitizeGameMoment(raw: unknown, now = Date.now()): GameMoment | null {
  const source = record(raw), kind = source.kind as GameMomentKind;
  if (!GAME_MOMENT_KINDS.includes(kind) || typeof source.gameId !== "string" || !source.gameId || source.gameId.length > 200 || /[\u0000-\u001f]/.test(source.gameId)
    || typeof source.atMs !== "number" || !Number.isFinite(source.atMs) || now - source.atMs > MOMENT_FRESH_MS || source.atMs > now + 30_000) return null;
  const headline = plain(source.headline, 80), detail = plain(source.detail, 180);
  return headline ? { kind, headline, detail, gameId: source.gameId, atMs: source.atMs, ...(source.isTest === true ? { isTest: true } : {}) } : null;
}
export const gameMomentIdentity = (moment: GameMoment) => `${moment.gameId}:${moment.kind}`;
/** Renderer/audio adapter only. Never reported as a Twitch reward: the card
 * explicitly labels its source Ladder, and supporter intake stays separate. */
export function momentCardEvent(moment: GameMoment): ChatEvent {
  return { platform: "twitch", kind: "reward", id: `ladder:${gameMomentIdentity(moment)}`, user: moment.headline, detail: moment.detail, atMs: moment.atMs };
}
