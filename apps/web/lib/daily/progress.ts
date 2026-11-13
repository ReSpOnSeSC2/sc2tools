import { DAILY_ROUNDS } from "./rules";

export type DailyKind = "recorded" | "practice";
type DailyGame = "fight" | "scout";
export type DailyResults = Record<number, boolean[]>;
const RETENTION = 366;

function storageKey(kind: DailyKind, game: DailyGame): string {
  return "sc2tools:daily:v1:" + (game === "scout" ? "scout:" : "") + kind;
}

function isResult(value: unknown): value is boolean[] {
  return Array.isArray(value) && value.length === DAILY_ROUNDS && value.every(result => typeof result === "boolean");
}

export function readResults(storage: Pick<Storage, "getItem">, kind: DailyKind, game: DailyGame = "fight"): DailyResults {
  try {
    const raw: unknown = JSON.parse(storage.getItem(storageKey(kind, game)) ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const entries = Object.entries(raw).filter(([day, results]) => /^[1-9][0-9]{0,5}$/.test(day) && isResult(results));
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

export function completeDay(storage: Pick<Storage, "getItem" | "setItem"> | null, kind: DailyKind, day: number, results: boolean[], game: DailyGame = "fight"): DailyResults {
  const previous = storage ? readResults(storage, kind, game) : {};
  if (previous[day]) return previous;
  const current = { ...previous, [day]: results };
  const days = Object.keys(current).map(Number).sort((a, b) => b - a).slice(0, RETENTION);
  const retained = Object.fromEntries(days.map(value => [value, current[value]]));
  try {
    storage?.setItem(storageKey(kind, game), JSON.stringify(retained));
  } catch {
    // Private browsing or disabled storage still allows playing this session.
  }
  return retained;
}

export function streakOn(results: DailyResults, day: number): number {
  let end = results[day] ? day : day - 1;
  let count = 0;
  while (results[end] && count < RETENTION) {
    count += 1;
    end -= 1;
  }
  return count;
}

export function browserStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}
