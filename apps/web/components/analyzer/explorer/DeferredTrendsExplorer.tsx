"use client";

import { Card } from "@/components/ui/Card";
import { DeferredSection } from "../DeferredSection";
import { TrendsExplorer } from "./TrendsExplorer";
import { ACTION_CLASS } from "./ExplorerPrimitives";

/** Do not compete with the existing charts until this section is approached.
 * Once activated, keep it mounted so scrolling never loses analysis settings. */
export function DeferredTrendsExplorer({ activationRequest = 0 }: { activationRequest?: number }) {
  return <DeferredSection label="Explore performance" minHeight={360} activationRequest={activationRequest} fallback={(activate) => <Card title="Explore performance">
      <div className="flex min-h-32 flex-col items-start justify-center gap-4">
        <p className="max-w-2xl text-sm leading-relaxed text-text-muted">Compare results, build execution, player groups, and repeated encounters in seven focused analyses.</p>
        <button type="button" className={ACTION_CLASS} onClick={activate}>Load analyses</button>
      </div>
    </Card>}>
    {({ isNearViewport }) => <TrendsExplorer isNearViewport={isNearViewport} />}
  </DeferredSection>;
}
