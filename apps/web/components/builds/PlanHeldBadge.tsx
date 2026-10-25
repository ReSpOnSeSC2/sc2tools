import { Badge } from "@/components/ui/Badge";
import { pct } from "@/lib/format";

/** The API supplies a rate only after five confirmed declarations. */
export function measuredPlanHeldRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function PlanHeldBadge({ rate }: { rate?: number | null }) {
  return measuredPlanHeldRate(rate) ? <Badge variant="neutral" size="sm" title="No different detector label in this share of at least five confirmed declarations. Labels do not prove execution.">Held {pct(rate)}</Badge> : null;
}
