"use client";

import { useState, type ReactNode } from "react";
import { Card } from "@/components/ui/Card";
import { RequestError } from "@/components/ui/RequestError";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { MacroBreakdownBody } from "@/components/analyzer/macro/MacroBreakdownBody";
import type { MacroBreakdownData, PanelHeaderMeta } from "@/components/analyzer/macro/MacroBreakdownPanel.types";
import { RECOMPUTE_ANALYSIS_HINT } from "@/lib/analysisRecompute";

/** The owner workspace reuses the modal body and its cached API payload. */
export function GameMacroSection({ gameId, data, loading, error, onRetry, action, onRecompute, recomputing, headerMeta, inspectionTime, onSeek }: {
  gameId: string; data: MacroBreakdownData | null; loading: boolean; error?: unknown;
  onRetry: () => unknown; action: ReactNode; onRecompute: () => void;
  recomputing: boolean; headerMeta: PanelHeaderMeta;
  inspectionTime?: number | null; onSeek?: (time: number) => void;
}) {
  const [highlighted, setHighlighted] = useState<string | null>(null);
  if (error) return <RequestError title="Couldn't load the macro breakdown" error={error} onRetry={onRetry} />;
  return <Card padded={false}>
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4"><h2 className="font-display text-h3 font-bold text-text">Macro breakdown <LazyHelpLink slug="game-page" anchor="macro">Help</LazyHelpLink></h2>{action}</div>
    <div className="space-y-4 p-4 sm:p-5">
      {loading ? <div role="status" aria-label="Loading macro breakdown" className="h-64 animate-pulse rounded-lg bg-bg-elevated" /> : data ? <MacroBreakdownBody data={data} gameId={gameId} headerMeta={headerMeta} highlightedKey={highlighted} onHighlight={(key, leak) => { setHighlighted(key); if (leak?.time != null) onSeek?.(leak.time); }} onRecompute={onRecompute} recomputing={recomputing} includeReplay={false} inspectionTime={inspectionTime} onSeek={onSeek} /> : <EmptyStatePanel title="No macro breakdown for this game" description={RECOMPUTE_ANALYSIS_HINT} />}
    </div>
  </Card>;
}
