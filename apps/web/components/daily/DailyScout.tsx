"use client";

import { useEffect, useRef, useState, type Ref } from "react";
import { Button } from "@/components/ui/Button";
import { CopyButton } from "@/components/ui/CopyButton";
import { jsonAt, loadDailySlot } from "@/lib/daily/loadDaily";
import { browserStorage, completeDay, readResults, streakOn, type DailyKind } from "@/lib/daily/progress";
import { DAILY_ROUNDS, shareDaily } from "@/lib/daily/rules";
import { MAX_SCOUT_PACK_BYTES, SCOUT_ROOT, readScoutPack, scoutChoices, type ScoutPack, type ScoutPuzzle, type ScoutStrategy } from "@/lib/daily/scout";
import { ScoutEvidence } from "./ScoutEvidence";
import { useUtcDay } from "./useUtcDay";

const GAME = { title: "Daily Scout", path: "/arcade/scout" };
const HEADING = "text-h2 text-text focus-visible:ring-2 focus-visible:ring-accent";
type ScoutDay = { pack: ScoutPack; kind: DailyKind; digest: string };
type Load = { day: number; attempt: number; data?: ScoutDay };

function ScoutResults({ day, practice, results, streak }: {
  day: number; practice: boolean; results: boolean[]; streak: number;
}) {
  return <>
    <p className="text-body text-text">{results.filter(Boolean).length} of {DAILY_ROUNDS} correct · {practice ? "Practice streak" : "Tracker streak"} {streak} {streak === 1 ? "day" : "days"}</p>
    <CopyButton text={shareDaily(day, practice, results, GAME)} className="min-h-11">Copy spoiler-free result</CopyButton>
  </>;
}

async function loadScout(day: number, signal: AbortSignal): Promise<ScoutDay> {
  const slot = await loadDailySlot(day, signal, SCOUT_ROOT);
  const pack = readScoutPack(await jsonAt(slot.directory + "/pack.json", signal, MAX_SCOUT_PACK_BYTES));
  if (!pack) throw new Error("Daily Scout set is invalid.");
  return { ...slot, pack };
}

function ScoutResponse({ puzzle, pick, final, heading, choose, advance }: {
  puzzle: ScoutPuzzle; pick: ScoutStrategy | null; final: boolean;
  heading: Ref<HTMLHeadingElement>; choose: (strategy: ScoutStrategy) => void; advance: () => void;
}) {
  if (pick) return <div className="space-y-3">
    <h2 tabIndex={-1} ref={heading} className={HEADING}>Strategy revealed</h2>
    <p className="text-body text-text">{pick === puzzle.strategy ? "Correct." : `You picked ${pick}.`} <strong>{puzzle.strategy}</strong></p>
    <Button className="min-h-11" onClick={advance}>{final ? "See results" : "Next opening"}</Button>
  </div>;
  return <div role="group" aria-label="Choose a strategy" className="grid gap-2 sm:grid-cols-3">
    {scoutChoices(puzzle.strategy)?.map(choice => <Button key={choice} variant="secondary"
      className="min-h-11 min-w-0 whitespace-normal" onClick={() => choose(choice)}>
      {choice}
    </Button>)}
  </div>;
}

export function DailyScout() {
  const day = useUtcDay();
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<Load | null>(null);
  useEffect(() => {
    if (day === null) return;
    const controller = new AbortController();
    loadScout(day, controller.signal).then(data => {
      if (!controller.signal.aborted) setLoad({ day, attempt, data });
    }, () => {
      if (!controller.signal.aborted) setLoad({ day, attempt });
    });
    return () => controller.abort();
  }, [attempt, day]);
  if (!load || load.day !== day || load.attempt !== attempt) return (
    <div role="status" className="min-h-60 rounded-xl border border-line bg-bg-surface p-4 text-text-muted">Loading Daily Scout…</div>
  );
  if (!load.data) return (
    <div className="space-y-3 rounded-xl border border-line bg-bg-surface p-4">
      <p role="status" className="text-text">The set could not load.</p>
      <Button variant="secondary" onClick={() => setAttempt(attempt + 1)}>Try again</Button>
    </div>
  );
  return <ScoutSession key={load.day + ":" + load.data.digest} day={load.day} data={load.data} />;
}

function ScoutSession({ day, data }: { day: number; data: ScoutDay }) {
  const [progress, setProgress] = useState(() => {
    const storage = browserStorage();
    return storage ? readResults(storage, data.kind, "scout") : {};
  });
  const [answers, setAnswers] = useState<boolean[]>([]);
  const [pick, setPick] = useState<ScoutStrategy | null>(null);
  const [focusHeading, setFocusHeading] = useState(false);
  const completed = progress[day];
  const practice = data.kind === "practice";
  const streak = streakOn(progress, day);
  const round = answers.length;
  const puzzle = data.pack.puzzles[round];
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusHeading) heading.current?.focus();
  }, [round, completed, focusHeading, pick]);

  function advance() {
    const results = [...answers, pick === puzzle.strategy];
    if (results.length === DAILY_ROUNDS) {
      setProgress(completeDay(browserStorage(), data.kind, day, results, "scout"));
    }
    setAnswers(results);
    setPick(null);
  }

  return (
    <section aria-label="Daily Scout game" className="space-y-4 rounded-xl border border-line bg-bg-surface p-4 sm:p-6">
      <p className="text-caption font-semibold text-text-muted">{practice ? "Practice week · sample openings" : "Daily set · Tracker openings"}</p>
      {completed ? <>
        <h2 tabIndex={-1} ref={heading} className={HEADING}>Set complete</h2>
        <ScoutResults day={day} practice={practice} results={completed} streak={streak} />
      </> : <>
        <p className="text-caption text-text-muted">Opening {round + 1} of {DAILY_ROUNDS}</p>
        <h2 tabIndex={-1} ref={pick ? undefined : heading} className={HEADING}>What was the opening?</h2>
        <ScoutEvidence key={round} puzzle={puzzle} />
        <ScoutResponse puzzle={puzzle} pick={pick} final={round + 1 === DAILY_ROUNDS} heading={heading}
          choose={choice => { setFocusHeading(true); setPick(choice); }} advance={advance} />
      </>}
    </section>
  );
}
