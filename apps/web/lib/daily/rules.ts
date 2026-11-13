export const DAILY_ROUNDS = 5;
export const FIGHTS_PER_DAY = DAILY_ROUNDS;
export const PRACTICE_DAYS = 7;
export const DAY_MS = 86_400_000;

export const CALLS = [
  "Blue wins big",
  "Blue trades better",
  "Even trade",
  "Red trades better",
  "Red wins big",
] as const;
export type FightCall = 0 | 1 | 2 | 3 | 4;

const CUTS = [2 / 7, 4 / 9, 5 / 9, 5 / 7] as const;

export function utcDay(time: number): number {
  return Math.floor(time / DAY_MS);
}

export function practiceDay(day: number): number {
  return (day % PRACTICE_DAYS + PRACTICE_DAYS) % PRACTICE_DAYS;
}

function blueShare(blueLost: number, redLost: number): number {
  return redLost / (blueLost + redLost);
}

export function gradeTrade(blueLost: number, redLost: number): FightCall {
  const share = blueShare(blueLost, redLost);
  if (share > CUTS[3]) return 0;
  if (share > CUTS[2]) return 1;
  if (share >= CUTS[1]) return 2;
  return share >= CUTS[0] ? 3 : 4;
}

export function unambiguousTrade(blueLost: number, redLost: number): boolean {
  const share = blueShare(blueLost, redLost);
  return Number.isFinite(share) && CUTS.every(cut => Math.abs(cut - share) >= 0.03);
}

export function shareDaily(day: number, practice: boolean, correct: readonly boolean[], game = { title: "SC2 Daily", path: "/arcade" }): string {
  const date = new Date(day * DAY_MS).toISOString().slice(0, 10);
  const marks = correct.map(hit => hit ? "\u25a0" : "\u25a1").join("");
  const score = correct.filter(Boolean).length;
  return [game.title + (practice ? " practice" : "") + " \u00b7 " + date,
    marks + "  " + score + "/" + correct.length, "https://sc2tools.com" + game.path].join("\n");
}
