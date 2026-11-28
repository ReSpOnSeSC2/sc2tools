"use client";

/**
 * Live preview panel — runs a real draw against the current draft config
 * so the streamer can see the reveal without touching OBS: the build, its
 * opening units, or the units alone, as the matchup's switches say.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Play } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Section } from "@/components/ui/Section";
import { Button } from "@/components/ui/Button";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { RandomizerSequence, loadUnitStage } from "@/components/randomizer/RandomizerSequence";
import { matchupDraws } from "@/lib/randomizer/config";
import { drawGame } from "@/lib/randomizer/engine";
import type {
  GameDraw,
  MatchupConfig,
  MatchupKey,
} from "@/lib/randomizer/types";

export interface RandomizerPreviewProps {
  matchup: MatchupKey;
  config: MatchupConfig;
}

/** The OBS widget's width, and the height the preview keeps for its reveal. */
const STAGE_WIDTH = 680;
const STAGE_HEIGHT = 540;

/** Why nothing can be drawn yet, or null when a draw is ready. */
export function previewBlocker(config: MatchupConfig): string | null {
  const draws = matchupDraws(config);
  if (draws.build || draws.units) return null;
  if (config.enabled) return "Add at least one build to this matchup's pool to spin.";
  if (config.unitRandomizerEnabled) return "Select at least one unit in Opening units to spin.";
  return "Turn on Draw a build order or Draw opening units for this matchup to spin.";
}

export function RandomizerPreview({ matchup, config }: RandomizerPreviewProps) {
  const [spin, setSpin] = useState<{ draw: GameDraw; id: number } | null>(null);
  const blocker = previewBlocker(config);
  const drawsUnits = matchupDraws(config).units;

  // Load the unit reveal before the first spin, as the widget does.
  useEffect(() => {
    if (drawsUnits) void loadUnitStage();
  }, [drawsUnits]);

  function onSpin() {
    const draw = drawGame(matchup, config);
    if (!draw) return;
    setSpin((prev) => ({ draw, id: (prev?.id ?? 0) + 1 }));
  }

  return (
    <Section
      id="randomizer-preview" className="scroll-mt-28"
      title="Live preview"
      description="Plays this matchup's complete OBS sequence: a build locks in and clears, then its opening units are drawn, or the units are drawn on their own."
    >
      <Card>
        <div className="flex flex-col items-center gap-4">
          <Button
            variant="primary"
            onClick={onSpin}
            disabled={blocker !== null}
            iconLeft={<Play className="h-4 w-4" aria-hidden />}
          >
            Spin {matchup}
          </Button>
          {blocker ? <EmptyStatePanel title="Nothing to spin yet" description={blocker} /> : null}
          {spin ? (
            <FitStage>
              <RandomizerSequence key={spin.id} draw={spin.draw} spinId={spin.id} />
            </FitStage>
          ) : null}
        </div>
      </Card>
    </Section>
  );
}

/**
 * Draws its child as wide as the OBS widget would be on this screen (the
 * reveals size themselves to at most 96% of the viewport), scaled down so
 * it fits the card without sideways scrolling, on the overlay surfaces'
 * dark ground in either theme (`.replay-scope`).
 */
function FitStage({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState({ width: STAGE_WIDTH, scale: 1 });

  useEffect(() => {
    const element = box.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.min(STAGE_WIDTH, window.innerWidth * 0.96);
      setFit({ width, scale: Math.min(1, entry.contentRect.width / width) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={box}
      className="replay-scope w-full overflow-hidden rounded-xl border border-border bg-bg"
      style={{ height: STAGE_HEIGHT * fit.scale }}
    >
      <div
        className="flex items-center justify-center"
        style={{
          width: fit.width,
          height: STAGE_HEIGHT,
          transform: `scale(${fit.scale})`,
          transformOrigin: "top left",
          marginLeft: `calc((100% - ${fit.width * fit.scale}px) / 2)`,
        }}
      >
        {children}
      </div>
    </div>
  );
}
