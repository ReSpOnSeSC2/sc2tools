"use client";

import { GitCompareArrows } from "lucide-react";
import { Button, LinkButton } from "@/components/ui/Button";
import { compareHref } from "@/lib/gameCompare";

/**
 * Replays' selection toolbar: with exactly two replays selected, open
 * them side by side. The first one selected is game A.
 */
export function CompareSelectionButton({ ids }: { ids: readonly string[] }) {
  const icon = <GitCompareArrows className="h-4 w-4" aria-hidden />;
  if (ids.length === 2) {
    return <LinkButton href={compareHref(ids[0], ids[1])} variant="secondary" size="sm" className="min-h-11" iconLeft={icon}>Compare 2 games</LinkButton>;
  }
  return (
    <Button variant="secondary" size="sm" className="min-h-11" iconLeft={icon} disabled title="Select exactly two replays to compare them">
      Compare <span className="sr-only">(select exactly two replays)</span>
    </Button>
  );
}
