import type { SessionRace, SessionRecord } from "@/lib/sessionHistory";

export type SessionCardSectionHeading = "h3" | "h4" | "h5";
const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const RACES = { P: "Protoss", T: "Terran", Z: "Zerg", R: "Random" };

export function sessionNumber(value: number | null): string {
  return value === null ? "Unavailable" : NUMBER.format(value);
}

export function sessionDate(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone,
  }).format(new Date(value));
}

export function sessionInstant(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric",
    minute: "2-digit", timeZone, timeZoneName: "short",
  }).format(new Date(value));
}

export function sessionMinutes(value: number | null): string {
  return value === null ? "Unavailable" : `${sessionNumber(value)} min`;
}

export function sessionRace(value: SessionRace): string {
  return value === null ? "Unknown" : RACES[value];
}

export function sessionRecord(value: SessionRecord): string {
  return `${value.wins} W · ${value.losses} L · ${value.unknown} unknown`;
}

export function sessionCount(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

export function sessionSample(value: SessionRecord): string {
  return `${value.wins + value.losses} decided of ${sessionCount(value.games, "game")}`;
}

export function recordedMmr(value: number | null): string {
  return value === null ? "—" : sessionNumber(value);
}

export function recordedChange(value: number | null): string {
  if (value === null) return "Unavailable (needs 2 samples)";
  return `${value > 0 ? "+" : ""}${sessionNumber(value)}`;
}
