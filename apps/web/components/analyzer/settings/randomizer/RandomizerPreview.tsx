"use client";

/**
 * Live preview panel — runs a real spin against the current draft
 * config so the streamer can see the reveal animation without
 * touching OBS. The reveal style is randomly picked each spin, same
 * as the production widget.
 */
import { useState } from "react";
import { Play } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Section } from "@/components/ui/Section";
import { Button } from "@/components/ui/Button";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { RandomizerStage } from "@/components/randomizer/RandomizerStage";
import { spinResult } from "@/lib/randomizer/engine";
import type {
  MatchupConfig,
  MatchupKey,
  SpinOutcome,
} from "@/lib/randomizer/types";

export interface RandomizerPreviewProps {
  matchup: MatchupKey;
  config: MatchupConfig;
}

export function RandomizerPreview({ matchup, config }: RandomizerPreviewProps) {
  const [spin, setSpin] = useState<{ outcome: SpinOutcome; id: number } | null>(
    null,
  );
  const canSpin = config.enabled && config.builds.length > 0;

  function onSpin() {
    const outcome = spinResult(matchup, config);
    if (!outcome) return;
    setSpin((prev) => ({ outcome, id: (prev?.id ?? 0) + 1 }));
  }

  return (
    <Section
      title="Live preview"
      description="Try the reveal animation without firing it at OBS. A different style is picked each spin — same as the production widget."
    >
      <Card>
        <div className="flex flex-col items-center gap-4">
          <Button
            variant="primary"
            onClick={onSpin}
            disabled={!canSpin}
            iconLeft={<Play className="h-4 w-4" aria-hidden />}
          >
            Spin {matchup}
          </Button>
          {!canSpin ? (
            <EmptyStatePanel
              title="Nothing to spin yet"
              description={
                config.enabled
                  ? "Add at least one build to this matchup's pool to spin."
                  : "Enable the randomizer for this matchup to spin."
              }
            />
          ) : null}
          {spin ? (
            <div
              className="flex w-full items-center justify-center rounded-xl border border-border bg-[#0b0d12] p-6"
              style={{ minHeight: 500 }}
            >
              <RandomizerStage outcome={spin.outcome} spinId={spin.id} />
            </div>
          ) : null}
        </div>
      </Card>
    </Section>
  );
}
