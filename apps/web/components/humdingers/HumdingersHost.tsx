"use client";

import { useAuth } from "@clerk/nextjs";
import { useCallback, useEffect, useRef, useState } from "react";
import { HUMDINGERS_FILE } from "@/lib/humdingers";
import { PlayTracker, type PlayReport } from "@/lib/humdingers/playTracker";
import { SaveUploader, TokenCache, accountFetch, localProgress, pullSaves, slotOf } from "@/lib/humdingers/saveSync";

/** The game never waits longer than this on the account; it starts and syncs later. */
export const SYNC_TIMEOUT_MS = 4_000;
const INPUT_EVENTS = ["keydown", "pointerdown", "touchstart"] as const;

type Session = { uploader: SaveUploader; tracker: PlayTracker };

/**
 * Runs Humdingers full screen in a same-origin frame (ADR 0102). Before the
 * game starts it brings the account's newer saves into this browser; while
 * the game runs it uploads each save and reports play time, which the API
 * adds to the daily totals and to this visit's play session on the account
 * (ADR 0103). Middleware already requires sign-in here.
 */
export function HumdingersHost() {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const [ready, setReady] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const sessionRef = useRef<Session | null>(null);
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;

  // A blocked or slow sign-in script must not keep anyone from playing.
  useEffect(() => {
    if (isLoaded) return;
    const timer = window.setTimeout(() => setReady(true), SYNC_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [isLoaded]);

  useEffect(() => {
    if (!isLoaded) return;
    let active = true;
    const storage = window.localStorage;
    const tokens = new TokenCache(() => getTokenRef.current());
    const uploader = new SaveUploader(tokens, storage);
    const send = isSignedIn
      ? (report: PlayReport, keepalive: boolean) => sendPlay(tokens, report, keepalive)
      : () => undefined;
    const tracker = new PlayTracker(send, () => localProgress(storage));
    sessionRef.current = { uploader, tracker };
    const start = () => { if (active) setReady(true); };

    if (isSignedIn) {
      const pulled = pullSaves(tokens, storage).then((missing) => {
        for (const save of missing) uploader.queue(save.slot, save.data);
      });
      void Promise.race([pulled, wait(SYNC_TIMEOUT_MS)]).catch(() => undefined).finally(start);
    } else {
      start();
    }

    const onStorage = (event: StorageEvent) => {
      const slot = isSignedIn && event.storageArea === storage ? slotOf(event.key) : null;
      if (slot) uploader.queue(slot, event.newValue);
    };
    const onVisibility = () => {
      if (document.visibilityState !== "hidden") return;
      tracker.report(false);
      void uploader.flush();
    };
    const onPageHide = () => {
      tracker.report(true);
      uploader.flushOnExit();
    };
    const tick = window.setInterval(() => {
      if (gamepadPressed()) tracker.input();
      tracker.tick(document.visibilityState === "visible");
    }, 1_000);
    window.addEventListener("storage", onStorage);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      active = false;
      window.clearInterval(tick);
      window.removeEventListener("storage", onStorage);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      uploader.dispose();
      sessionRef.current = null;
    };
  }, [isLoaded, isSignedIn]);

  const onFrameLoad = useCallback(() => {
    const frame = frameRef.current;
    const view = frame?.contentWindow;
    // Focusing the frame sends key presses straight into the game.
    frame?.focus();
    const session = sessionRef.current;
    if (!view || !session) return;
    const input = () => session.tracker.input();
    for (const type of INPUT_EVENTS) view.addEventListener(type, input, { capture: true, passive: true });
    session.tracker.loaded();
  }, []);

  return (
    <div className="fixed inset-0 bg-black">
      {ready ? (
        <iframe
          ref={frameRef}
          src={HUMDINGERS_FILE}
          title="Humdingers"
          allow="fullscreen; autoplay; gamepad"
          allowFullScreen
          onLoad={onFrameLoad}
          className="block h-dvh w-full border-0"
        />
      ) : (
        <p role="status" className="flex h-dvh items-center justify-center text-caption text-white/70">
          Loading your saves…
        </p>
      )}
    </div>
  );
}

function sendPlay(tokens: TokenCache, report: PlayReport, keepalive: boolean): void {
  void accountFetch(tokens, "/v1/me/humdingers/plays", { method: "POST", body: JSON.stringify(report), keepalive }).catch(() => undefined);
}

function gamepadPressed(): boolean {
  const pads = typeof navigator.getGamepads === "function" ? navigator.getGamepads() : [];
  return Array.from(pads).some((pad) => Boolean(pad?.buttons.some((button) => button.pressed)));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => { window.setTimeout(resolve, ms); });
}
