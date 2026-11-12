import { DAILY_ROOT, MAX_PACK_BYTES, packDirectory, readDailyIndex, readDailyPack, type DailyPack } from "./clip";
import type { DailyKind } from "./progress";
import { practiceDay } from "./rules";

export type LoadedDay = { pack: DailyPack; kind: DailyKind; directory: string };

async function jsonAt(path: string, signal: AbortSignal, maxBytes: number, noCache = false): Promise<unknown> {
  const response = await fetch(path, { signal, ...(noCache ? { cache: "no-cache" } : {}) });
  if (!response.ok || Number(response.headers.get("content-length")) > maxBytes) throw new Error("Daily file unavailable.");
  const contents = await response.text();
  if (contents.length > maxBytes) throw new Error("Daily file exceeds its size limit.");
  return JSON.parse(contents);
}

export async function loadDaily(day: number, signal: AbortSignal): Promise<LoadedDay> {
  const index = readDailyIndex(await jsonAt(DAILY_ROOT + "/index.json", signal, 40_000, true));
  if (!index) throw new Error("Daily schedule is invalid.");
  const published = index.days[day];
  const directory = packDirectory(published ?? index.practice[practiceDay(day)]);
  const pack = readDailyPack(await jsonAt(directory + "/pack.json", signal, MAX_PACK_BYTES));
  if (!pack) throw new Error("Daily set is invalid.");
  return { pack, kind: published ? "recorded" : "practice", directory };
}
