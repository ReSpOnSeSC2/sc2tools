import type { SessionOutcome } from "@/lib/sessionHistory";
import { sessionCount } from "./sessionCardFormat";

const RESULT = {
  W: { label: "Win", className: "border-success text-success" },
  L: { label: "Loss", className: "border-danger text-danger" },
  U: { label: "Unknown", className: "border-border-strong text-text-muted" },
};
const MAX_PIPS = 12;

export function SessionResultStrip({ results }: { results: string }) {
  const visible = results.slice(-MAX_PIPS);
  const omitted = results.length - visible.length;
  return <div className="space-y-2">
    <p className="text-caption text-text-dim">Latest {sessionCount(visible.length, "result")} · oldest to newest</p>
    <ol aria-label={`Latest ${sessionCount(visible.length, "result")}, oldest to newest`} className="flex flex-wrap gap-1.5">
      {Array.from(visible, (value, index) => {
        const outcome: SessionOutcome = value === "W" || value === "L" ? value : "U";
        const item = RESULT[outcome];
        return <li key={index} aria-label={`Game ${omitted + index + 1}: ${item.label}`}>
          <span aria-hidden="true" className={`flex h-6 w-6 items-center justify-center rounded border text-micro font-bold ${item.className}`}>{outcome}</span>
        </li>;
      })}
    </ol>
    {omitted > 0 ? <p className="text-caption text-text-dim">{sessionCount(omitted, "earlier result")} in session details.</p> : null}
  </div>;
}
