import { DAILY_ROOT, MAX_PACK_BYTES, packDirectory, readDailyIndex, readDailyPack, type DailyPack } from "./clip";
import type { DailyKind } from "./progress";
import { practiceDay } from "./rules";

type DailySlot = { kind: DailyKind; directory: string; digest: string };
export type LoadedDay = DailySlot & { pack: DailyPack };

export async function jsonAt(path: string, signal: AbortSignal, maxBytes: number, noCache = false): Promise<unknown> {
  const response = await fetch(path, { signal, ...(noCache ? { cache: "no-cache" } : {}) });
  if (!response.ok || Number(response.headers.get("content-length")) > maxBytes) throw new Error("Daily file unavailable.");
  const contents = await response.text();
  if (contents.length > maxBytes) throw new Error("Daily file exceeds its size limit.");
  return JSON.parse(contents);
}

export async function loadDailySlot(day: number, signal: AbortSignal, root: string, recordedOnly = false): Promise<DailySlot> {
  const index = readDailyIndex(await jsonAt(root + "/index.json", signal, 40_000, true));
  if (!index) throw new Error("Daily schedule is invalid.");
  const scheduled = index.days[day];
  const published = scheduled && !index.practice.includes(scheduled) ? scheduled : undefined;
  if (recordedOnly && !published) throw new Error("This recorded fight is no longer available.");
  const digest = published ?? index.practice[practiceDay(day)];
  const directory = packDirectory(digest, root);
  return { kind: published ? "recorded" : "practice", directory, digest };
}

export async function loadDaily(day: number, signal: AbortSignal, recordedOnly = false): Promise<LoadedDay> {
  const slot = await loadDailySlot(day, signal, DAILY_ROOT, recordedOnly);
  const pack = readDailyPack(await jsonAt(slot.directory + "/pack.json", signal, MAX_PACK_BYTES));
  if (!pack) throw new Error("Daily set is invalid.");
  return { ...slot, pack };
}
