"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";

export function BandAxisToggle({ initialAxis, league, mmr }: { initialAxis: "league" | "mmr"; league: ReactNode; mmr: ReactNode }) {
  // Both server-rendered link rows remain available without JavaScript.
  const [axis, setAxis] = useState<"league" | "mmr" | null>(null);
  useEffect(() => setAxis(initialAxis), [initialAxis]);
  return <div className="min-w-0 space-y-2">
    <div className="flex gap-2" aria-label="Choose opponent filter type">
      <Button variant="secondary" size="sm" aria-pressed={(axis ?? initialAxis) === "league"} onClick={() => setAxis("league")}>By league</Button>
      <Button variant="secondary" size="sm" aria-pressed={(axis ?? initialAxis) === "mmr"} onClick={() => setAxis("mmr")}>By MMR</Button>
    </div>
    <div hidden={axis === "mmr"}>{league}</div><div hidden={axis === "league"}>{mmr}</div>
  </div>;
}
