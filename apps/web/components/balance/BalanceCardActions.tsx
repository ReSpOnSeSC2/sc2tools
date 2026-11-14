"use client";

import { useState, type RefObject } from "react";
import { Button } from "@/components/ui/Button";
import type { BalanceCardKind } from "@/lib/balance/cardImage";
import { useCopy } from "@/lib/useCopy";

type Props = { kind: BalanceCardKind; title: string; lines: string[]; sharePath?: string };

export function BalanceCardActions({ kind, title, lines, sharePath }: Props) {
  const copy = useCopy({ scopeKey: sharePath });
  const [exporting, setExporting] = useState(false);
  const [failed, setFailed] = useState(false);

  async function download() {
    setExporting(true);
    setFailed(false);
    try {
      const { downloadBalanceCard } = await import("@/lib/balance/cardImage");
      await downloadBalanceCard(kind, title, lines);
    } catch {
      setFailed(true);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {sharePath && <Button variant="secondary" size="lg" disabled={copy.pending} onClick={() => void copy.copy(new URL(sharePath, window.location.origin).href)}>
          {copy.copied ? "Link copied" : "Copy link"}
        </Button>}
        <Button variant="secondary" size="lg" loading={exporting} onClick={() => void download()}>Download PNG</Button>
      </div>
      {copy.copied && <p role="status" className="sr-only">Link copied</p>}
      {copy.fallbackText && <label className="block space-y-1 text-caption text-text-muted">
        <span>Copy the selected link</span>
        <input readOnly ref={copy.inputRef as RefObject<HTMLInputElement>} value={copy.fallbackText} className="min-h-11 w-full rounded-lg border border-line bg-bg-surface px-3 text-text" />
      </label>}
      {failed && <p role="status" className="text-body text-text-muted">Image export failed. Try downloading again.</p>}
    </div>
  );
}
