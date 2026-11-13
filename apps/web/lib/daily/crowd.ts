import { FIGHTS_PER_DAY, type FightCall } from "./rules";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8080";
const BALLOT_KEY = "sc2tools:daily:v1:crowd";
const BALLOT_ATTEMPT = /^[0-9a-f]{32}$/;
const MAX_DAILY_VOTES = 64 * 512;
const FLOOR = 20;
type DailyStorage = Pick<Storage, "getItem" | "setItem">;
export type DailyBallot = { day: number; pack: string; answers: FightCall[]; attempt: string };
export type CrowdResult = { state: "waiting" } | { state: "ready"; total: number; fights: number[][] };

function validAnswers(value: unknown): value is FightCall[] {
  return Array.isArray(value) && value.length === FIGHTS_PER_DAY &&
    value.every(answer => typeof answer === "number" && Number.isInteger(answer) && answer >= 0 && answer < 5);
}

function validAttempt(value: unknown): value is string {
  return typeof value === "string" && BALLOT_ATTEMPT.test(value);
}

export function readBallot(storage: DailyStorage | null, day: number, pack: string): DailyBallot | null {
  try {
    if (!storage) return null;
    const value: unknown = JSON.parse(storage.getItem(BALLOT_KEY) ?? "null");
    if (!value || typeof value !== "object") return null;
    const { day: storedDay, pack: storedPack, answers, attempt } = value as Record<string, unknown>;
    if (storedDay !== day || storedPack !== pack || !validAnswers(answers) || !validAttempt(attempt)) return null;
    return { day, pack, answers, attempt };
  } catch {
    return null;
  }
}

function keepBallot(storage: DailyStorage | null, day: number, pack: string, answers: FightCall[]): DailyBallot | null {
  const existing = readBallot(storage, day, pack);
  if (existing || !validAnswers(answers)) return existing;
  let random: Uint8Array;
  try {
    random = crypto.getRandomValues(new Uint8Array(16));
  } catch {
    return null;
  }
  const attempt = Array.from(random, value => value.toString(16).padStart(2, "0")).join("");
  const ballot = { day, pack, answers, attempt };
  try {
    storage?.setItem(BALLOT_KEY, JSON.stringify(ballot));
  } catch {
    // The current session can still use this receipt for retries.
  }
  return ballot;
}

export async function saveBallot(storage: DailyStorage | null, day: number, pack: string, answers: FightCall[]): Promise<DailyBallot | null> {
  const save = () => keepBallot(storage, day, pack, answers);
  if (!storage || !navigator.locks) return save();
  try {
    return await navigator.locks.request(BALLOT_KEY, save);
  } catch {
    return save();
  }
}

function validFightCounts(value: unknown, total: number): value is number[] {
  return Array.isArray(value) && value.length === 5 && value.every(count => Number.isSafeInteger(count) && count >= 0)
    && value.reduce((sum, count) => sum + count, 0) === total;
}

export function readCrowdResult(value: unknown): CrowdResult | null {
  if (!value || typeof value !== "object") return null;
  const { state, total, fights } = value as Record<string, unknown>;
  if (state === "waiting") return { state: "waiting" };
  if (state !== "ready" || !validTotal(total) ||
    !Array.isArray(fights) || fights.length !== FIGHTS_PER_DAY || !fights.every(fight => validFightCounts(fight, total))) return null;
  return { state: "ready", total, fights };
}

function validTotal(total: unknown): total is number {
  return typeof total === "number" && Number.isSafeInteger(total) && total >= FLOOR && total <= MAX_DAILY_VOTES;
}

export async function submitCrowdBallot(ballot: DailyBallot, signal: AbortSignal): Promise<CrowdResult | null> {
  const response = await fetch(API_BASE + "/v1/daily/calls", {
    method: "POST", credentials: "omit", redirect: "error",
    signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(ballot),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Crowd split unavailable.");
  const result = readCrowdResult(await response.json());
  if (!result) throw new Error("Crowd split unavailable.");
  return result;
}
