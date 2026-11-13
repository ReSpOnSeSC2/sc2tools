"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { CopyButton } from "@/components/ui/CopyButton";
import { useCopy } from "@/lib/useCopy";
import { loadDaily, type LoadedDay } from "@/lib/daily/loadDaily";
import { browserStorage, completeDay, readResults, streakOn, type DailyKind } from "@/lib/daily/progress";
import { DAY_MS, FIGHTS_PER_DAY, shareDaily, utcDay, type FightCall } from "@/lib/daily/rules";
import { readBallot, saveBallot, type DailyBallot } from "@/lib/daily/crowd";
import { dailyFightLink, readFightLink } from "@/lib/daily/fightLink";
import { CallTheFight, FightSkeleton } from "./CallTheFight";
import { DailyCrowd } from "./DailyCrowd";

type Load = { day: number; standalone: boolean; attempt: number; data?: LoadedDay };
type GradedCall = { correct: boolean; call: FightCall };
type ResultsProps = { day: number; practice: boolean; results: boolean[]; focus: boolean };

function useUtcDay(): number | null {
  const [day, setDay] = useState<number | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const sync = () => {
      clearTimeout(timer);
      const now = Date.now(), current = utcDay(now);
      setDay(current);
      timer = setTimeout(sync, (current + 1) * DAY_MS - now + 25);
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);
  return day;
}

function useFightHash() {
  const [hash, setHash] = useState("");
  useEffect(() => {
    const sync = () => setHash(window.location.hash);
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  return hash;
}

function useDailyLoad(day: number | null, standalone: boolean) {
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<Load | null>(null);
  useEffect(() => {
    if (day === null) return;
    const controller = new AbortController();
    loadDaily(day, controller.signal, standalone).then(data => {
      if (!controller.signal.aborted) setLoaded({ day, standalone, attempt, data });
    }, () => {
      if (!controller.signal.aborted) setLoaded({ day, standalone, attempt });
    });
    return () => controller.abort();
  }, [attempt, day, standalone]);
  const current = loaded && loaded.day === day && loaded.standalone === standalone && loaded.attempt === attempt;
  return { loaded: current ? loaded : null, retry: () => setAttempt(attempt + 1) };
}

export function DailyArcade() {
  const today = useUtcDay();
  const hash = useFightHash();
  const link = today === null ? null : readFightLink(hash, today);
  const { loaded, retry } = useDailyLoad(link?.day ?? today, Boolean(link));

  if (!loaded) return <FightSkeleton />;
  if (!loaded.data) return (
    <section className="space-y-3 rounded-xl border border-line bg-bg-surface p-4 sm:p-6" aria-label="Daily unavailable">
      <p role="status" className="text-body text-text">{link ? "The linked fight did not load. You can try again or play today's set." : "The set did not load. You can try again."}</p>
      <Button variant="secondary" className="min-h-11" onClick={retry}>Try again</Button>
      {link && <DailySetLink />}
    </section>
  );
  return link ? <StandaloneFight key={loaded.day + ":" + link.slot} data={loaded.data} slot={link.slot} /> :
    <DaySession key={loaded.day + ":" + loaded.data.directory} day={loaded.day} data={loaded.data} focusOpening={hash === "#daily-set"} />;
}

function DailySetLink() {
  return <a href="#daily-set" className="inline-flex min-h-11 items-center rounded px-3 font-semibold text-accent underline focus-visible:ring-2 focus-visible:ring-accent">Play today's set</a>;
}

function terrainFor(data: LoadedDay, slot: number) {
  return data.pack.fights[slot].terrain ? data.directory + "/" + (slot + 1) + ".webp" : undefined;
}

function StandaloneFight({ data, slot }: { data: LoadedDay; slot: number }) {
  return <div className="space-y-4">
    <CallTheFight fight={data.pack.fights[slot]} slot={slot} terrain={terrainFor(data, slot)} focusOpening />
    <DailySetLink />
  </div>;
}

function initialProgress(kind: DailyKind) {
  const storage = browserStorage();
  return storage ? readResults(storage, kind) : {};
}

function DaySession({ day, data, focusOpening }: { day: number; data: LoadedDay; focusOpening: boolean }) {
  const practice = data.kind === "practice";
  const [saved, setSaved] = useState(() => initialProgress(data.kind));
  const [calls, setCalls] = useState<GradedCall[]>([]);
  const [ballot, setBallot] = useState(() => practice ? null : readBallot(browserStorage(), day, data.digest));
  const completed = saved[day], slot = calls.length;
  const focus = focusOpening || slot > 0;
  const fight = data.pack.fights[slot];
  const streak = streakOn(saved, day);
  async function advance(correct: boolean, call: FightCall) {
    const next = [...calls, { correct, call }];
    if (next.length < FIGHTS_PER_DAY) {
      setCalls(next);
      return;
    }
    const storage = browserStorage();
    if (!practice) setBallot(await saveBallot(storage, day, data.digest, next.map(answer => answer.call)));
    setSaved(completeDay(storage, data.kind, day, next.map(answer => answer.correct)));
  }
  return (
    <div id="daily-set" className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 text-caption">
        <p className="text-text-muted">{practice ? "Practice week \u00b7 sample fights" : "Today\u2019s recorded fights"}</p>
        <p className="font-semibold text-text">Streak: {streak} {streak === 1 ? "day" : "days"}</p>
      </div>
      {completed ? <CompletedSet day={day} practice={practice} results={completed} focus={focus} ballot={ballot} /> : (
        <CallTheFight key={slot} fight={fight} slot={slot}
          terrain={terrainFor(data, slot)}
          focusOpening={focus}
          onNext={(correct, call) => void advance(correct, call)} />
      )}
    </div>
  );
}

function CompletedSet({ day, practice, results, focus, ballot }: ResultsProps & { ballot: DailyBallot | null }) {
  return <>
    <DailyResults day={day} practice={practice} results={results} focus={focus} />
    {ballot && <DailyCrowd ballot={ballot} />}
    {!practice && <ShareFightLinks day={day} />}
  </>;
}

function ShareFightLinks({ day }: { day: number }) {
  return <section className="space-y-3 rounded-xl border border-line bg-bg-surface p-4 sm:p-6" aria-label="Share a fight">
    <h2 className="font-display text-heading font-bold text-text">Share a fight</h2>
    <p className="text-body text-text-muted">Each link opens the fight before the result.</p>
    <ol className="flex flex-wrap gap-2">
      {Array.from({ length: FIGHTS_PER_DAY }, (_, slot) => (
        <li key={slot}><CopyButton className="min-h-11" text={"https://sc2tools.com" + dailyFightLink(day, slot)} scopeKey={day}>
          Copy fight {slot + 1} link
        </CopyButton></li>
      ))}
    </ol>
  </section>;
}

function DailyResults({ day, practice, results, focus }: ResultsProps) {
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (focus) title.current?.focus(); }, [focus]);
  const score = results.filter(Boolean).length;
  const text = shareDaily(day, practice, results);
  const copy = useCopy({ scopeKey: day });
  const setCopyInput = useCallback((node: HTMLTextAreaElement | null) => { copy.inputRef.current = node; }, [copy.inputRef]);
  return (
    <section className="space-y-3 rounded-xl border border-line bg-bg-surface p-4 sm:p-6">
      <h2 ref={title} tabIndex={-1} className="font-display text-heading font-bold text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Set complete</h2>
      <p className="text-body text-text">{score} of {FIGHTS_PER_DAY} correct. A new set opens at midnight UTC.</p>
      <Button className="min-h-11" loading={copy.pending} onClick={() => void copy.copy(text)}>Copy spoiler-free result</Button>
      {copy.copied && <p role="status" className="text-caption text-text-muted">Result copied.</p>}
      {copy.fallbackText && <textarea ref={setCopyInput} aria-label="Result to copy" readOnly value={copy.fallbackText}
        className="block w-full rounded-md border border-line bg-bg-elevated p-2 text-body text-text focus-visible:ring-2 focus-visible:ring-accent" />}
    </section>
  );
}
