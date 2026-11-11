import type { AdminDailyEvent } from "./adminTypes";

export const ADMIN_DAILY_SERIES = [
  { key: "user_signup", label: "Signups" },
  { key: "agent_download", label: "Download clicks" },
  { key: "agent_connected", label: "First connections" },
] as const;

type EventKey = typeof ADMIN_DAILY_SERIES[number]["key"];

export function dailyTotal(days: AdminDailyEvent[], key: EventKey): number {
  return days.reduce((total, day) => total + day[key], 0);
}

export function weekOverWeek(days: AdminDailyEvent[], key: EventKey): string | null {
  // Exclude the partially recorded current UTC day from both comparisons.
  if (days.length < 15) return null;
  const current = dailyTotal(days.slice(-8, -1), key);
  const prior = dailyTotal(days.slice(-15, -8), key);
  if (prior === 0) return current ? "new vs last week" : null;
  const percent = Math.round((current - prior) * 100 / prior);
  return (percent > 0 ? "+" : "") + percent + "% vs last week";
}
