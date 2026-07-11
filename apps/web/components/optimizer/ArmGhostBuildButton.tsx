"use client";

/**
 * Arm an adapted optimizer result as the Ghost Build target —
 * "tonight's homework". Sits next to CopySaltButton in the results
 * column: SALT drills the build in an arcade map; Ghost Build takes it
 * to the ladder — the overlay widget coaches the next steps live and
 * every following game gets graded against the target on its game
 * page (see lib/ghostBuild.ts + lib/ghostGrade.ts). Everything is
 * client-side: localStorage + a URL param, no server state.
 */
import { useState } from "react";
import { Crosshair } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { useToastOptional } from "@/components/ui/Toast";
import { armGhostTarget, fromOptimizerResult } from "@/lib/ghostBuild";
import type { AdaptResult } from "@/lib/optimizer/types";

export function ArmGhostBuildButton({ result }: { result: AdaptResult | null }) {
  const toastCtx = useToastOptional();
  const [armed, setArmed] = useState(false);

  if (!result || result.sim.steps.length === 0) return null;

  const onArm = () => {
    const target = fromOptimizerResult(result);
    if (!target || !armGhostTarget(target)) {
      toastCtx?.toast.error("Couldn't arm this build", {
        description:
          "No armable timed steps were found (workers and chrono are excluded), or browser storage is unavailable.",
      });
      return;
    }
    setArmed(true);
    window.setTimeout(() => setArmed(false), 1500);
    toastCtx?.toast.success(`Armed "${target.name}"`, {
      description: `${target.steps.length} timed steps. Copy the Ghost Build widget URL from Settings → Overlay — your next games get graded against it.`,
    });
  };

  return (
    <Card title="Arm as Ghost Build">
      <div className="flex flex-wrap items-center justify-between gap-3 p-4">
        <p className="max-w-md text-caption text-text-muted">
          Make this your homework: the Ghost Build overlay widget shows
          the next steps synced to the live game, and each game page
          grades your execution against these timings.
        </p>
        <Button
          onClick={onArm}
          variant="secondary"
          iconLeft={<Crosshair className="h-4 w-4" aria-hidden />}
        >
          {armed ? "Armed!" : "Arm as Ghost Build"}
        </Button>
      </div>
    </Card>
  );
}
