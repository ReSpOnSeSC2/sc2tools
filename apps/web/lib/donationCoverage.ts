import { formatDate } from "@/lib/i18n/format";

export interface CoverageMonth {
  month: string;
  receivedUsd: number;
  supporterCount: number;
  updatedAt: string;
}

export interface Coverage extends CoverageMonth {
  monthLabel: string;
  goalUsd: number;
  percent: number;
  covered: boolean;
}

const STALE_MS = 45 * 86400_000;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/u;

export function currentCoverage(row: CoverageMonth | null | undefined, goalUsd: number, now = new Date()): Coverage | null {
  if (!row || !Number.isFinite(goalUsd) || goalUsd <= 0 || !MONTH_RE.test(row.month)
      || row.month > now.toISOString().slice(0, 7)
      || !Number.isFinite(row.receivedUsd) || row.receivedUsd < 0
      || !Number.isSafeInteger(row.supporterCount) || row.supporterCount < 0) return null;
  const updated = Date.parse(row.updatedAt);
  if (!Number.isFinite(updated) || updated > now.getTime() || now.getTime() - updated > STALE_MS) return null;
  const ratio = row.receivedUsd / goalUsd;
  return {
    ...row,
    monthLabel: formatDate(new Date(`${row.month}-01T00:00:00Z`), { month: "long", year: "numeric", timeZone: "UTC" }),
    goalUsd,
    percent: Math.min(100, Math.round(ratio * 100)),
    covered: ratio >= 1,
  };
}

export function recurringDonationUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    if (url.hostname === "github.com") return url.pathname.startsWith("/sponsors/") ? url.href : null;
    return ["ko-fi.com", "www.ko-fi.com", "paypal.com", "www.paypal.com"].includes(url.hostname) ? url.href : null;
  } catch {
    return null;
  }
}
