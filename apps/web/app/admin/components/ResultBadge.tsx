import { Badge } from "@/components/ui/Badge";
import { RESULT_BADGE_LABEL, resultOf, type AdminResultClass } from "./adminResult";

const VARIANT: Record<AdminResultClass, "success" | "danger" | "neutral"> = { win: "success", loss: "danger", tie: "neutral", unknown: "neutral" };

/**
 * Win (success), Loss (danger), Tie (neutral), or a neutral dash read as
 * "Result not recorded". Only an explicit defeat/loss is ever a Loss.
 * ``cls`` renders an already-classified result (the summary's last-10 row).
 */
export function ResultBadge({ result, cls, size }: { result?: string | null; cls?: AdminResultClass; size?: "sm" }) {
  const kind = cls ?? resultOf(result);
  return (
    <span className="inline-flex rounded-full bg-bg-surface">
      <Badge variant={VARIANT[kind]} size={size}>
        {kind === "unknown" ? <><span aria-hidden="true" title={RESULT_BADGE_LABEL.unknown}>—</span><span className="sr-only">{RESULT_BADGE_LABEL.unknown}</span></> : RESULT_BADGE_LABEL[kind]}
      </Badge>
    </span>
  );
}
