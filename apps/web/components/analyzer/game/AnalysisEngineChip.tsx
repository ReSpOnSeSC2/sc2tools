import Link from "next/link";

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]{1,32})?$/;

/** The reported analysis engine of an owner's game, linked to Re-analyze games. */
export function AnalysisEngineChip({ engineVersion }: { engineVersion?: string | null }) {
  const version = typeof engineVersion === "string" && engineVersion.length <= 40 && VERSION.test(engineVersion) ? engineVersion : null;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5" data-testid="analysis-engine">
      <span>{version ? `Analyzed with engine ${version}` : "Engine version unknown"}</span>
      <span aria-hidden className="text-text-dim">·</span>
      <Link
        href="/settings?tab=backups#reanalyze"
        className="rounded font-medium text-accent-cyan hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        Re-analyze
      </Link>
    </span>
  );
}
