import type { PaceGap } from "@/lib/instant/gmGap";

const TITLE = "Pace gap versus a 5,300-MMR reference";

function timing(seconds: number | null): string {
  if (seconds === null) return "Not reached by 4:30";
  if (seconds === 0) return "At reference pace";
  return `${Math.abs(seconds)} s ${seconds > 0 ? "later" : "earlier"}`;
}

function PaceMeasurements({ result }: { result: Extract<PaceGap, { kind: "measured" }> }) {
  const era = result.era === "before" ? "8-worker patch era" : "12-worker patch era";
  return <>
    <p className="text-caption text-text-muted">
      {result.matchup} · {era} · {result.games} reference games · {result.opponents} distinct opponents
    </p>
    <dl className="grid gap-2 sm:grid-cols-2">
      <div>
        <dt className="text-caption text-text-muted">Worker count</dt>
        <dd className="font-semibold tabular-nums text-text">{timing(result.workers)}</dd>
      </div>
      <div>
        <dt className="text-caption text-text-muted">Total minerals and gas collected</dt>
        <dd className="font-semibold tabular-nums text-text">{timing(result.income)}</dd>
      </div>
    </dl>
    <p className="text-caption text-text-muted">
      Times compare when you and the reference first reached its 4:00 values. A different opening or worker losses can change the comparison.
    </p>
  </>;
}

function unavailable(result: Exclude<PaceGap, { kind: "measured" }>): string {
  if (result.kind === "not-ladder") return "This comparison is available for confirmed one-on-one ladder games.";
  if (result.kind === "short") return "A game needs to last at least 4:30 for this comparison.";
  if (result.kind === "missing-samples") return "This replay has too little opening economy data to compare.";
  return result.matchup ? `No reference yet for ${result.matchup} in this patch era.` : "No reference yet for this game.";
}

export function PaceGapCard({ result }: { result: PaceGap }) {
  return (
    <section aria-label={TITLE}
      className="min-w-0 space-y-2 rounded-xl border border-line bg-bg-surface px-4 py-3">
      <h5 className="font-display text-h4 text-text">{TITLE}</h5>
      {result.kind === "measured" ? <PaceMeasurements result={result} /> :
        <p className="text-caption text-text-muted">{unavailable(result)}</p>}
      {result.allIn ? <p className="text-caption text-text-muted">The replay labels an all-in. The opening may trade economy for attack timing.</p> : null}
    </section>
  );
}
