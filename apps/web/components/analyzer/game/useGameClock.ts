"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { clampReplayTime } from "@/lib/replayLink";

export function useGameClock(gameId: string, initialTimeSec?: number | null, durationSec?: number | null) {
  const router = useRouter();
  const routerRef = useRef(router); routerRef.current = router;
  const duration = useRef(durationSec); duration.current = durationSec;
  const initial = clampReplayTime(initialTimeSec, durationSec) ?? 0;
  const [time, setTime] = useState(initial);
  const currentTime = useRef(initial);
  const [seekRequest, setSeekRequest] = useState<{ t: number; seq: number } | null>(null);
  const sequence = useRef(0);
  const stageRef = useRef<HTMLDivElement>(null);
  const playing = useRef(false);
  const lastPublish = useRef(-Infinity);
  const tickTimer = useRef<number | null>(null);
  const urlTimer = useRef<number | null>(null);
  const focusTimer = useRef<number | null>(null);
  const focusedStage = useRef<HTMLElement | null>(null);
  const expectedNavigation = useRef<number | null>(null);
  const priorInitial = useRef(initial);

  const persist = useCallback(() => {
    if (urlTimer.current !== null) window.clearTimeout(urlTimer.current);
    urlTimer.current = window.setTimeout(() => {
      urlTimer.current = null;
      if (playing.current) return;
      const url = new URL(window.location.href);
      if (url.pathname !== `/app/game/${encodeURIComponent(gameId)}`) return;
      const t = Math.floor(currentTime.current);
      url.searchParams.set("t", String(t));
      if (url.href !== window.location.href) {
        expectedNavigation.current = t;
        routerRef.current.replace(`${url.pathname}${url.search}${url.hash}`, { scroll: false });
      }
    }, 500);
  }, [gameId]);

  const seek = useCallback((requested: number, { reveal = true, persist: persistUrl = true }: { reveal?: boolean; persist?: boolean } = {}) => {
    const t = clampReplayTime(requested, duration.current);
    if (t === null) return;
    currentTime.current = t; playing.current = false;
    if (!persistUrl && urlTimer.current !== null) { window.clearTimeout(urlTimer.current); urlTimer.current = null; }
    if (tickTimer.current !== null) window.clearTimeout(tickTimer.current);
    tickTimer.current = null; setTime(t);
    setSeekRequest({ t, seq: ++sequence.current });
    if (reveal) {
      const stage = stageRef.current?.querySelector<HTMLElement>("[data-replay-stage]") ?? stageRef.current;
      if (stage) {
        const rect = stage.getBoundingClientRect();
        if (rect.bottom <= 0 || rect.top >= window.innerHeight) stage.scrollIntoView?.({ block: "start", behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
        stage.focus({ preventScroll: true });
        focusedStage.current?.removeAttribute("data-clock-seek");
        stage.setAttribute("data-clock-seek", ""); focusedStage.current = stage;
        if (focusTimer.current !== null) window.clearTimeout(focusTimer.current);
        focusTimer.current = window.setTimeout(() => stage.removeAttribute("data-clock-seek"), 1000);
      }
    }
    if (persistUrl) persist();
  }, [persist]);

  useEffect(() => {
    if (initial === priorInitial.current) return;
    priorInitial.current = initial;
    if (initial === expectedNavigation.current) { expectedNavigation.current = null; return; }
    if (Math.abs(initial - currentTime.current) > .01) seek(initial, { reveal: false, persist: false });
  }, [initial, seek]);

  const onPlaybackTimeChange = useCallback((requested: number) => {
    const t = clampReplayTime(requested, duration.current);
    if (t === null) return;
    currentTime.current = t;
    const elapsed = Date.now() - lastPublish.current;
    if (elapsed >= 500) { lastPublish.current = Date.now(); setTime(t); }
    else if (tickTimer.current === null) tickTimer.current = window.setTimeout(() => {
      tickTimer.current = null; lastPublish.current = Date.now(); setTime(currentTime.current);
    }, 500 - elapsed);
  }, []);

  const onPlaybackStateChange = useCallback((next: boolean, t: number) => {
    const wasPlaying = playing.current; playing.current = next;
    if (next && urlTimer.current !== null) { window.clearTimeout(urlTimer.current); urlTimer.current = null; }
    if (!next && wasPlaying) { currentTime.current = clampReplayTime(t, duration.current) ?? currentTime.current; setTime(currentTime.current); persist(); }
  }, [persist]);
  const onStageSeek = useCallback((requested: number) => {
    const t = clampReplayTime(requested, duration.current);
    if (t === null) return;
    currentTime.current = t; playing.current = false; setTime(t); persist();
  }, [persist]);
  useEffect(() => () => {
    for (const timer of [tickTimer.current, urlTimer.current, focusTimer.current]) if (timer !== null) window.clearTimeout(timer);
    focusedStage.current?.removeAttribute("data-clock-seek");
  }, []);

  const linkAtCurrentTime = useCallback(() => {
    const url = new URL(window.location.href); url.searchParams.set("t", String(Math.floor(currentTime.current))); return url.href;
  }, []);
  return { t: clampReplayTime(time, durationSec) ?? 0, seek, seekRequest, stageRef, onPlaybackTimeChange, onPlaybackStateChange, onStageSeek, linkAtCurrentTime };
}
