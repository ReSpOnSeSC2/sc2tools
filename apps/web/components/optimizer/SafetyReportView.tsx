"use client";

/**
 * Per-threat safety verdicts for the optimized build: margin per
 * attack wave, who's defending, and the binding constraint when a
 * wave is close ("Zealot completes 8s after this wave lands").
 */
import { Badge, type BadgeVariant } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { formatBuildTime } from "@/lib/build-events";
import type {
  AdaptResult,
  SafetyVerdict,
  ThreatSafetyReport,
} from "@/lib/optimizer/types";

const VERDICT_BADGE: Record<SafetyVerdict, BadgeVariant> = {
  safe: "success",
  risky: "warning",
  unsafe: "danger",
};

function marginText(margin: number): string {
  const pct = Math.round(margin * 100);
  return `${pct >= 0 ? "+" : ""}${pct}%`;
}

function ThreatReport({ report }: { report: ThreatSafetyReport }) {
  return (
    <div className="rounded-lg border-2 border-line bg-bg-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-body font-semibold text-text">
            {report.threatName}
          </span>
          <Badge variant={VERDICT_BADGE[report.verdict]} size="sm">
            {report.verdict}
          </Badge>
        </div>
        <span className="text-caption text-text-muted">
          worst margin {marginText(report.worstMargin)}
        </span>
      </div>
      <ul className="mt-2 space-y-1.5">
        {report.waves.map((wave) => (
          <li key={wave.timeSec} className="text-caption">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-text-muted">
                {formatBuildTime(wave.timeSec)}
              </span>
              <span className="text-text">
                attack {wave.attackPower} vs defense {wave.defensePower}
              </span>
              <Badge variant={VERDICT_BADGE[wave.verdict]} size="sm">
                {marginText(wave.margin)}
              </Badge>
            </div>
            <div className="text-text-dim">
              {Object.entries(wave.defenders).length > 0 ? (
                <>
                  defending:{" "}
                  {Object.entries(wave.defenders)
                    .map(([name, count]) => `${count}× ${name}`)
                    .join(", ")}
                </>
              ) : (
                "no combat units ready"
              )}
              {wave.bindingNote ? ` — ${wave.bindingNote}` : ""}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SafetyReportView({ result }: { result: AdaptResult | null }) {
  if (!result || result.safety.threats.length === 0) return null;
  return (
    <Card
      title="Safety report"
      right={
        <Badge variant={VERDICT_BADGE[result.safety.overall]} size="sm">
          overall: {result.safety.overall}
        </Badge>
      }
    >
      <div className="space-y-3 p-4">
        {result.safety.threats.map((report) => (
          <ThreatReport key={report.threatId} report={report} />
        ))}
        <p className="text-caption text-text-dim">
          Margins are planning estimates from unit stats (no micro or
          positioning). Treat &ldquo;risky&rdquo; as &ldquo;needs perfect
          execution&rdquo;.
        </p>
      </div>
    </Card>
  );
}
