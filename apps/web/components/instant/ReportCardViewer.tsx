"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { SkeletonBar, SkeletonRows } from "@/components/ui/Skeleton";
import { ReportCardComparison, ReportComparisonBuilder } from "./ReportCardComparison";
import { drawReportCard } from "@/lib/instant/reportCard";
import { decodeReportCard, decodeReportComparison, type ReportComparison } from "@/lib/instant/reportCardLink";
import type { ReportCardClass } from "@/lib/instant/reportCardRoute";
import { summaryFromModel } from "@/lib/instant/reportExport";
import type { ReportCardModel } from "@/lib/instant/reportSharing";

type CardState = { kind: "loading" | "empty" | "invalid" }
  | { kind: "summary"; model: ReportCardModel; fragment: string }
  | { kind: "compare"; model: ReportComparison };
const SCOPE_NOTE = "These numbers cover the games selected by the sharer.";

function readCardFragment(cardClass: ReportCardClass): CardState {
  const fragment = window.location.hash.slice(1);
  if (!fragment) return { kind: "empty" };
  if (cardClass === "compare") {
    const model = decodeReportComparison(fragment);
    return model ? { kind: "compare", model } : { kind: "invalid" };
  }
  const model = decodeReportCard(fragment);
  return model ? { kind: "summary", model, fragment } : { kind: "invalid" };
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

export function ReportCardViewer({ cardClass = "summary" }: { cardClass?: ReportCardClass }) {
  const [card, setCard] = useState<CardState>({ kind: "loading" });
  useEffect(() => {
    const update = () => setCard(readCardFragment(cardClass));
    update();
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, [cardClass]);

  if (card.kind === "summary") return (
    <div className="space-y-6">
      <ReportPreview model={card.model} />
      <ReportComparisonBuilder key={card.fragment} shared={card.model} />
    </div>
  );
  if (card.kind === "compare") return <ReportCardComparison model={card.model} />;
  if (card.kind === "loading") return (
    <div className="space-y-4">
      {cardClass === "compare" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <SkeletonBar className="h-40 w-full" />
          <SkeletonBar className="h-40 w-full" />
        </div>
      ) : <SkeletonBar className="aspect-[1200/630] w-full" />}
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
