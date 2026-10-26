import type { SeriesPoint } from "./activeArmyLayout";
import { formatMetricValue } from "./timelineMetrics";

/** All three values come from the same inspected stats sample. */
export function BankBreakdown({ my, opp, myName, oppName, label = "Bank breakdown", className = "" }: {
  my: SeriesPoint | null;
  opp: SeriesPoint | null;
  myName: string;
  oppName: string;
  label?: string;
  className?: string;
}) {
  return <div role="group" aria-label={label} className={`grid gap-2 sm:grid-cols-2 ${className}`}>
    {[
      { key: "my", name: myName, point: my, dot: "bg-player-you" },
      { key: "opp", name: oppName, point: opp, dot: "bg-player-opp" },
    ].map(({ key, name, point, dot }) => <section key={key} aria-label={`${name} bank breakdown`} className="min-w-0">
      <p className="flex min-w-0 items-center gap-1.5 text-micro font-semibold"><span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${dot}`} /><span className="truncate">{name}</span></p>
      <dl className="mt-1 grid grid-cols-3 gap-2 text-micro">
        {[
          { label: "Total", value: point?.bank },
          { label: "Minerals", value: point?.bankMinerals },
          { label: "Gas", value: point?.bankGas },
        ].map(({ label, value }) => <div key={label} className="min-w-0"><dt>{label}</dt><dd className="break-words font-semibold tabular-nums">{formatMetricValue(value)}</dd></div>)}
      </dl>
    </section>)}
  </div>;
}
