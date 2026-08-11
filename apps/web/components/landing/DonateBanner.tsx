import Link from "next/link";
import { ArrowRight, Heart } from "lucide-react";
import {
  FIXED_MONTHLY_FALLBACK_USD,
  formatAtlasDiskBytes,
  formatBinaryStorageBytes,
  formatCostSnapshotTime,
  formatReplayCount,
  formatStorageBytes,
  formatUsd,
  monthlyCostSummary,
  type InfrastructureCosts,
} from "@/lib/infrastructureCosts";

export function DonateBanner({ costs }: { costs: InfrastructureCosts | null }) {
  const summary = costs ? monthlyCostSummary(costs) : null;
  const cluster = costs?.mongo.atlas.cluster;
  const billing = costs?.mongo.atlas.billing;
  const hasAtlasDisk =
    cluster?.diskUsedBytes !== null &&
    cluster?.diskUsedBytes !== undefined &&
    cluster.diskCapacityBytes !== null;

  return (
    <section className="mt-24 md:mt-32">
      <div className="grid items-center gap-6 rounded-md border-2 border-line bg-bg-surface p-6 shadow-hard md:grid-cols-[auto_minmax(0,1fr)_auto] md:gap-8 md:p-8">
        <span
          aria-hidden
          className="inline-flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-md border-2 border-editorial/40 bg-editorial/10 text-editorial"
        >
          <Heart className="h-7 w-7" />
        </span>
        <div className="space-y-1.5">
          <p className="kicker">What it costs</p>
          <h2 className="font-serif text-h3 font-semibold tracking-[-0.01em] text-text md:text-h2">
            {summary
              ? costs?.stale
                ? `Free for players — about ${formatUsd(summary.totalUsd)} a month from the latest available provider snapshot.`
                : `Free for players — about ${formatUsd(summary.totalUsd)} a month at today’s projected run rate.`
              : `Free for players — ${formatUsd(FIXED_MONTHLY_FALLBACK_USD)} monthly planning baseline.`}
          </h2>
          {costs ? (
            <p className="text-body text-text-muted">
              SC2 Tools has verified{" "}
              {formatReplayCount(costs.archive.verifiedOriginalReplays)} original{" "}
              {costs.archive.verifiedOriginalReplays === 1 ? "replay" : "replays"}
              {" "}in its private archive. Original files and analysis objects
              currently use {formatStorageBytes(costs.archive.r2StoredBytes)} in
              Cloudflare R2, an estimated{" "}
              {formatUsd(costs.r2.estimatedCostUsd.currentMonthly)}/month at the
              current storage run-rate and measured operation usage.{" "}
              {hasAtlasDisk ? (
                <>
                  Atlas reports {formatAtlasDiskBytes(cluster!.diskUsedBytes!)}{" "}
                  of {formatAtlasDiskBytes(cluster!.diskCapacityBytes!)} disk
                  used (binary GiB), while the SC2 Tools database itself uses{" "}
                  {formatBinaryStorageBytes(
                    costs.mongo.appData.allocatedTotalBytes,
                  )}{" "}
                  allocated and{" "}
                  {formatBinaryStorageBytes(costs.mongo.appData.logicalDataBytes)}{" "}
                  logical data.{" "}
                </>
              ) : (
                <>
                  The SC2 Tools database uses{" "}
                  {formatBinaryStorageBytes(
                    costs.mongo.appData.allocatedTotalBytes,
                  )}{" "}
                  allocated and{" "}
                  {formatBinaryStorageBytes(costs.mongo.appData.logicalDataBytes)}{" "}
                  logical data; live Atlas disk telemetry is unavailable.{" "}
                </>
              )}
              {billing?.available &&
              billing.postedCycleCents !== null &&
              billing.postedThrough ? (
                <>
                  Atlas has posted {formatUsd(billing.postedCycleCents / 100)}{" "}
                  this billing cycle through{" "}
                  {formatCostSnapshotTime(billing.postedThrough)}; that is not
                  a full-month invoice.{" "}
                </>
              ) : (
                <>
                  Live Atlas billing is unavailable, so this uses the{" "}
                  {formatUsd(FIXED_MONTHLY_FALLBACK_USD)} planning fallback
                  plus the live R2 estimate.{" "}
                </>
              )}
              {summary?.mode === "atlas_projected"
                ? `The monthly total uses ${formatUsd(costs.site.nonMongoFixedMonthlyUsd)} of non-Mongo fixed costs plus a ${formatUsd(summary.atlasUsd)} projected Atlas run rate and ${formatUsd(summary.r2Usd)} R2 estimate.`
                : `The monthly total is the planning fallback + live R2 estimate: ${formatUsd(FIXED_MONTHLY_FALLBACK_USD)} + ${formatUsd(summary?.r2Usd ?? 0)}.`}{" "}
              Projections are estimates; provider dashboards remain
              authoritative.{" "}
              <span className="text-caption text-text-dim">
                {costs.stale
                  ? "Last successful provider snapshot"
                  : "Provider usage snapshot measured"}{" "}
                {formatCostSnapshotTime(costs.asOf)}
                {costs.stale
                  ? "; live refresh is currently delayed."
                  : "."}
              </span>
            </p>
          ) : (
            <p className="text-body text-text-muted">
              The public-list-price base covers MongoDB Atlas, one always-on
              Render API and the domain. Live archive usage is temporarily
              unavailable, so no Cloudflare R2 amount has been guessed. Vercel
              and Clerk currently remain within their included allowances.
            </p>
          )}
        </div>
        <Link
          href="/donate"
          className="inline-flex h-12 items-center justify-center gap-2 rounded-md bg-accent px-5 text-body-lg font-semibold text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg md:self-center"
        >
          See the full cost breakdown
          <ArrowRight className="h-5 w-5" aria-hidden />
        </Link>
      </div>
    </section>
  );
}
