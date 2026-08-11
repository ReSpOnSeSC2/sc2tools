import { getJson } from "@/lib/serverApi";

export const FIXED_MONTHLY_FALLBACK_USD = 65.19;

export interface InfrastructureCosts {
  asOf: string;
  stale: boolean;
  estimate: true;
  archive: {
    verifiedOriginalReplays: number;
    r2StoredBytes: number;
    r2ObjectCount: number;
    includes: "originals_and_analysis";
  };
  r2: {
    cycleStart: string;
    classARequests: number;
    classBRequests: number;
    unknownRequests: number;
    estimatedCostUsd: {
      storageRunRate: number;
      classAThisCycle: number;
      classBThisCycle: number;
      currentMonthly: number;
    };
  };
  site: {
    fixedMonthlyEquivalentUsd: number;
    estimatedCurrentMonthlyTotalUsd: number;
  };
}

/**
 * Fetch the public, aggregate-only infrastructure snapshot. Next's Data
 * Cache keeps the marketing pages fast and prevents page traffic from
 * multiplying Cloudflare Analytics requests. The API may deliberately return
 * no usable snapshot while its provider data is unavailable; callers must
 * render the fixed base and an explicit unavailable state instead of guessing
 * that R2 usage is zero.
 */
export async function getInfrastructureCosts(): Promise<InfrastructureCosts | null> {
  const value = await getJson<unknown>("/v1/public/infrastructure-costs", {
    revalidateSec: 900,
  });
  return normalizeInfrastructureCosts(value);
}

/** Runtime validation keeps malformed or partial upstream responses out of
 * public cost claims. A missing number is materially different from zero. */
export function normalizeInfrastructureCosts(
  value: unknown,
): InfrastructureCosts | null {
  const root = record(value);
  const archive = record(root?.archive);
  const r2 = record(root?.r2);
  const estimatedCostUsd = record(r2?.estimatedCostUsd);
  const site = record(root?.site);

  if (
    !root ||
    !archive ||
    !r2 ||
    !estimatedCostUsd ||
    !site ||
    !validDate(root.asOf) ||
    typeof root.stale !== "boolean" ||
    root.estimate !== true ||
    archive.includes !== "originals_and_analysis" ||
    !nonNegativeInteger(archive.verifiedOriginalReplays) ||
    !nonNegativeFinite(archive.r2StoredBytes) ||
    !nonNegativeInteger(archive.r2ObjectCount) ||
    !validDate(r2.cycleStart) ||
    !nonNegativeInteger(r2.classARequests) ||
    !nonNegativeInteger(r2.classBRequests) ||
    !nonNegativeInteger(r2.unknownRequests) ||
    !nonNegativeFinite(estimatedCostUsd.storageRunRate) ||
    !nonNegativeFinite(estimatedCostUsd.classAThisCycle) ||
    !nonNegativeFinite(estimatedCostUsd.classBThisCycle) ||
    !nonNegativeFinite(estimatedCostUsd.currentMonthly) ||
    !nonNegativeFinite(site.fixedMonthlyEquivalentUsd) ||
    !nonNegativeFinite(site.estimatedCurrentMonthlyTotalUsd)
  ) {
    return null;
  }

  return value as InfrastructureCosts;
}

/** Decimal units match Cloudflare's GB-month pricing language. */
export function formatStorageBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unavailable";
  if (bytes < 1_000) return `${Math.round(bytes)} B`;
  if (bytes < 1_000_000) return `${compactDecimal(bytes / 1_000)} KB`;
  if (bytes < 1_000_000_000) return `${compactDecimal(bytes / 1_000_000)} MB`;
  if (bytes < 1_000_000_000_000) {
    return `${compactDecimal(bytes / 1_000_000_000)} GB`;
  }
  return `${compactDecimal(bytes / 1_000_000_000_000)} TB`;
}

export function formatReplayCount(count: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(
    count,
  );
}

export function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatCostSnapshotTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown time";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(date);
}

function compactDecimal(value: number): string {
  const maximumFractionDigits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits,
  }).format(value);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return nonNegativeFinite(value) && Number.isSafeInteger(value);
}

function validDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !Number.isNaN(new Date(value).getTime())
  );
}
