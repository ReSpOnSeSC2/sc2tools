"use client";

/**
 * Copy the adapted build as a SALT string — the encoding the Salt /
 * Build Order Trainer practice maps (and Spawning Tool) consume, so an
 * optimizer result goes from "read it" to "drill it in-game" in one
 * click. Steps SALT can't express (chrono usage, post-2016 items with
 * no SALT id) are surfaced in the toast rather than silently dropped.
 */
import { useState } from "react";
import { ClipboardCopy } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import { saltFromAdaptResult } from "@/lib/optimizer/export/toSalt";
import type { AdaptResult } from "@/lib/optimizer/types";

export function CopySaltButton({ result }: { result: AdaptResult | null }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  if (!result || result.sim.steps.length === 0) return null;

  const onCopy = async () => {
    if (!navigator.clipboard) {
      toast.error("Clipboard unavailable in this browser");
      return;
    }
    const { salt, skipped } = saltFromAdaptResult(result);
    await navigator.clipboard.writeText(salt);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
    toast.success("SALT string copied", {
      description:
        skipped.length > 0
          ? `Paste into the Salt practice map. ${skipped.length} step${
              skipped.length === 1 ? "" : "s"
            } had no SALT equivalent and were left out.`
          : "Paste into the Salt / Build Order Trainer practice map.",
    });
  };

  return (
    <Card title="Practice this build in-game">
      <div className="flex flex-wrap items-center justify-between gap-3 p-4">
        <p className="max-w-md text-caption text-text-muted">
          Copy the re-timed order as a SALT string and paste it into the
          Salt / Build Order Trainer arcade map to drill it against the
          real game clock.
        </p>
        <Button
          onClick={onCopy}
          variant="secondary"
          iconLeft={<ClipboardCopy className="h-4 w-4" aria-hidden />}
        >
          {copied ? "Copied!" : "Copy SALT string"}
        </Button>
      </div>
    </Card>
  );
}
