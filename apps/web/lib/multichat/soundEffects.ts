// Multichat sound-effect library — every effect is SYNTHESIZED with
// WebAudio (oscillators, noise buffers, envelopes): no audio assets,
// no CDN fetches, no licensing, and the OBS Browser Source can play
// them fully offline. Recipes aim for instantly-recognizable "stream
// alert" vibes across four moods: Classic pings, Cool sci-fi, Arcade
// chiptune/meme staples, and Funny cartoon gags.
//
// The id list is a wire contract: ids are stored in the streamer's
// sound preferences and whitelisted by the API's sanitizer
// (services/multichatAppearance.js SOUND_EFFECT_IDS — keep in sync).

export type SoundEffectCategory = "classic" | "cool" | "arcade" | "funny";

export interface SoundEffectMeta {
  id: SoundEffectId;
  label: string;
  category: SoundEffectCategory;
  /** One-liner for pickers/tooltips. */
  description: string;
}

export type SoundEffectId =
  | "ding"
  | "pop"
  | "doorbell"
  | "sparkle"
  | "laser"
  | "power-up"
  | "riser"
  | "boom"
  | "coin"
  | "victory"
  | "airhorn"
  | "bass-drop"
  | "sad-trombone"
  | "boing"
  | "slide-whistle"
  | "drumroll";

export const SOUND_EFFECTS: readonly SoundEffectMeta[] = [
  { id: "ding", label: "Ding", category: "classic", description: "The friendly two-tone notification blip" },
  { id: "pop", label: "Pop", category: "classic", description: "A soft bubble pop" },
  { id: "doorbell", label: "Doorbell", category: "classic", description: "Ding-dong — someone's here" },
  { id: "sparkle", label: "Sparkle", category: "cool", description: "A glittery ascending bell run" },
  { id: "laser", label: "Laser", category: "cool", description: "Pew! A sci-fi zap" },
  { id: "power-up", label: "Power-up", category: "cool", description: "Rising retro arpeggio" },
  { id: "riser", label: "Riser", category: "cool", description: "A cinematic whoosh build" },
  { id: "boom", label: "Boom", category: "cool", description: "Deep cinematic impact" },
  { id: "coin", label: "Coin", category: "arcade", description: "Cha-ching — arcade pickup" },
  { id: "victory", label: "Victory", category: "arcade", description: "8-bit win fanfare" },
  { id: "airhorn", label: "Airhorn", category: "arcade", description: "The MLG hype horn" },
  { id: "bass-drop", label: "Bass drop", category: "arcade", description: "Wub — the beat drops" },
  { id: "sad-trombone", label: "Sad trombone", category: "funny", description: "Womp womp womp womppp" },
  { id: "boing", label: "Boing", category: "funny", description: "Cartoon spring bounce" },
  { id: "slide-whistle", label: "Slide whistle", category: "funny", description: "A rising slide whistle" },
  { id: "drumroll", label: "Drumroll", category: "funny", description: "Snare roll with a crash finish" },
] as const;

export const SOUND_EFFECT_IDS: readonly SoundEffectId[] = SOUND_EFFECTS.map(
  (e) => e.id,
);

export const SOUND_CATEGORY_LABEL: Record<SoundEffectCategory, string> = {
  classic: "Classic",
  cool: "Cool",
  arcade: "Arcade & meme",
  funny: "Funny",
};

export function isSoundEffectId(value: unknown): value is SoundEffectId {
  return SOUND_EFFECT_IDS.includes(value as SoundEffectId);
}

/* ──────────────── synthesis helpers ──────────────── */

type Recipe = (ctx: AudioContext, out: GainNode, t0: number) => void;

function osc(
  ctx: AudioContext,
  out: AudioNode,
  type: OscillatorType,
  freq: number,
  start: number,
  stop: number,
  detune = 0,
): OscillatorNode {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, start);
  if (detune) o.detune.setValueAtTime(detune, start);
  o.connect(out);
  o.start(start);
  o.stop(stop);
  return o;
}

/** Gain node with an attack/decay envelope, connected to ``out``. */
function envelope(
  ctx: AudioContext,
  out: AudioNode,
  start: number,
  peak: number,
  attack: number,
  end: number,
): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(peak, start + attack);
  g.gain.exponentialRampToValueAtTime(0.001, end);
  g.connect(out);
  return g;
}

/** White-noise source (buffer built on demand, ~1s, looped as needed). */
function noise(
  ctx: AudioContext,
  out: AudioNode,
  start: number,
  stop: number,
): AudioBufferSourceNode {
  const length = Math.ceil(ctx.sampleRate);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  // Deterministic pseudo-noise — indistinguishable from random to the
  // ear, and keeps effects byte-identical between plays.
  let seed = 0x9e3779b9;
  for (let i = 0; i < length; i += 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    data[i] = (seed / 0xffffffff) * 2 - 1;
  }
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  src.connect(out);
  src.start(start);
  src.stop(stop);
  return src;
}

/* ──────────────── recipes ──────────────── */

const RECIPES: Record<SoundEffectId, Recipe> = {
  ding(ctx, out, t0) {
    const g = envelope(ctx, out, t0, 0.25, 0.012, t0 + 0.35);
    osc(ctx, g, "sine", 1318.5, t0, t0 + 0.12);
    osc(ctx, g, "sine", 1975.5, t0 + 0.1, t0 + 0.35);
  },

  pop(ctx, out, t0) {
    const g = envelope(ctx, out, t0, 0.35, 0.004, t0 + 0.12);
    const o = osc(ctx, g, "sine", 900, t0, t0 + 0.12);
    o.frequency.exponentialRampToValueAtTime(280, t0 + 0.09);
  },

  doorbell(ctx, out, t0) {
    const g1 = envelope(ctx, out, t0, 0.22, 0.01, t0 + 0.45);
    osc(ctx, g1, "sine", 659.3, t0, t0 + 0.45);
    osc(ctx, g1, "sine", 1318.5, t0, t0 + 0.2);
    const g2 = envelope(ctx, out, t0 + 0.32, 0.22, 0.01, t0 + 0.95);
    osc(ctx, g2, "sine", 523.3, t0 + 0.32, t0 + 0.95);
    osc(ctx, g2, "sine", 1046.5, t0 + 0.32, t0 + 0.55);
  },

  sparkle(ctx, out, t0) {
    // Pentatonic bell run with a soft octave shimmer on each note.
    const notes = [1046.5, 1174.7, 1318.5, 1568, 2093];
    notes.forEach((f, i) => {
      const at = t0 + i * 0.07;
      const g = envelope(ctx, out, at, 0.14, 0.006, at + 0.5);
      osc(ctx, g, "sine", f, at, at + 0.5);
      osc(ctx, g, "sine", f * 2, at, at + 0.25);
    });
  },

  laser(ctx, out, t0) {
    const g = envelope(ctx, out, t0, 0.22, 0.005, t0 + 0.3);
    const o1 = osc(ctx, g, "sawtooth", 1800, t0, t0 + 0.28);
    o1.frequency.exponentialRampToValueAtTime(160, t0 + 0.25);
    const o2 = osc(ctx, g, "square", 2400, t0, t0 + 0.18);
    o2.frequency.exponentialRampToValueAtTime(300, t0 + 0.16);
  },

  "power-up"(ctx, out, t0) {
    const steps = [523.3, 659.3, 784, 1046.5, 1318.5];
    steps.forEach((f, i) => {
      const at = t0 + i * 0.07;
      const g = envelope(ctx, out, at, 0.16, 0.005, at + 0.14);
      osc(ctx, g, "square", f, at, at + 0.12);
    });
    const at = t0 + steps.length * 0.07;
    const g = envelope(ctx, out, at, 0.18, 0.005, at + 0.4);
    osc(ctx, g, "square", 1568, at, at + 0.38);
  },

  riser(ctx, out, t0) {
    const g = envelope(ctx, out, t0, 0.3, 0.55, t0 + 0.8);
    const o = osc(ctx, g, "sawtooth", 180, t0, t0 + 0.75);
    o.frequency.exponentialRampToValueAtTime(880, t0 + 0.7);
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(400, t0);
    filter.frequency.exponentialRampToValueAtTime(3200, t0 + 0.7);
    filter.Q.value = 1.2;
    const ng = envelope(ctx, filter, t0, 0.5, 0.55, t0 + 0.8);
    void ng;
    filter.connect(g);
    noise(ctx, filter, t0, t0 + 0.75);
  },

  boom(ctx, out, t0) {
    const g = envelope(ctx, out, t0, 0.6, 0.008, t0 + 0.9);
    const o = osc(ctx, g, "sine", 130, t0, t0 + 0.9);
    o.frequency.exponentialRampToValueAtTime(38, t0 + 0.5);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 320;
    const ng = envelope(ctx, lp, t0, 0.5, 0.004, t0 + 0.3);
    void ng;
    lp.connect(g);
    noise(ctx, lp, t0, t0 + 0.3);
  },

  coin(ctx, out, t0) {
    const g = envelope(ctx, out, t0, 0.2, 0.004, t0 + 0.45);
    osc(ctx, g, "square", 987.8, t0, t0 + 0.08);
    osc(ctx, g, "square", 1318.5, t0 + 0.08, t0 + 0.45);
  },

  victory(ctx, out, t0) {
    const line: Array<[number, number, number]> = [
      [392, 0, 0.11],
      [523.3, 0.11, 0.11],
      [659.3, 0.22, 0.11],
      [784, 0.33, 0.16],
      [659.3, 0.49, 0.11],
      [784, 0.6, 0.42],
    ];
    for (const [f, at, dur] of line) {
      const g = envelope(ctx, out, t0 + at, 0.16, 0.006, t0 + at + dur + 0.05);
      osc(ctx, g, "square", f, t0 + at, t0 + at + dur);
      // Quiet lower octave fattens the fanfare without muddying it.
      osc(ctx, g, "triangle", f / 2, t0 + at, t0 + at + dur);
    }
  },

  airhorn(ctx, out, t0) {
    // Three detuned-saw stabs, then the long held blast that droops —
    // the unmistakable hype-horn contour, synthesized from scratch.
    const stab = (at: number, dur: number) => {
      const g = envelope(ctx, out, at, 0.22, 0.015, at + dur + 0.08);
      for (const cents of [-12, 0, 12]) {
        const o = osc(ctx, g, "sawtooth", 466.2, at, at + dur, cents);
        o.frequency.setValueAtTime(466.2, at);
        o.frequency.exponentialRampToValueAtTime(440, at + dur);
      }
    };
    stab(t0, 0.16);
    stab(t0 + 0.24, 0.16);
    stab(t0 + 0.48, 0.7);
  },

  "bass-drop"(ctx, out, t0) {
    const g = envelope(ctx, out, t0, 0.55, 0.03, t0 + 1.2);
    const o = osc(ctx, g, "sine", 160, t0, t0 + 1.2);
    o.frequency.exponentialRampToValueAtTime(30, t0 + 1.0);
    // Wobble the level at ~7 Hz for the dubstep "wub".
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 7;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.22;
    lfo.connect(lfoGain);
    lfoGain.connect(g.gain);
    lfo.start(t0 + 0.15);
    lfo.stop(t0 + 1.2);
  },

  "sad-trombone"(ctx, out, t0) {
    // Four descending semitone glides; the last droops and wobbles.
    const notes = [233.1, 220, 207.7];
    notes.forEach((f, i) => {
      const at = t0 + i * 0.28;
      const g = envelope(ctx, out, at, 0.22, 0.02, at + 0.3);
      const o = osc(ctx, g, "sawtooth", f, at, at + 0.26);
      o.frequency.linearRampToValueAtTime(f * 0.97, at + 0.24);
      osc(ctx, g, "triangle", f, at, at + 0.26);
    });
    const at = t0 + 0.84;
    const g = envelope(ctx, out, at, 0.24, 0.02, at + 0.95);
    const o = osc(ctx, g, "sawtooth", 196, at, at + 0.9);
    o.frequency.linearRampToValueAtTime(174.6, at + 0.7);
    osc(ctx, g, "triangle", 196, at, at + 0.9).frequency.linearRampToValueAtTime(
      174.6,
      at + 0.7,
    );
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 5.5;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.08;
    lfo.connect(lfoGain);
    lfoGain.connect(g.gain);
    lfo.start(at + 0.2);
    lfo.stop(at + 0.9);
  },

  boing(ctx, out, t0) {
    const g = envelope(ctx, out, t0, 0.3, 0.005, t0 + 0.5);
    const o = osc(ctx, g, "triangle", 320, t0, t0 + 0.5);
    o.frequency.exponentialRampToValueAtTime(90, t0 + 0.4);
    // Fast decaying vibrato = the spring rattle.
    const lfo = ctx.createOscillator();
    lfo.frequency.setValueAtTime(26, t0);
    lfo.frequency.exponentialRampToValueAtTime(8, t0 + 0.45);
    const lfoGain = ctx.createGain();
    lfoGain.gain.setValueAtTime(60, t0);
    lfoGain.gain.exponentialRampToValueAtTime(4, t0 + 0.45);
    lfo.connect(lfoGain);
    lfoGain.connect(o.frequency);
    lfo.start(t0);
    lfo.stop(t0 + 0.5);
  },

  "slide-whistle"(ctx, out, t0) {
    const g = envelope(ctx, out, t0, 0.22, 0.02, t0 + 0.6);
    const o = osc(ctx, g, "sine", 320, t0, t0 + 0.55);
    o.frequency.exponentialRampToValueAtTime(1250, t0 + 0.45);
    // Little vibrato once the slide tops out.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 9;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 30;
    lfo.connect(lfoGain);
    lfoGain.connect(o.frequency);
    lfo.start(t0 + 0.4);
    lfo.stop(t0 + 0.55);
  },

  drumroll(ctx, out, t0) {
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1800;
    bp.Q.value = 0.8;
    bp.connect(out);
    const hits = 26;
    for (let i = 0; i < hits; i += 1) {
      const at = t0 + i * 0.032;
      // Crescendo from whisper to full.
      const peak = 0.05 + (0.3 * i) / hits;
      const g = envelope(ctx, bp, at, peak, 0.002, at + 0.03);
      noise(ctx, g, at, at + 0.028);
    }
    // Crash finish — long bright noise decay.
    const crashAt = t0 + hits * 0.032;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 3000;
    hp.connect(out);
    const g = envelope(ctx, hp, crashAt, 0.35, 0.005, crashAt + 0.9);
    noise(ctx, g, crashAt, crashAt + 0.9);
  },
};

/** Longest effect duration — callers can close contexts after this. */
export const EFFECT_MAX_DURATION_MS = 2_000;

/**
 * Schedule effect ``id`` into ``ctx`` right now at ``volume`` (0–100).
 * Safe with any whitelisted id; unknown ids fall back to "ding".
 * Never throws — an audio-backend hiccup skips the sound.
 */
export function playEffect(
  ctx: AudioContext,
  id: SoundEffectId | string,
  volume: number,
): void {
  const recipe = RECIPES[isSoundEffectId(id) ? id : "ding"];
  try {
    const master = ctx.createGain();
    master.gain.value = Math.min(100, Math.max(0, volume)) / 100;
    master.connect(ctx.destination);
    recipe(ctx, master, ctx.currentTime);
  } catch {
    /* audio backend hiccup — skip this play */
  }
}
