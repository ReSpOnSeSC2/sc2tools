import { FIGHTS_PER_DAY } from "./rules";

export type DailyKind = "recorded" | "practice";
export type DailyResults = Record<number, boolean[]>;
const RETENTION = 366;

function storageKey(kind: DailyKind): string {
  return "sc2tools:daily:v1:" + kind;
}

function isResult(value: unknown): value is boolean[] {
  return Array.isArray(value) && value.length === FIGHTS_PER_DAY && value.every(result => typeof result === "boolean");
}

export function readResults(storage: Pick<Storage, "getItem">, kind: DailyKind): DailyResults {
  try {
    const raw: unknown = JSON.parse(storage.getItem(storageKey(kind)) ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const entries = Object.entries(raw).filter(([day, results]) => /^[1-9][0-9]{0,5}$/.test(day) && isResult(results));
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

export function completeDay(storage: Pick<Storage, "getItem" | "setItem"> | null, kind: DailyKind, day: number, results: boolean[]): DailyResults {
  const previous = storage ? readResults(storage, kind) : {};
  if (previous[day]) return previous;
  const current = { ...previous, [day]: results };
  const days = Object.keys(current).map(Number).sort((a, b) => b - a).slice(0, RETENTION);
  const retained = Object.fromEntries(days.map(value => [value, current[value]]));
  try {
    storage?.setItem(storageKey(kind), JSON.stringify(retained));
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
