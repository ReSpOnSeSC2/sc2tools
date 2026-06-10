"use client";

/**
 * The optimized build order as a supply-stamped step list
 * ("14 Pylon 0:24") with SC2 icons and copy-to-clipboard export.
 */
import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Card, EmptyState } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { buildOrderText, displaySteps } from "@/lib/optimizer/sim/format";
import type { OptimizeResult } from "@/lib/optimizer/types";
import type { OptimizerStatus } from "@/lib/optimizer/worker/useOptimizerWorker";

export function BuildOrderTimeline({
  result,
  status,
}: {
  result: OptimizeResult | null;
  status: OptimizerStatus;
}) {
  const [copied, setCopied] = useState(false);
  if (!result) {
    return (
      <Card title="Build order">
        <EmptyState
          title={
            status === "running"
              ? "Searching for the safest build…"
              : "No build yet"
          }
          sub={
            status === "running"
              ? "Best-so-far appears when the search finishes (or when you stop it)."
              : "Pick your matchup, mark what you scouted, and run the optimizer."
          }
        />
      </Card>
    );
  }
  const steps = displaySteps(result.sim);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(buildOrderText(result.sim));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable (permissions/http) — nothing to do
    }
  };
  return (
    <Card
      title="Build order"
      right={
        <Button
          variant="ghost"
          size="sm"
          onClick={handleCopy}
          iconLeft={
            copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />
          }
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      }
    >
      <div className="p-4">
        <ol className="space-y-1">
          {steps.map((step, index) => (
            <li
              key={`${index}-${step.name}-${step.startSec}`}
              className="flex items-center gap-3 rounded-md px-2 py-1 hover:bg-bg-elevated"
            >
              <span className="w-8 text-right font-mono text-caption font-semibold text-accent">
                {step.supply}
              </span>
              <Icon name={step.name} size="sm" fallback="" decorative />
              <span className="flex-1 text-body text-text">{step.label}</span>
              <span className="font-mono text-caption text-text-muted">
                {step.time}
              </span>
            </li>
          ))}
        </ol>
        <p className="mt-3 text-caption text-text-dim">
          Worker production is continuous (not listed). Steps stamped with the
          supply you&apos;ll be at when each starts. {result.sim.finalWorkers}{" "}
          workers by the end of the plan.
        </p>
      </div>
    </Card>
  );
}
