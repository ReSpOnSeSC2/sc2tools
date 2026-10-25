import { readReferenceBuildOrder } from "@/lib/buildOrderReference";
import { humanizeRuleEntity } from "@/lib/build-rules-copy";

/** The reference is a practice plan, independently of classification rules. */
export function BuildOrderSteps({ value }: { value: unknown }) {
  const order = readReferenceBuildOrder(value);
  if (!order?.steps.length) return null;
  return <section aria-label="Reference build order" className="min-w-0 space-y-3 rounded-xl border border-border bg-bg-surface p-4">
    <h2 className="text-h4 font-semibold">Reference build order</h2>
    <p className="text-caption text-text-muted">A supplied practice plan. These steps do not decide which replays match this build. — means the time or supply was not supplied; ≈ marks approximate supply.</p>
    <ol className="space-y-2">{order.steps.map((step, index) => <li key={index} className="grid min-w-0 grid-cols-[3.5rem_3rem_minmax(0,1fr)] gap-2 border-t border-border py-2 text-caption">
      <span className="font-mono tabular-nums" aria-label={step.t === null ? "Time unknown" : undefined}>{step.t === null ? "—" : `${Math.floor(step.t / 60)}:${String(step.t % 60).padStart(2, "0")}`}</span>
      <span className="font-mono tabular-nums" aria-label={step.supply === null ? "Supply unknown" : `${step.supplyApprox ? "Approximate supply" : "Supply"} ${step.supply}`}>{step.supply === null ? "—" : `${step.supplyApprox ? "≈" : ""}${step.supply}`}</span>
      <span className="min-w-0 break-words"><span className="font-medium">{humanizeRuleEntity(step.action)}</span>{step.note ? <span className="mt-1 block text-text-muted">{step.note}</span> : null}</span>
    </li>)}</ol>
  </section>;
}
