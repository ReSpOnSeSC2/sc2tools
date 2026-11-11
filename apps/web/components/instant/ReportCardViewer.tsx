"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { SkeletonBar, SkeletonRows } from "@/components/ui/Skeleton";
import { drawReportCard } from "@/lib/instant/reportCard";
import { decodeReportCard } from "@/lib/instant/reportCardLink";
import { summaryFromModel } from "@/lib/instant/reportExport";
import type { ReportCardModel } from "@/lib/instant/reportSharing";

type CardState = { kind: "loading" | "empty" | "invalid" } | { kind: "ready"; model: ReportCardModel };
const SCOPE_NOTE = "These numbers cover the games selected by the sharer.";

function readCardFragment(): CardState {
  const fragment = window.location.hash.slice(1);
  if (!fragment) return { kind: "empty" };
  const model = decodeReportCard(fragment);
  return model ? { kind: "ready", model } : { kind: "invalid" };
}

function ReportPreview({ model }: { model: ReportCardModel }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const preview = useRef<HTMLElement>(null);
  const [failed, setFailed] = useState(false);
  const draw = useCallback(() => {
    if (!canvas.current) return false;
    try {
      drawReportCard(canvas.current, model, SCOPE_NOTE);
      setFailed(false);
      return true;
    } catch {
      setFailed(true);
      return false;
    }
  }, [model]);

  useEffect(() => { draw(); }, [draw]);

  return (
    <section ref={preview} tabIndex={-1} aria-label="Shared replay report" className="space-y-4 rounded-lg">
      <canvas ref={canvas} width={1200} height={630} hidden={failed} aria-hidden="true"
        className="h-auto w-full rounded-lg border border-line" />
      {failed ? (
        <div className="space-y-2 rounded-lg border border-line bg-bg-surface p-4">
          <p role="status" className="text-body text-text-muted">The image is unavailable. The report details are below.</p>
          <Button variant="secondary" onClick={() => { if (draw()) preview.current?.focus(); }}>Try image again</Button>
        </div>
      ) : null}
      <div className="space-y-2 rounded-lg border border-line bg-bg-surface p-4">
        <h2 className="text-body font-semibold text-text">Report details</h2>
        <p className="text-body text-text-muted">{SCOPE_NOTE}</p>
        <ul className="space-y-1 text-body text-text-muted">
          {summaryFromModel(model).map(line => <li key={line}>{line}</li>)}
        </ul>
      </div>
    </section>
  );
}

export function ReportCardViewer() {
  const [card, setCard] = useState<CardState>({ kind: "loading" });
  useEffect(() => {
    const update = () => setCard(readCardFragment());
    update();
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);

  if (card.kind === "ready") return <ReportPreview model={card.model} />;
  if (card.kind === "loading") return (
    <div className="space-y-4">
      <SkeletonBar className="aspect-[1200/630] w-full" />
      <SkeletonRows rows={3} label="Opening report card" />
    </div>
  );

  return (
    <div role="status" className="space-y-1 rounded-lg border border-line bg-bg-surface p-4">
      <p className="font-semibold text-text">{card.kind === "empty" ? "No report card in this link" : "This report card link is invalid"}</p>
      <p className="text-body text-text-muted">Ask the person who shared it for a complete link.</p>
    </div>
  );
}
