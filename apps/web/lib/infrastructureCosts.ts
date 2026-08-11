import { getJson } from "@/lib/serverApi";

/** Public-list planning baseline used only when live Atlas billing is absent. */
export const FIXED_MONTHLY_FALLBACK_USD = 65.19;
/** Render Starter ($7) plus the domain monthly equivalent ($1.25). */
export const NON_MONGO_FIXED_MONTHLY_USD = 8.25;

export interface MongoAppDataUsage {
  logicalDataBytes: number;
  allocatedDocumentBytes: number;
  allocatedIndexBytes: number;
  allocatedTotalBytes: number;
  measuredAt: string;
  scope: "sc2tools_database_only";
}

export interface AtlasClusterUsage {
  tier: string | null;
  provisionedDiskGb: number | null;
  diskUsedBytes: number | null;
  diskCapacityBytes: number | null;
  diskMeasuredAt: string | null;
  autoExpandStorage: boolean;
}

export interface AtlasBillingUsage {
  available: boolean;
  cycleStart: string | null;
  cycleEnd: string | null;
  postedThrough: string | null;
  postedCycleCents: number | null;
  categoryCents: {
    compute: number;
    storage: number;
    transfer: number;
    other: number;
  } | null;
  projectedMonthlyRunRateUsd: number | null;
}

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
  mongo: {
    appData: MongoAppDataUsage;
    atlas: {
      available: boolean;
      cluster: AtlasClusterUsage | null;
      billing: AtlasBillingUsage | null;
    };
    planning: {
      monthlyUsd: number;
    };
  };
  site: {
    nonMongoFixedMonthlyUsd: number;
    pricingMode: "atlas_projected" | "planning_fallback";
    estimatedCurrentMonthlyTotalUsd: number;
  };
}

export interface MonthlyCostSummary {
  mode: "atlas_projected" | "planning_fallback";
  baseUsd: number;
  atlasUsd: number;
  r2Usd: number;
  totalUsd: number;
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
  const mongo = record(root?.mongo);
  const appData = record(mongo?.appData);
  const atlas = record(mongo?.atlas);
  const cluster = atlas?.cluster === null ? null : record(atlas?.cluster);
  const billing = atlas?.billing === null ? null : record(atlas?.billing);
  const categoryCents = billing?.categoryCents === null
    ? null
    : record(billing?.categoryCents);
  const planning = record(mongo?.planning);
  const site = record(root?.site);

  if (
    !root ||
    !archive ||
    !r2 ||
    !estimatedCostUsd ||
    !mongo ||
    !appData ||
    !atlas ||
    !planning ||
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
    !nonNegativeInteger(appData.logicalDataBytes) ||
    !nonNegativeInteger(appData.allocatedDocumentBytes) ||
    !nonNegativeInteger(appData.allocatedIndexBytes) ||
    !nonNegativeInteger(appData.allocatedTotalBytes) ||
    appData.allocatedTotalBytes !==
      appData.allocatedDocumentBytes + appData.allocatedIndexBytes ||
    appData.scope !== "sc2tools_database_only" ||
    !validDate(appData.measuredAt) ||
    typeof atlas.available !== "boolean" ||
    !validAtlasCluster(cluster) ||
    !validAtlasBilling(billing, categoryCents) ||
    !nonNegativeFinite(planning.monthlyUsd) ||
    !nonNegativeFinite(site.nonMongoFixedMonthlyUsd) ||
    (site.pricingMode !== "atlas_projected" &&
      site.pricingMode !== "planning_fallback") ||
    !nonNegativeFinite(site.estimatedCurrentMonthlyTotalUsd)
  ) {
    return null;
  }

  return value as InfrastructureCosts;
}

/**
 * Recalculate the public monthly run-rate from its named components. This
 * prevents a partial current-cycle Atlas charge from ever being presented as
 * a full-month total and keeps older planning data visibly in fallback mode.
 */
export function monthlyCostSummary(
  costs: InfrastructureCosts,
): MonthlyCostSummary {
  const projectedAtlas = costs.mongo.atlas.billing?.available
    ? costs.mongo.atlas.billing.projectedMonthlyRunRateUsd
    : null;
  const hasAtlasProjection =
    projectedAtlas !== null && nonNegativeFinite(projectedAtlas);
  const baseUsd = hasAtlasProjection
    ? costs.site.nonMongoFixedMonthlyUsd
    : costs.site.nonMongoFixedMonthlyUsd + costs.mongo.planning.monthlyUsd;
  const atlasUsd = hasAtlasProjection
    ? projectedAtlas
    : costs.mongo.planning.monthlyUsd;
  const r2Usd = costs.r2.estimatedCostUsd.currentMonthly;
  return {
    mode: hasAtlasProjection ? "atlas_projected" : "planning_fallback",
    baseUsd,
    atlasUsd,
    r2Usd,
    totalUsd: baseUsd + (hasAtlasProjection ? atlasUsd : 0) + r2Usd,
  };
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

/** Binary units match Atlas disk metrics, whose dashboard GB label is GiB. */
export function formatBinaryStorageBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unavailable";
  const kib = 1024;
  const mib = kib ** 2;
  const gib = kib ** 3;
  const tib = kib ** 4;
  if (bytes < kib) return `${Math.round(bytes)} B`;
  if (bytes < mib) return `${compactDecimal(bytes / kib)} KiB`;
  if (bytes < gib) return `${compactDecimal(bytes / mib)} MiB`;
  if (bytes < tib) return `${compactDecimal(bytes / gib)} GiB`;
  return `${compactDecimal(bytes / tib)} TiB`;
}

export function formatAtlasDiskBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unavailable";
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
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

function nullableDate(value: unknown): value is string | null {
  return value === null || validDate(value);
}

function nullableNonNegativeFinite(value: unknown): value is number | null {
  return value === null || nonNegativeFinite(value);
}

function nullableNonNegativeInteger(value: unknown): value is number | null {
  return value === null || nonNegativeInteger(value);
}

function nullableString(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length > 0);
}

function validAtlasCluster(
  cluster: Record<string, unknown> | null,
): boolean {
  if (cluster === null) return true;
  return (
    nullableString(cluster.tier) &&
    nullableNonNegativeFinite(cluster.provisionedDiskGb) &&
    nullableNonNegativeInteger(cluster.diskUsedBytes) &&
    nullableNonNegativeInteger(cluster.diskCapacityBytes) &&
    nullableDate(cluster.diskMeasuredAt) &&
    typeof cluster.autoExpandStorage === "boolean"
  );
}

function validAtlasBilling(
  billing: Record<string, unknown> | null,
  categoryCents: Record<string, unknown> | null,
): boolean {
  if (billing === null) return true;
  return (
    typeof billing.available === "boolean" &&
    nullableDate(billing.cycleStart) &&
    nullableDate(billing.cycleEnd) &&
    nullableDate(billing.postedThrough) &&
    nullableNonNegativeInteger(billing.postedCycleCents) &&
    nullableNonNegativeFinite(billing.projectedMonthlyRunRateUsd) &&
    (categoryCents === null ||
      (nonNegativeInteger(categoryCents.compute) &&
        nonNegativeInteger(categoryCents.storage) &&
        nonNegativeInteger(categoryCents.transfer) &&
        nonNegativeInteger(categoryCents.other)))
  );
}
