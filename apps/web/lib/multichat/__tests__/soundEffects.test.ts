/**
 * Sound-effect library + extended sound config. Two contracts pinned:
 *
 *   1. Every whitelisted effect id has a synthesis recipe that
 *      schedules real WebAudio nodes without throwing (run against a
 *      stub AudioContext — jsdom has none).
 *   2. sanitizeSoundConfig round-trips the new fields (messageSound,
 *      event sounds) and drops junk to defaults — the API mirror
 *      (services/multichatAppearance sanitizeChatSound) pins the same
 *      shape from the server side.
 */

import { describe, expect, test, vi } from "vitest";
import {
  SOUND_EFFECTS,
  SOUND_EFFECT_IDS,
  isSoundEffectId,
  playEffect,
} from "@/lib/multichat/soundEffects";
import {
  DEFAULT_EVENT_SOUNDS,
  DEFAULT_SOUND,
  createEventSounder,
  sanitizeSoundConfig,
} from "@/lib/multichat/sound";
import { CHAT_EVENT_KINDS } from "@/lib/multichat/events";

/** Minimal AudioContext stand-in that records scheduling calls. */
function stubContext() {
  const param = () => ({
    value: 0,
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  });
  const node = () => ({
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    frequency: param(),
    detune: param(),
    gain: param(),
    Q: param(),
    type: "sine",
    buffer: null,
    loop: false,
  });
  const started: unknown[] = [];
  const ctx = {
    currentTime: 0,
    sampleRate: 48000,
    state: "running",
    destination: {},
    createGain: vi.fn(() => node()),
    createOscillator: vi.fn(() => {
      const n = node();
      started.push(n);
      return n;
    }),
    createBiquadFilter: vi.fn(() => node()),
    createBuffer: vi.fn((_ch: number, length: number) => ({
      getChannelData: () => new Float32Array(length),
    })),
    createBufferSource: vi.fn(() => {
      const n = node();
      started.push(n);
      return n;
    }),
  };
  return { ctx: ctx as unknown as AudioContext, started, raw: ctx };
}

describe("sound effect library", () => {
  test("ids are unique and meta is complete", () => {
    expect(new Set(SOUND_EFFECT_IDS).size).toBe(SOUND_EFFECT_IDS.length);
    for (const e of SOUND_EFFECTS) {
      expect(e.label.length).toBeGreaterThan(0);
      expect(e.description.length).toBeGreaterThan(0);
      expect(["classic", "cool", "arcade", "funny"]).toContain(e.category);
    }
  });

  test.each(SOUND_EFFECT_IDS.map((id) => [id]))(
    "%s schedules audio without throwing",
    (id) => {
      const { ctx, started } = stubContext();
      playEffect(ctx, id, 80);
      // Every recipe must actually make noise: at least one source
      // node started.
      expect(started.length).toBeGreaterThan(0);
    },
  );

  test("unknown id falls back to the ding instead of silence", () => {
    const { ctx, started } = stubContext();
    playEffect(ctx, "totally-fake", 80);
    expect(started.length).toBeGreaterThan(0);
  });

  test("isSoundEffectId narrows correctly", () => {
    expect(isSoundEffectId("airhorn")).toBe(true);
    expect(isSoundEffectId("none")).toBe(false);
    expect(isSoundEffectId(42)).toBe(false);
  });
});

describe("sanitizeSoundConfig — effect fields", () => {
  test("defaults include a full per-kind event map", () => {
    expect(DEFAULT_SOUND.messageSound).toBe("ding");
    expect(Object.keys(DEFAULT_SOUND.eventSounds).sort()).toEqual(
      [...CHAT_EVENT_KINDS].sort(),
    );
  });

  test("valid ids round-trip; junk falls back per-kind", () => {
    const out = sanitizeSoundConfig({
      messageSound: "coin",
      eventSoundsEnabled: true,
      eventVolume: 900,
      eventSounds: { raid: "bass-drop", sub: "none", follow: "not-real" },
    });
    expect(out.messageSound).toBe("coin");
    expect(out.eventSoundsEnabled).toBe(true);
    expect(out.eventVolume).toBe(100);
    expect(out.eventSounds.raid).toBe("bass-drop");
    expect(out.eventSounds.sub).toBe("none");
    expect(out.eventSounds.follow).toBe(DEFAULT_EVENT_SOUNDS.follow);
    // Kinds absent from the input still materialize with defaults.
    expect(out.eventSounds.giftsub).toBe(DEFAULT_EVENT_SOUNDS.giftsub);
  });

  test("unknown messageSound falls back to ding", () => {
    expect(sanitizeSoundConfig({ messageSound: "vuvuzela" }).messageSound).toBe(
      "ding",
    );
  });
});

describe("createEventSounder", () => {
  test('skips "none" kinds and respects the throttle', () => {
    const { raw } = stubContext();
    vi.stubGlobal(
      "AudioContext",
      vi.fn(() => raw),
    );
    try {
      const sounder = createEventSounder({
        ...DEFAULT_SOUND,
        eventSoundsEnabled: true,
        eventSounds: { ...DEFAULT_SOUND.eventSounds, raid: "none" },
      });
      sounder.play("raid");
      expect(raw.createOscillator).not.toHaveBeenCalled();
      sounder.play("sub"); // victory — plays
      const after = raw.createOscillator.mock.calls.length;
      expect(after).toBeGreaterThan(0);
      sounder.play("sub"); // inside the min gap — throttled
      expect(raw.createOscillator.mock.calls.length).toBe(after);
      sounder.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
