"use client";

// useEventSounds — plays the configured alert sound for newly-arrived
// platform events (subs, raids, gifts…). Same arrival semantics as
// useChatSound: events are marked as seen even while disabled (so
// flipping alert sounds on mid-session doesn't fire for the on-screen
// backlog), and only events arriving after mount ring. The per-kind
// effect mapping lives in the sound config (sanitizeSoundConfig).

import { useEffect, useMemo, useRef } from "react";
import { API_BASE } from "@/lib/clientApi";
import {
  createEventSounder,
  sanitizeSoundConfig,
  type ChatSoundConfig,
  type EventSounder,
} from "./sound";
import { chatEventIdentity, type ChatEvent } from "./events";

const SEEN_IDS_CAP = 500;

export function useEventSounds(
  events: ReadonlyArray<ChatEvent>,
  rawConfig: unknown,
): void {
  const config: ChatSoundConfig = useMemo(
    () => sanitizeSoundConfig(rawConfig),
    [rawConfig],
  );
  const sounderRef = useRef<EventSounder | null>(null);
  const seenRef = useRef<Set<string>>(new Set());
  const mountedAtRef = useRef<number>(Date.now());

  useEffect(() => {
    if (!config.eventSoundsEnabled) {
      sounderRef.current?.close();
      sounderRef.current = null;
      return;
    }
    const sounder = createEventSounder(config, API_BASE);
    sounderRef.current = sounder;
    return () => {
      sounder.close();
      if (sounderRef.current === sounder) sounderRef.current = null;
    };
  }, [config]);

  useEffect(() => {
    const sounder = sounderRef.current;
    for (const e of events) {
      const key = chatEventIdentity(e);
      if (seenRef.current.has(key)) continue;
      seenRef.current.add(key);
      if (
        !config.eventSoundsEnabled ||
        e.replayed === true ||
        e.atMs < mountedAtRef.current - 2000
      ) {
        continue;
      }
      // The sounder throttles internally — a gift train plays once.
      sounder?.play(e.kind);
    }
    if (seenRef.current.size > SEEN_IDS_CAP) {
      seenRef.current = new Set(events.map(chatEventIdentity));
    }
  }, [events, config.eventSoundsEnabled]);
}
