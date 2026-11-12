"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BarChart3 } from "lucide-react";
import { RecapSlidesModal } from "@/components/analyzer/arcade/RecapSlidesModal";
import { buildRecapSlides } from "@/components/analyzer/arcade/seasonRecapSlides";
import { PlayerChooser } from "@/components/instant/PlayerChooser";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { busiestReplayMonth, RECAP_END, RECAP_START, RECAP_YEAR } from "@/lib/career/headerRows";
import { projectWrappedCard } from "@/lib/career/wrappedCard";
import { formatNumber } from "@/lib/i18n/format";
import { computeSeasonRecap } from "@/lib/seasonRecap";
import { useYearRecap, type RecapState } from "./useYearRecap";
import { WrappedShareButton } from "./WrappedShareButton";
import { LocalReplayIntake } from "@/components/instant/LocalReplayIntake";

const WINDOW = { since: new Date(RECAP_START), until: new Date(RECAP_END - 1), separateRaceQueues: true };
const YEAR_LABEL = `${RECAP_YEAR} ladder games`;
const HEADING = "rounded-sm text-h3 font-semibold text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const RECAP_FOCUS = { "data-recap-heading": "", tabIndex: -1 };

function ScanProgress({ total, complete, onCancel }: { total: number; complete: number; onCancel: () => void }) {
  const label = total
    ? `Scanned ${formatNumber(complete)} of ${formatNumber(total)} ${total === 1 ? "replay" : "replays"}`
    : "Looking for replays";
  return (
    <Card padded={false} className="space-y-4 p-4">
      <div role="status" aria-live="polite">
        <h2 {...RECAP_FOCUS} className={HEADING}>{label}</h2>
        <p className="mt-1 text-body text-text-muted">Files stored only in the cloud may take longer to read.</p>
      </div>
      {total ? <progress className="h-2 w-full accent-accent" value={complete} max={total} aria-label="Replays scanned" />
        : <div aria-hidden className="h-2 w-full rounded-full bg-bg-elevated motion-safe:animate-pulse" />}
      <Button variant="secondary" className="min-h-11" onClick={onCancel}>Cancel</Button>
    </Card>
  );
}

const EMPTY_TEXT = {
  files: "Choose a folder with replay files last modified in 2026.",
  ladder: "No 2026 one-versus-one ladder games were found in these files.",
  player: "None of these replays matched the selected player.",
} as const;

function IntakeMessage({ state, clear, retry }: {
  state: Extract<RecapState, { kind: "empty" | "error" }>;
  clear: () => void;
  retry: () => void;
}) {
  return (
    <Card padded={false} className="space-y-4 p-4">
      <div role="status">
        <h2 {...RECAP_FOCUS} className={HEADING}>{state.kind === "error" ? "Couldn’t read the replays" : "No games to show"}</h2>
        <p className="mt-1 text-body text-text-muted">{state.kind === "error"
          ? "Check that the files are available on this device and try again." : EMPTY_TEXT[state.reason]}</p>
      </div>
      <div className="flex flex-wrap gap-3">
        {state.kind === "error" ? <Button variant="primary" className="min-h-11" onClick={retry}>Try again</Button> : null}
        <Button variant="secondary" className="min-h-11" onClick={clear}>Choose different files</Button>
      </div>
    </Card>
  );
}

function YearResults({ state, clear }: { state: Extract<RecapState, { kind: "recap" }>; clear: () => void }) {
  const { games, unreadable } = state;
  const [open, setOpen] = useState(false);
  const recap = useMemo(() => computeSeasonRecap(games, WINDOW), [games]);
  const card = useMemo(() => projectWrappedCard(recap), [recap]);
  const slides = useMemo(() => buildRecapSlides(recap, { label: YEAR_LABEL }, {
    year: RECAP_YEAR, busiestMonth: busiestReplayMonth(games),
  }), [games, recap]);

  return (
    <Card padded={false} className="space-y-4 p-4">
      <div>
        <h2 {...RECAP_FOCUS} className={HEADING}>Your year is ready</h2>
        <p className="mt-1 text-body text-text-muted">{formatNumber(games.length)} {games.length === 1 ? "ladder game" : "ladder games"} in your recap.</p>
        {unreadable ? <p className="text-caption text-text-muted">{formatNumber(unreadable)} {unreadable === 1 ? "file" : "files"} could not be read.</p> : null}
      </div>
      <div className="flex flex-wrap gap-3">
        <Button variant="primary" className="min-h-11" iconLeft={<BarChart3 className="size-4" aria-hidden />} onClick={() => setOpen(true)}>
          View recap
        </Button>
        <Button variant="secondary" className="min-h-11" onClick={clear}>Clear replays</Button>
      </div>
      {open ? <RecapSlidesModal compact title="Year in review" description={YEAR_LABEL} slides={slides}
        shareAction={<WrappedShareButton card={card} />} onClose={() => setOpen(false)} /> : null}
    </Card>
  );
}

export function YearRecap() {
  const { state, start, clear, choose, retry } = useYearRecap();
  const panel = useRef<HTMLDivElement>(null);
  const interacted = useRef(false);
  useEffect(() => {
    if (state.kind !== "identify" && (interacted.current || state.kind !== "idle")) {
      panel.current?.querySelector<HTMLHeadingElement>("[data-recap-heading]")?.focus();
    }
    if (state.kind !== "idle") interacted.current = true;
  }, [state.kind]);

  return (
    <div ref={panel} className="min-h-64">
      {state.kind === "idle" ? <LocalReplayIntake start={start} modifiedWindow={WINDOW} /> : null}
      {state.kind === "scanning" ? <ScanProgress {...state} onCancel={clear} /> : null}
      {state.kind === "empty" || state.kind === "error" ? <IntakeMessage state={state} clear={clear} retry={retry} /> : null}
      {state.kind === "identify" ? <PlayerChooser candidates={state.candidates} onChoose={choose} onCancel={clear} showToon /> : null}
      {state.kind === "recap" ? <YearResults state={state} clear={clear} /> : null}
    </div>
  );
}
