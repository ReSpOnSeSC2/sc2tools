"use client";

import { useEffect, useRef } from "react";
import { LocalReplayIntake } from "@/components/instant/LocalReplayIntake";
import { PlayerChooser } from "@/components/instant/PlayerChooser";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import type { CareerProgress } from "@/lib/career/careerScan";
import { formatNumber } from "@/lib/i18n/format";
import { CareerChapters, countLabel } from "./CareerChapters";
import { useCareer, type CareerState } from "./useCareer";

const HEADING = "rounded-sm font-display text-h3 font-semibold text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const FOCUS = { "data-recap-heading": "", tabIndex: -1 };
const EMPTY = {
  files: "Choose a folder or files ending in .SC2Replay.",
  ladder: "No one-versus-one ladder games were found in these files.",
  player: "None of the ladder games matched the selected player.",
} as const;

function CareerScanProgress({ phase, complete, total, reset }: CareerProgress & { reset: () => void }) {
  const checking = phase === "files";
  return (
    <Card padded={false} className="space-y-4 p-4">
      <div role="status" className="space-y-1">
        <h2 {...FOCUS} className={HEADING}>{checking ? "Checking selected files" : "Reading replay headers"}</h2>
        {total ? <p className="text-body text-text-muted">{formatNumber(complete)} of {countLabel(total, checking ? "file" : "header")}</p>
          : <p className="text-body text-text-muted">Files stored in the cloud may take longer to read.</p>}
      </div>
      {total ? <progress className="h-2 w-full accent-accent" value={complete} max={total} aria-label={checking ? "Replay files checked" : "Replay headers read"} />
        : <div aria-hidden className="h-2 w-full rounded-full bg-bg-elevated motion-safe:animate-pulse" />}
      <Button variant="secondary" className="min-h-11" onClick={reset}>Cancel</Button>
    </Card>
  );
}

function ScanMessage({ state, reset, retry }: {
  state: Extract<CareerState, { kind: "empty" | "error" }>;
  reset: () => void;
  retry: () => void;
}) {
  return (
    <Card padded={false} className="space-y-4 p-4">
      <div role="status" className="space-y-1">
        <h2 {...FOCUS} className={HEADING}>{state.kind === "error" ? "Couldn’t read the replays" : "No games to show"}</h2>
        <p className="text-body text-text-muted">{state.kind === "error"
          ? "Check that the files are available on this device and try again." : EMPTY[state.reason]}</p>
      </div>
      <div className="flex flex-wrap gap-3">
        {state.kind === "error" ? <Button variant="primary" className="min-h-11" onClick={retry}>Try again</Button> : null}
        <Button variant="secondary" className="min-h-11" onClick={reset}>Choose different files</Button>
      </div>
    </Card>
  );
}

function CareerResults({ state, reset }: { state: Extract<CareerState, { kind: "record" }>; reset: () => void }) {
  return (
    <section aria-labelledby="career-results" className="space-y-6">
      <Card variant="feature" padded={false} className="flex flex-wrap items-start justify-between gap-4 p-4">
        <div className="space-y-1">
          <h2 {...FOCUS} id="career-results" className={HEADING}>Your replay record</h2>
          <p className="text-body text-text-muted">{countLabel(state.record.games, "game")} from the selected one-versus-one ladder replays.</p>
          {state.reused ? <p className="text-caption text-text-muted">Reused saved results for {countLabel(state.reused, "file")}.</p> : null}
          {state.unreadable ? <p className="text-caption text-text-muted">{countLabel(state.unreadable, "file")} could not be read.</p> : null}
          {!state.cacheAvailable ? <p className="text-caption text-text-muted">Browser storage was unavailable. The next scan may reread these files.</p> : null}
        </div>
        <Button variant="secondary" className="min-h-11" onClick={reset}>Choose replays again</Button>
      </Card>
      <CareerChapters record={state.record} />
    </section>
  );
}

export function Career() {
  const { state, clearState, start, reset, retry, choose, forget } = useCareer();
  const panel = useRef<HTMLDivElement>(null);
  const interacted = useRef(false);
  useEffect(() => {
    if (state.kind !== "identify" && (interacted.current || state.kind !== "idle")) {
      panel.current?.querySelector<HTMLHeadingElement>("[data-recap-heading]")?.focus();
    }
    if (state.kind !== "idle") interacted.current = true;
  }, [state.kind]);

  useEffect(() => {
    if (state.kind !== "scanning" && state.kind !== "identify") return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) reset();
    };
    document.addEventListener("keydown", cancel);
    return () => document.removeEventListener("keydown", cancel);
  }, [reset, state.kind]);

  return (
    <div ref={panel} className="space-y-6">
      <div className="min-h-80 sm:min-h-64">
        {state.kind === "idle" ? <LocalReplayIntake start={start} disabled={clearState === "clearing"} /> : null}
        {state.kind === "scanning" ? <CareerScanProgress {...state} reset={reset} /> : null}
        {state.kind === "empty" || state.kind === "error" ? <ScanMessage state={state} reset={reset} retry={retry} /> : null}
        {state.kind === "identify" ? <PlayerChooser candidates={state.candidates} onChoose={choose} onCancel={reset} showToon /> : null}
        {state.kind === "record" ? <CareerResults state={state} reset={reset} /> : null}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" className="min-h-11" disabled={clearState === "clearing"} onClick={() => void forget()}>Clear saved replay summaries</Button>
        <p role="status" className="text-caption text-text-muted">
          {clearState === "clearing" ? "Clearing saved summaries." : null}
          {clearState === "cleared" ? "Saved summaries cleared." : null}
          {clearState === "unavailable" ? "Couldn’t clear browser storage. Try again or clear this site’s data in your browser." : null}
        </p>
      </div>
    </div>
  );
}
