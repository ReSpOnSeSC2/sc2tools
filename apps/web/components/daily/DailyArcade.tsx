"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { useCopy } from "@/lib/useCopy";
import { loadDaily, type LoadedDay } from "@/lib/daily/loadDaily";
import { browserStorage, completeDay, readResults, streakOn, type DailyKind } from "@/lib/daily/progress";
import { DAY_MS, FIGHTS_PER_DAY, shareDaily, utcDay } from "@/lib/daily/rules";
import { CallTheFight, FightSkeleton } from "./CallTheFight";

type Load = { day: number; attempt: number; data?: LoadedDay };

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

export function DailyArcade() {
  const day = useUtcDay();
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<Load | null>(null);
  useEffect(() => {
    if (day === null) return;
    const controller = new AbortController();
    loadDaily(day, controller.signal).then(data => {
      if (!controller.signal.aborted) setLoaded({ day, attempt, data });
    }, () => {
      if (!controller.signal.aborted) setLoaded({ day, attempt });
    });
    return () => controller.abort();
  }, [attempt, day]);

  if (!loaded || loaded.day !== day || loaded.attempt !== attempt) return <FightSkeleton />;
  if (!loaded.data) return (
    <section className="space-y-3 rounded-xl border border-line bg-bg-surface p-4 sm:p-6" aria-label="Daily unavailable">
      <p role="status" className="text-body text-text">The set did not load. You can try again.</p>
      <Button variant="secondary" className="min-h-11" onClick={() => setAttempt(attempt + 1)}>Try again</Button>
    </section>
  );
  return <DaySession key={day + ":" + loaded.data.directory} day={day} data={loaded.data} />;
}

function initialProgress(kind: DailyKind) {
  const storage = browserStorage();
  return storage ? readResults(storage, kind) : {};
}

function DaySession({ day, data }: { day: number; data: LoadedDay }) {
  const practice = data.kind === "practice";
  const [saved, setSaved] = useState(() => initialProgress(data.kind));
  const [calls, setCalls] = useState<boolean[]>([]);
  const completed = saved[day], slot = calls.length;
  const fight = data.pack.fights[slot];
  const streak = streakOn(saved, day);
  function advance(correct: boolean) {
    const results = [...calls, correct];
    if (results.length === FIGHTS_PER_DAY) setSaved(completeDay(browserStorage(), data.kind, day, results));
    else setCalls(results);
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 text-caption">
        <p className="text-text-muted">{practice ? "Practice week \u00b7 sample fights" : "Today\u2019s recorded fights"}</p>
        <p className="font-semibold text-text">Streak: {streak} {streak === 1 ? "day" : "days"}</p>
      </div>
      {completed ? <DailyResults day={day} practice={practice} results={completed} focus={slot > 0} /> : (
        <CallTheFight key={slot} fight={fight} slot={slot}
          terrain={fight.terrain ? data.directory + "/" + (slot + 1) + ".webp" : undefined}
          onNext={advance} />
      )}
    </div>
  );
}

function DailyResults({ day, practice, results, focus }: { day: number; practice: boolean; results: boolean[]; focus: boolean }) {
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
