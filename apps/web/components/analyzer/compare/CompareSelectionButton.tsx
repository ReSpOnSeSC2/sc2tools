"use client";

import { GitCompareArrows } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useCompareNavigation } from "./useCompareNavigation";

/**
 * Replays' selection toolbar: with exactly two replays selected, open
 * them side by side. The first one selected is game A.
 */
export function CompareSelectionButton({ ids }: { ids: readonly string[] }) {
  const navigation = useCompareNavigation();
  const icon = <GitCompareArrows className="h-4 w-4" aria-hidden />;
  if (ids.length === 2) {
    return <div className="flex flex-wrap items-center gap-2">
      <Button variant="secondary" size="sm" className="min-h-11" iconLeft={icon} loading={navigation.loading}
        onClick={() => void navigation.compare(ids[0], ids[1])}>Compare 2 games</Button>
      {navigation.error ? <p role="alert" className="text-caption text-danger">{navigation.error}</p> : null}
    </div>;
  }
  return (
    <Button variant="secondary" size="sm" className="min-h-11" iconLeft={icon} disabled title="Select exactly two replays to compare them">
      Compare <span className="sr-only">(select exactly two replays)</span>
    </Button>
  );
}
