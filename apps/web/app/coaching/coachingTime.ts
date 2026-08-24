"use client";

import { useEffect, useState } from "react";
import type { ClientApiError } from "@/lib/clientApi";

export const COACHING_DAYS = [
  { day: 1, short: "Mon", long: "Monday" },
  { day: 2, short: "Tue", long: "Tuesday" },
  { day: 3, short: "Wed", long: "Wednesday" },
  { day: 4, short: "Thu", long: "Thursday" },
  { day: 5, short: "Fri", long: "Friday" },
  { day: 6, short: "Sat", long: "Saturday" },
  { day: 0, short: "Sun", long: "Sunday" },
] as const;

export const PRESET_SESSION_DURATIONS = [30, 60, 120] as const;

export function cloneAvailability(value: {
  timeZone: string;
  durations: number[];
  windows: Array<{ day: number; startMinute: number; endMinute: number }>;
}) {
  return {
    timeZone: value.timeZone,
    durations: [...value.durations],
    windows: value.windows.map((window) => ({ ...window })),
  };
}

export function useLocalTimeZone() {
  const [zone, setZone] = useState("UTC");
  useEffect(() => {
    try {
      setZone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    } catch {
      setZone("UTC");
    }
  }, []);
  return zone;
}

export function useZoneClock(timeZone: string) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30000);
    return () => window.clearInterval(timer);
  }, []);
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(now);
}

export function timeZoneOptions(current: string) {
  let zones: string[] = [];
  try {
    const intl = Intl as typeof Intl & {
      supportedValuesOf?: (key: "timeZone") => string[];
    };
    zones = intl.supportedValuesOf?.("timeZone") ?? [];
  } catch {
    zones = [];
  }
  return Array.from(new Set([current, "UTC", ...zones])).sort();
}

export function compareWindows(
  a: { day: number; startMinute: number },
  b: { day: number; startMinute: number },
) {
  return a.day - b.day || a.startMinute - b.startMinute;
}

export function clockValue(minutes: number) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export function minuteValue(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

export function fieldClass(extra = "") {
  return [
    "h-10 rounded-lg border border-border bg-bg px-3 text-caption text-text",
    "focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25",
    extra,
  ].join(" ");
}

export function formatDuration(minutes: number) {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest
    ? `${hours} hr ${rest} min`
    : `${hours} hour${hours === 1 ? "" : "s"}`;
}

export function formatDay(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(iso));
}

export function formatTime(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function formatRange(startAt: string, endAt: string, timeZone: string) {
  return `${formatTime(startAt, timeZone)}–${formatTime(endAt, timeZone)}`;
}

export function groupSlots<T extends { startAt: string }>(
  slots: T[],
  timeZone: string,
) {
  const map = new Map<string, { key: string; label: string; slots: T[] }>();
  const keyFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  for (const slot of slots) {
    const key = keyFormatter.format(new Date(slot.startAt));
    const current = map.get(key) ?? {
      key,
      label: formatDay(slot.startAt, timeZone),
      slots: [],
    };
    current.slots.push(slot);
    map.set(key, current);
  }
  return Array.from(map.values());
}

export function apiMessage(error: unknown) {
  const candidate = error as ClientApiError | undefined;
  return candidate && typeof candidate.message === "string"
    ? candidate.message
    : "Try again in a moment.";
}
