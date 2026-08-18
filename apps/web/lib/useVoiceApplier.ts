"use client";

import { useCallback, useEffect, useRef } from "react";
import { resolveVoice, type VoiceWish } from "@/lib/voiceCatalog";

/**
 * useVoiceApplier — stamp the streamer's chosen voice onto an utterance.
 *
 * Every spoken surface in the app used to roll its own voice handling,
 * and two of them (the Ghost Coach and the dock's read-aloud) rolled
 * *none at all*: they constructed a bare ``SpeechSynthesisUtterance``
 * and let the engine choose. On Windows the engine default is Microsoft
 * David — a male voice — so a streamer who had carefully picked a female
 * voice in Settings still heard David everywhere except the scouting
 * readout. This hook is the one place that decision now lives.
 *
 * Two details it exists to get right:
 *
 *   - **Async catalogs.** ``getVoices()`` returns ``[]`` until Chromium
 *     has populated its list, and inside OBS' CEF it can transiently go
 *     empty again afterwards. We cache the last non-empty answer and
 *     re-read on every call, so a widget that speaks early still lands
 *     on the right voice.
 *   - **Honest substitution.** The actual matching ladder is
 *     {@link resolveVoice}, shared with the scouting readout, so a voice
 *     that has to be substituted degrades the same way everywhere —
 *     same language, same gender.
 *
 * Returns a stable ``applyVoice(utterance)``. It mutates the utterance
 * in place and leaves it untouched when no preference resolves, which
 * correctly falls through to the engine default.
 */
export function useVoiceApplier(wish: VoiceWish | undefined) {
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);
  const wishRef = useRef<VoiceWish | undefined>(wish);
  wishRef.current = wish;

  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    const synth = window.speechSynthesis;
    const load = () => {
      const next = synth.getVoices();
      if (next.length > 0) voicesRef.current = next;
    };
    load();
    synth.addEventListener("voiceschanged", load);
    return () => synth.removeEventListener("voiceschanged", load);
  }, []);

  return useCallback((utterance: SpeechSynthesisUtterance) => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    const latest = window.speechSynthesis.getVoices();
    if (latest.length > 0) voicesRef.current = latest;
    const resolution = resolveVoice(voicesRef.current, wishRef.current);
    if (!resolution.voice) return;
    utterance.voice = resolution.voice;
    utterance.lang = resolution.voice.lang || "en-US";
  }, []);
}
