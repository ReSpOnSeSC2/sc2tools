import { Zap } from "lucide-react";
import { Badge } from "./Badge";

export const INSTANT_HINT = "Saves as soon as you change it";

/**
 * Marks a Settings control that saves the moment it changes, instead of
 * waiting for the tab's Save button. The explanation is in the visible
 * label's accessible name and the hover tooltip, so it also reaches
 * keyboard, touch and screen-reader users.
 *
 * Example:
 *   <Toggle … /> <InstantBadge />
 */
export function InstantBadge({ className = "" }: { className?: string }) {
  return (
    <Badge
      variant="cyan"
      size="sm"
      title={INSTANT_HINT}
      iconLeft={<Zap className="h-3 w-3" aria-hidden />}
      className={`flex-shrink-0 ${className}`}
      data-instant-control=""
    >
      Instant<span className="sr-only">: {INSTANT_HINT.toLowerCase()}</span>
    </Badge>
  );
}
