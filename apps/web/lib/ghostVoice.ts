/**
 * ghostVoice — the Ghost Coach's spoken-step layer, pure logic only.
 *
 * The widget speaks each armed build step a few seconds before its
 * target time ("sixteen — Gateway"), so the streamer can keep their
 * eyes on the game instead of the HUD. Opt-in via a ``voice=1`` query
 * param on the ghost-build widget URL (toggled in Settings → Overlay
 * next to the Ghost URL); OBS Browser Sources allow speech synthesis
 * without a click, regular browser tabs may need one interaction
 * first.
 *
 * Everything here is deterministic and side-effect-free so it unit
 * tests without a speechSynthesis stub; the widget owns the actual
 * ``speechSynthesis.speak`` calls.
 */

import type { GhostStep } from "@/lib/ghostBuild";

export const GHOST_VOICE_PARAM = "voice";

/** localStorage key for the Settings toggle (client-only preference). */
export const GHOST_VOICE_STORAGE_KEY = "sc2tools:ghost-voice";

/** Speak each step this many seconds before its target time. */
export const GHOST_VOICE_LEAD_SEC = 5;

/** Read the opt-in flag from a widget URL's search string. */
export function ghostVoiceEnabledFromSearch(search: string): boolean {
  try {
    return new URLSearchParams(search).get(GHOST_VOICE_PARAM) === "1";
  } catch {
    return false;
  }
}

/**
 * Append ``voice=1`` to a widget URL, keeping any ``#ghost=`` fragment
 * intact (query params must precede the fragment).
 */
export function appendGhostVoiceToUrl(url: string, on: boolean): string {
  if (!on) return url;
  const hashAt = url.indexOf("#");
  const base = hashAt === -1 ? url : url.slice(0, hashAt);
  const fragment = hashAt === -1 ? "" : url.slice(hashAt);
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}${GHOST_VOICE_PARAM}=1${fragment}`;
}

/** "SpawningPool" → "Spawning Pool" — same spacing rule the HUD uses. */
export function spokenStepName(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

/** The spoken line for one step: "16 — Gateway" (supply optional). */
export function ghostVoiceLine(step: GhostStep): string {
  const name = spokenStepName(step.name);
  return step.supply !== null ? `${step.supply} — ${name}` : name;
}

/**
 * Which step should be spoken now, if any. A step becomes speakable
 * once the clock is within {@link GHOST_VOICE_LEAD_SEC} of its target
 * time; steps are spoken strictly in order and each at most once
 * (``lastSpoken`` is the index of the most recent spoken step, −1 for
 * none). Returns the NEXT index to speak, or null.
 *
 * A big clock jump (browser source reconnect mid-game) advances past
 * multiple due steps — this returns them one call at a time so the
 * widget's utterance queue stays shallow, but callers should treat a
 * jump of many steps as "skip to the last due one" via
 * {@link catchUpIndex} to avoid reading a backlog aloud.
 */
export function nextSpeakIndex(
  steps: readonly GhostStep[],
  clockSec: number,
  lastSpoken: number,
): number | null {
  const idx = lastSpoken + 1;
  if (idx >= steps.length) return null;
  return steps[idx].t - GHOST_VOICE_LEAD_SEC <= clockSec ? idx : null;
}

/**
 * When several steps are already due (late join / clock jump), skip
 * the stale backlog: land on the last currently-due index so the coach
 * resumes at "what should I be doing NOW" instead of narrating the
 * past.
 */
export function catchUpIndex(
  steps: readonly GhostStep[],
  clockSec: number,
  lastSpoken: number,
): number {
  let idx = lastSpoken;
  while (
    idx + 1 < steps.length &&
    steps[idx + 1].t - GHOST_VOICE_LEAD_SEC <= clockSec
  ) {
    idx += 1;
  }
  return idx;
}
