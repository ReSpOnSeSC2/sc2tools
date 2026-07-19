"use client";

// useChatTts — binds the queued chat speaker (lib/multichat/tts) to a
// live message stream. Speaks only messages that ARRIVE after mount
// (never the replayed backlog), dedupes by (platform, id), and carries
// the browser-autoplay gesture unlock across OBS restarts using the
// same persistence as the scouting voice readout.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  persistUnlock,
  readPersistedUnlock,
} from "@/components/overlay/useVoiceReadout.gesture";
import {
  createChatSpeaker,
  sanitizeTtsConfig,
  type ChatSpeaker,
  type ChatTtsConfig,
} from "./tts";
import type { ChatMessage } from "./types";

/** Bounded spoken-id memory — enough for hours of chat. */
const SPOKEN_IDS_CAP = 2000;

export function useChatTts(
  messages: ReadonlyArray<ChatMessage>,
  rawConfig: unknown,
): { needsGesture: boolean; onUserGesture: () => void } {
  const config: ChatTtsConfig = useMemo(
    () => sanitizeTtsConfig(rawConfig),
    [rawConfig],
  );
  const [needsGesture, setNeedsGesture] = useState(false);
  const speakerRef = useRef<ChatSpeaker | null>(null);
  const spokenRef = useRef<Set<string>>(new Set());
  const mountedAtRef = useRef<number>(Date.now());

  // (Re)build the speaker when the TTS settings change.
  useEffect(() => {
    if (!config.enabled) {
      speakerRef.current?.close();
      speakerRef.current = null;
      setNeedsGesture(false);
      return;
    }
    const speaker = createChatSpeaker(config, (blocked) => {
      setNeedsGesture(blocked);
    });
    speakerRef.current = speaker;
    // A prior session's gesture unlock usually carries over; if the
    // browser still refuses, the first speak() re-raises the banner.
    if (readPersistedUnlock()) setNeedsGesture(false);
    return () => {
      speaker.close();
      if (speakerRef.current === speaker) speakerRef.current = null;
    };
  }, [config]);

  // Speak newly-arrived messages. Runs even while TTS is disabled so
  // every visible line gets MARKED as seen — otherwise flipping TTS on
  // mid-session (the widget's config poll) would read out the whole
  // on-screen backlog instead of only chat that arrives from then on.
  useEffect(() => {
    const speaker = speakerRef.current;
    for (const m of messages) {
      const key = `${m.platform}:${m.id}`;
      if (spokenRef.current.has(key)) continue;
      spokenRef.current.add(key);
      if (!speaker || !config.enabled) continue;
      // Backlog guard: anything time-stamped before this source loaded
      // is history, not live chat — mark seen, don't read it.
      if (m.atMs < mountedAtRef.current - 2000) continue;
      speaker.speak(m);
    }
    if (spokenRef.current.size > SPOKEN_IDS_CAP) {
      // Rebuild the set from the still-visible tail.
      spokenRef.current = new Set(
        messages.map((m) => `${m.platform}:${m.id}`),
      );
    }
  }, [messages, config.enabled]);

  return {
    needsGesture: config.enabled && needsGesture,
    onUserGesture: () => {
      persistUnlock();
      speakerRef.current?.unlock();
      setNeedsGesture(false);
    },
  };
}
