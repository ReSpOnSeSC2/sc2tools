import { resultLabel } from "@/components/analyzer/game/types";
import { Badge } from "@/components/ui/Badge";

/** Admin rows share the replay result aliases without treating unknowns as losses. */
export function ResultBadge({ result }: { result?: string | null }) {
  const label = resultLabel(result);
  const variant = label === "Win" ? "success" : label === "Loss" ? "danger" : "neutral";
  return (
    <Badge variant={variant}>
      {label === "Unknown" ? <><span aria-hidden="true">—</span><span className="sr-only">Result not recorded</span></> : label}
    </Badge>
  );
}
