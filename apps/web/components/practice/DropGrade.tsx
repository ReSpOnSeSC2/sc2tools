"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import { PlayerChooser } from "@/components/instant/PlayerChooser";
import { Button } from "@/components/ui/Button";
import { PersonalCardShareButton } from "@/components/ui/PersonalCardShareButton";
import type { GhostTarget } from "@/lib/ghostBuild";
import { spokenStepName } from "@/lib/ghostVoice";
import { fmtClock } from "@/lib/guides/format";
import { errorCopy } from "@/lib/instant/errorCopy";
import { parseInstantPayload } from "@/lib/instant/reportPayload";
import { SINGLE_REPLAY_SESSION_OPTIONS, useInstantSession } from "@/lib/instant/useInstantSession";
import type { PatchEra } from "@/lib/meta";
import { gradePracticeReplay } from "@/lib/practice/practiceGrade";
import { practiceGradeShareCard, type PracticeGradeCredit } from "@/lib/practice/practiceGradeShareCard";
import type { Race } from "@/lib/race";

type Result = ReturnType<typeof gradePracticeReplay>;
const LOCAL_GRADE_SESSION_OPTIONS = { ...SINGLE_REPLAY_SESSION_OPTIONS, trackAnalytics: false };

function GradeResult({ grade, credit }: { grade: Result; credit: PracticeGradeCredit }) {
  if (grade.kind === "wrong_race") return <p role="status">Choose your side in a replay played as the build’s race.</p>;
  const mismatch = grade.patchMismatch ? <p role="status" className="text-body font-semibold">The replay and build use different patch eras. Compare the timings with care.</p> : null;
  if (grade.kind === "wrong_build") return <div className="space-y-2">{mismatch}<p role="status">This replay doesn’t match the build. Fewer than half the recorded steps matched.</p></div>;
  const { result } = grade;
  const slip = result.firstDivergence;
  return <div className="space-y-2">
    {mismatch}
    <p role="status" className="text-h2 font-bold">Grade {result.grade}</p>
    <p className="text-body">{result.matchedSteps} of {result.targetSteps} steps matched.</p>
    <p className="text-body">{slip
      ? `The first slip was ${spokenStepName(slip.name)} at ${fmtClock(slip.expectedT)}. ${slip.actualT === null ? "Missed." : `Recorded at ${fmtClock(slip.actualT)}.`}`
      : "No major slip detected."}</p>
    <PersonalCardShareButton card={practiceGradeShareCard(credit, result.grade)} label="Share grade card" />
  </div>;
}

function useReplayGrade() {
  const session = useInstantSession(LOCAL_GRADE_SESSION_OPTIONS);
  const current = useRef<File | null>(null);
  const generation = useRef(0);
  const pending = useRef(false);
  const [preparing, setPreparing] = useState(false);
  const [intakeError, setIntakeError] = useState(false);

  async function start(files: readonly File[], source: "picker" | "drop") {
    if (pending.current || session.busy) return;
    if (files.length !== 1 || !/\.SC2Replay$/i.test(files[0].name)) { setIntakeError(true); return; }
    const file = files[0], id = ++generation.current;
    current.current = file;
    pending.current = true;
    setPreparing(true);
    setIntakeError(false);
    session.reset();
    try {
      await session.addFiles([file], source);
      if (generation.current === id) await session.start();
    } catch { if (generation.current === id) setIntakeError(true); }
    finally { if (generation.current === id) { pending.current = false; setPreparing(false); } }
  }

  function cancel() {
    generation.current += 1;
    pending.current = false;
    current.current = null;
    setIntakeError(false);
    setPreparing(false);
    session.reset();
  }

  useEffect(() => () => { generation.current += 1; }, []);
  return { session, intakeError, busy: preparing || session.busy, current, start, cancel };
}

export function DropGrade({ target, race, era, credit }: { target: GhostTarget; race: Race; era: PatchEra; credit: PracticeGradeCredit }) {
  const { session, intakeError, busy, current, start, cancel } = useReplayGrade();
  const picker = useRef<HTMLInputElement>(null);
  const choose = useRef<HTMLButtonElement>(null);
  const payload = session.parsed.length === 1 ? parseInstantPayload(session.parsed[0].json) : null;
  const grade = payload ? gradePracticeReplay(target, race, era, payload) : null;
  const failure = session.error ?? session.failed[0]?.errorKind;
  const copy = failure ? errorCopy(failure) : null;
  const loading = busy && session.phase !== "choosing";
  const stop = () => { cancel(); choose.current?.focus(); };
  function retry() {
    if (!current.current) return;
    choose.current?.focus();
    void start([current.current], "picker");
  }
  function drop(event: DragEvent<HTMLElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    void start(Array.from(event.dataTransfer.files), "drop");
  }

  return <section aria-label="Grade a replay" className="space-y-4 rounded-xl border border-line p-4"
    onDragOver={event => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }} onDrop={drop}>
    <p className="text-body">Drop one 1v1 replay against a human, or choose it below. Your browser keeps the replay and grade on this device.</p>
    <input ref={picker} type="file" accept=".SC2Replay" hidden onChange={event => {
      const files = Array.from(event.currentTarget.files ?? []);
      event.currentTarget.value = "";
      if (files.length) void start(files, "picker");
    }} />
    <Button ref={choose} className="min-h-11" aria-disabled={busy || undefined} onClick={() => { if (!busy) picker.current?.click(); }}>Choose a replay</Button>
    {intakeError ? <p role="alert" className="text-danger">Choose exactly one StarCraft II replay file.</p> : null}
    {loading ? <div className="flex flex-wrap items-center gap-2" aria-busy="true">
      <p role="status" className="text-body">Reading the replay on your device…</p><Button variant="secondary" className="min-h-11" onClick={stop}>Cancel</Button>
    </div> : null}
    {session.phase === "choosing" ? <PlayerChooser candidates={session.candidates} onChoose={toon => void session.choose(toon)} onCancel={stop} /> : null}
    {!busy && !grade && (copy || session.phase === "done") ? <div role="alert" className="space-y-2">
      <p className="font-semibold text-danger">{copy?.title ?? "This replay could not be graded."}</p>
      {copy?.hint ? <p className="text-caption text-text-muted">{copy.hint}</p> : null}
      {current.current ? <Button variant="secondary" className="min-h-11" onClick={retry}>Try again</Button> : null}
    </div> : null}
    {grade ? <GradeResult grade={grade} credit={credit} /> : null}
  </section>;
}
