"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import type { GhostTarget } from "@/lib/ghostBuild";
import { ghostVoiceLine, nextSpeakIndex, spokenStepName } from "@/lib/ghostVoice";
import { fmtClock } from "@/lib/guides/format";
import { useVoiceApplier } from "@/lib/useVoiceApplier";

type DrillClock = { seconds: number; started: number | null };
const RESET_CLOCK: DrillClock = { seconds: 0, started: null };
const ENGLISH = { lang: "en-US" };

function elapsed(clock: DrillClock, now: number): number {
  return Math.max(0, clock.seconds + (clock.started === null ? 0 : (now - clock.started) / 1000));
}

function canSpeak() {
  return typeof window !== "undefined" && typeof window.SpeechSynthesisUtterance === "function" && !!window.speechSynthesis;
}

function useDrillWakeLock(running: boolean) {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    setHeld(false);
    if (!running || !navigator.wakeLock) return;
    let live = true, pending = false, lock: WakeLockSentinel | null = null;
    const acquire = async () => {
      if (document.visibilityState !== "visible" || pending || lock && !lock.released) return;
      pending = true;
      try {
        const next = await navigator.wakeLock.request("screen");
        if (!live || document.visibilityState !== "visible") { await next.release(); return; }
        lock = next;
        setHeld(true);
        next.addEventListener("release", () => { if (live) setHeld(false); });
      } catch { if (live) setHeld(false); }
      finally { pending = false; }
    };
    void acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", acquire);
      if (lock && !lock.released) void lock.release().catch(() => {});
    };
  }, [running]);
  return held;
}

function useDrillSpeech(steps: GhostTarget["steps"]) {
  const [supported, setSupported] = useState(false);
  const lastSpoken = useRef(-1);
  const spoke = useRef(false);
  const applyVoice = useVoiceApplier(ENGLISH);

  const speak = useCallback((line: string) => {
    if (!canSpeak()) return;
    const utterance = new SpeechSynthesisUtterance(line);
    utterance.lang = ENGLISH.lang;
    applyVoice(utterance);
    spoke.current = true;
    speechSynthesis.speak(utterance);
  }, [applyVoice]);

  const speakDue = useCallback((time: number) => {
    const previous = lastSpoken.current;
    for (let index = nextSpeakIndex(steps, time, previous); index !== null; index = nextSpeakIndex(steps, time, index)) {
      lastSpoken.current = index;
      speak(ghostVoiceLine(steps[index]));
    }
    return lastSpoken.current !== previous;
  }, [speak, steps]);

  const stop = useCallback(() => { if (spoke.current && canSpeak()) speechSynthesis.cancel(); }, []);
  const rewind = () => { stop(); lastSpoken.current = -1; };
  useEffect(() => {
    setSupported(canSpeak());
    return stop;
  }, [stop]);
  return { supported, speak, speakDue, stop, rewind };
}

function useDrillClock(target: GhostTarget) {
  const [clock, setClock] = useState(RESET_CLOCK);
  const [now, setNow] = useState(0);
  const { supported, speak, speakDue, stop, rewind } = useDrillSpeech(target.steps);
  const running = clock.started !== null;
  const end = target.steps.at(-1)?.t ?? 0;
  const seconds = Math.min(end, elapsed(clock, now));
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(performance.now()), 200);
    return () => window.clearInterval(timer);
  }, [running]);
  useEffect(() => {
    if (!running) return;
    speakDue(seconds);
    if (seconds >= end) setClock({ seconds: end, started: null });
  }, [end, running, seconds, speakDue]);

  function toggle() {
    const time = performance.now();
    const position = Math.min(end, elapsed(clock, time));
    if (running) {
      stop();
      setClock({ seconds: position, started: null });
    } else {
      const resume = position < end ? position : 0;
      if (position >= end) rewind();
      setNow(time);
      setClock({ seconds: resume, started: time });
      if (!speakDue(resume)) speak(resume ? "Drill resumed." : "Drill started.");
    }
  }

  function nudge(delta: number) {
    const time = performance.now();
    setNow(time);
    setClock({ seconds: Math.min(end, Math.max(0, elapsed(clock, time) + delta)), started: running ? time : null });
  }

  function reset() {
    rewind();
    setClock(RESET_CLOCK);
  }

  return { running, seconds, supported, end, toggle, nudge, reset };
}

export function BrowserDrill({ target }: { target: GhostTarget }) {
  const clock = useDrillClock(target);
  const awake = useDrillWakeLock(clock.running);
  const next = target.steps.findIndex(step => step.t > clock.seconds);
  return <section aria-label="Spoken build drill" className="space-y-4">
    <div className="flex flex-wrap items-center gap-2">
      <output aria-label="Drill time" aria-live="off" className="w-16 text-body-lg font-semibold tabular-nums">{fmtClock(clock.seconds)}</output>
      <Button className="min-h-11" onClick={clock.toggle}>{clock.running ? "Pause" : clock.seconds >= clock.end ? "Start again" : clock.seconds ? "Resume" : "Start drill"}</Button>
      <Button variant="secondary" className="min-h-11" aria-label="Back one second" onClick={() => clock.nudge(-1)}>−1 s</Button>
      <Button variant="secondary" className="min-h-11" aria-label="Forward one second" onClick={() => clock.nudge(1)}>+1 s</Button>
      <Button variant="secondary" className="min-h-11" onClick={clock.reset}>Reset</Button>
    </div>
    <p className="text-caption text-text-muted">{clock.supported ? "Steps are spoken five seconds before they’re due." : "Speech is unavailable. Follow the timed steps below."}</p>
    {awake ? <p className="text-caption text-text-muted">Keeping this screen awake while visible.</p> : null}
    <ol className="space-y-1" aria-label="Timed drill steps">
      {target.steps.map((step, index) => <li key={index} aria-current={index === next ? "step" : undefined}
        className={`flex flex-wrap gap-x-3 rounded-lg border border-line px-3 py-2 ${index === next ? "bg-bg-elevated font-semibold" : ""}`}>
        <span className="w-12 tabular-nums text-text-muted">{fmtClock(step.t)}</span>
        <span>{spokenStepName(step.name)}{step.supply !== null ? ` · ${step.supply} supply` : ""}</span>
      </li>)}
    </ol>
  </section>;
}
