"use client";

import { useEffect, useState } from "react";

const AUDIO_ON = new Set(["1", "true", "on", "yes"]);
const AUDIO_OFF = new Set(["0", "false", "off", "no"]);

/**
 * Audio-capable chat widgets remain on by default for legacy Browser Sources.
 * OBS-managed copies receive an explicit role; damaged explicit roles fail
 * silent so a typo can never create a second TTS/ding/event-sound renderer.
 */
export function resolveWidgetAudioOwner(search: string): boolean {
  const raw = new URLSearchParams(search).get("audio");
  if (raw === null) return true;
  const normalized = raw.trim().toLowerCase();
  if (AUDIO_ON.has(normalized)) return true;
  if (AUDIO_OFF.has(normalized)) return false;
  return false;
}

/** Hydrate silent, then honor the Browser Source's explicit role. */
export function useWidgetAudioOwner(): boolean {
  const [owner, setOwner] = useState(false);
  useEffect(() => {
    const update = () => setOwner(resolveWidgetAudioOwner(window.location.search));
    update();
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  return owner;
}

/**
 * Poll the Web Speech queue while an owner is eligible to reload. Chromium
 * exposes no reliable event for the pending->idle transition, so a small poll
 * prevents a deployment refresh from cutting off an active TTS line.
 */
export function useSpeechSynthesisIdle(enabled: boolean): boolean {
  const [idle, setIdle] = useState(true);
  useEffect(() => {
    if (!enabled) {
      setIdle(true);
      return;
    }
    const update = () => {
      const speech = window.speechSynthesis;
      setIdle(!speech || (!speech.speaking && !speech.pending));
    };
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [enabled]);
  return idle;
}
