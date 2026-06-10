"use client";

/**
 * Position-by-position timing comparison: when each step of the
 * reference build happened on the old patch vs when the same step is
 * reachable on the adapted patch.
 */
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { formatBuildTime, humanizeBuildName } from "@/lib/build-events";
import type { AdaptResult } from "@/lib/optimizer/types";

function deltaBadge(deltaSec: number | undefined) {
  if (deltaSec === undefined) {
    return (
      <Badge variant="warning" size="sm">
        not reached
      </Badge>
    );
  }
  const rounded = Math.round(deltaSec);
  if (Math.abs(rounded) <= 2) {
    return (
      <Badge variant="neutral" size="sm">
        ±0s
      </Badge>
    );
  }
  return (
    <Badge variant={rounded > 0 ? "warning" : "success"} size="sm">
      {rounded > 0 ? `+${rounded}s later` : `${Math.abs(rounded)}s earlier`}
    </Badge>
  );
}

export function ComparisonView({ result }: { result: AdaptResult | null }) {
  if (!result || result.comparison.length === 0) return null;
  // Patch-native builds have no older incarnation to compare against.
  if (result.baselineProfileId === result.profileId) return null;
  return (
    <Card title={`Timing shifts: ${result.baselineProfileId} → ${result.profileId}`}>
      <div className="p-4">
        <ul className="space-y-1">
          {result.comparison.map((row, index) => (
            <li
              key={`${index}-${row.name}`}
              className="flex items-center gap-3 rounded-md px-2 py-1 hover:bg-bg-elevated"
            >
              <Icon name={row.name} size="sm" fallback="" decorative />
              <span className="flex-1 text-body text-text">
                {humanizeBuildName(row.name)}
              </span>
              <span className="font-mono text-caption text-text-dim">
                {row.baselineStartSec !== undefined
                  ? `${row.baselineSupply} @ ${formatBuildTime(row.baselineStartSec)}`
                  : "—"}
              </span>
              <span aria-hidden className="text-text-dim">
                →
              </span>
              <span className="font-mono text-caption text-text">
                {row.adaptedStartSec !== undefined
                  ? `${row.adaptedSupply} @ ${formatBuildTime(row.adaptedStartSec)}`
                  : "—"}
              </span>
              {deltaBadge(row.deltaSec)}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-caption text-text-dim">
          Supply stamps and times on the left are the build on{" "}
          {result.baselineProfileId} (12 workers); on the right, the same step
          re-timed for {result.profileId}. &ldquo;Not reached&rdquo; means the
          step didn&apos;t fit inside the simulated window on one of the
          patches.
        </p>
      </div>
    </Card>
  );
}
