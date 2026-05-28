"use client";

/**
 * Procedural sound effects for the randomizer reveals, synthesised with
 * the Web Audio API — no audio assets, no copyrighted SC2 sounds. Each
 * reveal style gets its own short soundtrack (decelerating wheel ticks,
 * laser "pews", gallop, bumps, etc.) plus a shared winner fanfare.
 *
 * Audio is best-effort: if the browser has no Web Audio, or autoplay is
 * blocked with no user gesture, the calls quietly no-op. In OBS the CEF
 * runtime allows autoplay; in the in-app preview the spin is triggered
 * by a click, which satisfies the gesture requirement.
 */
import { useEffect } from "react";
import type { RevealStyle } from "@/lib/randomizer/types";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;
let enabled = true;
let volume = 0.6;

/** Map a 0..1 user volume onto a sensible master-gain ceiling. */
function masterGainFor(v: number): number {
  return Math.max(0, Math.min(1, v)) * 0.36;
}

/** Master on/off, driven by the randomizer sound setting. */
export function setRevealSoundEnabled(on: boolean): void {
  enabled = on;
}

/** Master volume (0..1), driven by the randomizer sound setting. */
export function setRevealSoundVolume(v: number): void {
  volume = Math.max(0, Math.min(1, v));
  if (master && ctx) {
    master.gain.setTargetAtTime(masterGainFor(volume), ctx.currentTime, 0.02);
  }
}

function audio(): { ctx: AudioContext; master: GainNode } | null {
  if (typeof window === "undefined") return null;
  const AC =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AC) return null;
  try {
    if (!ctx) {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = masterGainFor(volume);
      master.connect(ctx.destination);
    }
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    return { ctx, master: master as GainNode };
  } catch {
    return null;
  }
}

function noiseBuffer(c: AudioContext): AudioBuffer {
  if (noiseBuf && noiseBuf.sampleRate === c.sampleRate) return noiseBuf;
  const len = Math.floor(c.sampleRate * 0.5);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1;
  noiseBuf = buf;
  return buf;
}

interface Sink {
  ctx: AudioContext;
  master: GainNode;
  sources: AudioScheduledSourceNode[];
}

/** Pitched blip with a quick attack and exponential decay. */
function blip(
  s: Sink,
  at: number,
  freq: number,
  dur: number,
  type: OscillatorType,
  peak: number,
): void {
  const o = s.ctx.createOscillator();
  const g = s.ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, at);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.linearRampToValueAtTime(peak, at + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g).connect(s.master);
  o.start(at);
  o.stop(at + dur + 0.02);
  s.sources.push(o);
}

/** Pitch sweep — lasers, charge-ups, claw lifts. */
function sweep(
  s: Sink,
  at: number,
  f0: number,
  f1: number,
  dur: number,
  type: OscillatorType,
  peak: number,
): void {
  const o = s.ctx.createOscillator();
  const g = s.ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, at);
  o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), at + dur);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.linearRampToValueAtTime(peak, at + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g).connect(s.master);
  o.start(at);
  o.stop(at + dur + 0.02);
  s.sources.push(o);
}

/** Filtered noise burst — thuds, bumps, gallop, explosions. */
function thud(
  s: Sink,
  at: number,
  dur: number,
  peak: number,
  lp: number,
): void {
  const src = s.ctx.createBufferSource();
  src.buffer = noiseBuffer(s.ctx);
  const f = s.ctx.createBiquadFilter();
  f.type = "lowpass";
  f.frequency.value = lp;
  const g = s.ctx.createGain();
  g.gain.setValueAtTime(peak, at);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  src.connect(f).connect(g).connect(s.master);
  src.start(at);
  src.stop(at + dur + 0.02);
  s.sources.push(src);
}

/** Triumphant ascending chord on the winner reveal. */
function fanfare(s: Sink, at: number): void {
  const notes = [523.25, 659.25, 783.99, 1046.5];
  notes.forEach((f, i) => blip(s, at + i * 0.09, f, 0.5, "triangle", 0.5));
  blip(s, at + notes.length * 0.09, 1318.5, 0.7, "triangle", 0.4);
}

export interface SoundtrackOpts {
  style: RevealStyle;
  durationMs: number;
  reducedMotion: boolean;
  /** ms offsets (from start) at which contestants are eliminated. */
  eliminationTimesMs?: number[];
}

/**
 * Schedule a reveal's whole soundtrack up front using the audio clock.
 * Returns a disposer that stops every scheduled node (so a re-spin or
 * unmount cuts the audio cleanly).
 */
export function playSoundtrack(opts: SoundtrackOpts): () => void {
  if (!enabled) return () => {};
  const a = audio();
  if (!a) return () => {};
  const sink: Sink = { ctx: a.ctx, master: a.master, sources: [] };
  const t0 = a.ctx.currentTime + 0.03;
  const dur = opts.durationMs / 1000;
  const elims = (opts.eliminationTimesMs ?? []).map((m) => t0 + m / 1000);

  if (opts.reducedMotion) {
    fanfare(sink, t0);
    return disposer(sink);
  }

  switch (opts.style) {
    case "wheel":
    case "case":
      decelTicks(sink, t0, dur);
      fanfare(sink, t0 + dur);
      break;
    case "slot":
      decelTicks(sink, t0, dur * 0.95);
      [0.6, 0.77, 0.95].forEach((f) => thud(sink, t0 + dur * f, 0.16, 0.6, 900));
      fanfare(sink, t0 + dur);
      break;
    case "gacha":
      sweep(sink, t0, 180, 1200, dur * 0.85, "sawtooth", 0.4);
      thud(sink, t0 + dur * 0.85, 0.25, 0.7, 5000);
      fanfare(sink, t0 + dur * 0.9);
      break;
    case "fighter":
      beepBoops(sink, t0, dur, 0.42);
      elims.forEach((at) => thud(sink, at, 0.18, 0.7, 1100));
      fanfare(sink, t0 + dur);
      break;
    case "sumo":
      beepBoops(sink, t0, dur, 0.5);
      elims.forEach((at) => thud(sink, at, 0.26, 0.85, 600));
      fanfare(sink, t0 + dur);
      break;
    case "asteroid":
      beepBoops(sink, t0, dur, 0.5);
      elims.forEach((at) => {
        sweep(sink, at, 1400, 200, 0.22, "square", 0.5);
        thud(sink, at + 0.05, 0.2, 0.5, 3000);
      });
      fanfare(sink, t0 + dur);
      break;
    case "swarm":
      elims.forEach((at) => sweep(sink, at, 700, 160, 0.22, "sine", 0.6));
      fanfare(sink, t0 + dur);
      break;
    case "race":
      gallop(sink, t0, dur);
      blip(sink, t0 + dur - 0.05, 880, 0.6, "square", 0.5);
      fanfare(sink, t0 + dur);
      break;
    case "claw":
      // Motor hum while the claw tracks + descends, clunk on grab, a
      // rising lift, then the reveal.
      sweep(sink, t0, 120, 90, dur * 0.5, "sawtooth", 0.18);
      thud(sink, t0 + dur * 0.55, 0.18, 0.6, 1200);
      sweep(sink, t0 + dur * 0.62, 200, 520, dur * 0.28, "square", 0.25);
      fanfare(sink, t0 + dur);
      break;
    case "battle":
    default:
      beepBoops(sink, t0, dur, 0.42);
      elims.forEach((at) => thud(sink, at, 0.16, 0.6, 1400));
      fanfare(sink, t0 + dur);
      break;
  }

  return disposer(sink);
}

function disposer(sink: Sink): () => void {
  return () => {
    for (const src of sink.sources) {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
    }
    sink.sources = [];
  };
}

/** A run of clicks that start fast and slow down — wheel / case / slot. */
function decelTicks(s: Sink, t0: number, dur: number): void {
  let t = 0;
  let gap = 0.045;
  while (t < dur) {
    blip(s, t0 + t, 1500, 0.05, "square", 0.18);
    t += gap;
    gap = Math.min(0.42, gap * 1.12);
  }
}

/** Alternating two-tone "beep boop" movement bed. */
function beepBoops(s: Sink, t0: number, dur: number, gap: number): void {
  let t = 0;
  let hi = true;
  while (t < dur) {
    blip(s, t0 + t, hi ? 660 : 420, 0.09, "square", 0.16);
    hi = !hi;
    t += gap;
  }
}

/** Rhythmic galloping noise bursts for the horse race. */
function gallop(s: Sink, t0: number, dur: number): void {
  let t = 0;
  // da-da-dum triplet feel.
  const pattern = [0, 0.12, 0.22];
  while (t < dur) {
    for (const p of pattern) thud(s, t0 + t + p, 0.09, 0.4, 400);
    t += 0.42;
  }
}

/**
 * Fire a reveal's soundtrack once per spin. Cleans up (stops audio) on
 * unmount or when the spin changes.
 */
export function useRevealSound(
  opts: SoundtrackOpts & { spinId: number },
): void {
  const { spinId } = opts;
  useEffect(() => {
    const dispose = playSoundtrack(opts);
    return dispose;
    // Re-run only when the spin changes; opts is read at schedule time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spinId]);
}
