import ledger from "./donate/coverage.json";
import { formatDate } from "@/lib/i18n/format";

/**
 * The /donate coverage meter: "Is this month covered?"
 *
 * Totals come from lib/donate/coverage.json, which the owner edits by hand
 * from their own donation receipts. Nothing here calls a payment provider.
 * The goal is the site's monthly running cost (the live run-rate from
 * monthlyCostSummary, or the planning baseline). The meter hides itself
 * when the newest entry is older than 45 days, so a forgotten update never
 * shows a stale claim.
 *
 * Example:
 *   currentCoverage([{ month: "2026-11", receivedUsd: 41, supporterCount: 3, updatedAt: "2026-11-10" }], 78, new Date("2026-11-12"))
 *   // -> { monthLabel: "November 2026", receivedUsd: 41, goalUsd: 78, percent: 53, ... }
 */

export interface CoverageMonth {
  /** "YYYY-MM" (UTC calendar month). */
  month: string;
  receivedUsd: number;
  supporterCount: number;
  /** "YYYY-MM-DD", when the owner last updated this month's total. */
  updatedAt: string;
}

export interface Coverage extends CoverageMonth {
  monthLabel: string;
  goalUsd: number;
  /** 0–100, rounded; 100 once the goal is met. */
  percent: number;
  covered: boolean;
}

export const COVERAGE_STALE_DAYS = 45;
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Valid entries only, newest month first; a malformed entry is dropped. */
export function parseCoverageLedger(raw: unknown): CoverageMonth[] {
  const months = raw && typeof raw === "object" && Array.isArray((raw as { months?: unknown }).months)
    ? (raw as { months: unknown[] }).months
    : [];
  const valid: CoverageMonth[] = [];
  for (const entry of months) {
    if (!entry || typeof entry !== "object") continue;
    const { month, receivedUsd, supporterCount, updatedAt } = entry as Record<string, unknown>;
    if (typeof month !== "string" || !MONTH_RE.test(month)) continue;
    if (typeof receivedUsd !== "number" || !Number.isFinite(receivedUsd) || receivedUsd < 0) continue;
    if (typeof supporterCount !== "number" || !Number.isSafeInteger(supporterCount) || supporterCount < 0) continue;
    if (typeof updatedAt !== "string" || !DATE_RE.test(updatedAt) || !Number.isFinite(Date.parse(`${updatedAt}T00:00:00Z`))) continue;
    valid.push({ month, receivedUsd, supporterCount, updatedAt });
  }
  return valid.sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0));
}

/**
 * The newest month that has started, or null when there is none, it is
 * stale, or the goal is unknown.
 */
export function currentCoverage(months: readonly CoverageMonth[], goalUsd: number, now: Date = new Date()): Coverage | null {
  if (!Number.isFinite(goalUsd) || goalUsd <= 0) return null;
  const thisMonth = now.toISOString().slice(0, 7);
  const entry = months.find((item) => item.month <= thisMonth);
  if (!entry) return null;
  const updated = Date.parse(`${entry.updatedAt}T00:00:00Z`);
  if (!Number.isFinite(updated) || now.getTime() - updated > COVERAGE_STALE_DAYS * DAY_MS) return null;
  const [year, month] = entry.month.split("-").map(Number);
  const ratio = entry.receivedUsd / goalUsd;
  return {
    ...entry,
    monthLabel: formatDate(new Date(Date.UTC(year, month - 1, 1)), { month: "long", year: "numeric", timeZone: "UTC" }),
    goalUsd,
    percent: Math.min(100, Math.round(ratio * 100)),
    covered: ratio >= 1,
  };
}

/** The checked-in ledger against this month's running cost. */
export function getCoverage(goalUsd: number, now?: Date): Coverage | null {
  return currentCoverage(parseCoverageLedger(ledger), goalUsd, now);
}
