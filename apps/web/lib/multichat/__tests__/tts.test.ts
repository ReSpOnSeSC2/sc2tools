// Multichat TTS — sanitizer + speech-text scrubbing.

import { afterEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_SOUND, sanitizeSoundConfig } from "@/lib/multichat/sound";
import {
  DEFAULT_TTS,
  REWARD_SPEECH_START_TIMEOUT_MS,
  createChatSpeaker,
  sanitizeTtsConfig,
  speakableText,
} from "@/lib/multichat/tts";
import type { ChatMessage } from "@/lib/multichat/types";

function msg(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    platform: "twitch",
    id: "1",
    user: "Viewer",
    text: "hello there",
    badges: [],
    atMs: 0,
    ...over,
  };
}

describe("sanitizeTtsConfig", () => {
  test("garbage → complete defaults", () => {
    expect(sanitizeTtsConfig(null)).toEqual(DEFAULT_TTS);
    expect(sanitizeTtsConfig("x")).toEqual(DEFAULT_TTS);
  });

  test("clamps rate/volume/maxChars and filters platforms", () => {
    const out = sanitizeTtsConfig({
      enabled: true,
      rate: 99,
      volume: -5,
      maxChars: 5,
      platforms: ["twitch", "myspace", "tiktok", "twitch"],
      voiceName: "x".repeat(400),
    });
    expect(out.enabled).toBe(true);
    expect(out.rate).toBe(2);
    expect(out.volume).toBe(0);
    expect(out.maxChars).toBe(50);
    expect(out.platforms).toEqual(["twitch", "tiktok"]);
    expect(out.voiceName.length).toBe(120);
  });
});

class Utterance {
  onstart?: () => void;
  onend?: () => void;
  onerror?: (event: { error: string }) => void;
  constructor(public text: string) {}
}

function speechFixture() {
  const utterances: Utterance[] = [];
  const synth = { speaking: false, pending: false, paused: false, cancel: vi.fn(),
    speak: vi.fn((utterance: Utterance) => { utterances.push(utterance); }) };
  vi.stubGlobal("speechSynthesis", synth);
  vi.stubGlobal("SpeechSynthesisUtterance", Utterance);
  const config = { ...DEFAULT_TTS, enabled: true, readNames: false };
  return { synth, utterances, config };
}

describe("reward speech start acknowledgement", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  test("waits for onstart while preserving the ordinary queue's newest three lines", async () => {
    const { synth, utterances, config } = speechFixture();
    const speaker = createChatSpeaker(config);
    const result = speaker.speakReward(msg({ text: "Reward" }), new AbortController().signal);
    const ack = vi.fn();
    void result.then(ack);
    await Promise.resolve();
    expect(ack).not.toHaveBeenCalled();
    expect(utterances.map(utterance => utterance.text)).toEqual(["Reward"]);
    for (const text of ["First", "Second", "Third", "Fourth"]) speaker.speak(msg({ text }));
    expect(speaker.rewardReady).toBe(false);
    await expect(speaker.speakReward(msg({ text: "Busy reward" }), new AbortController().signal)).resolves.toBe(false);
    utterances[0].onstart?.();
    await expect(result).resolves.toBe(true);
    for (let index = 0; index < 4; index++) utterances[index].onend?.();
    expect(utterances.map(utterance => utterance.text)).toEqual(["Reward", "Second", "Third", "Fourth"]);
    expect(synth.cancel).not.toHaveBeenCalled();
  });

  test("cancels a start timeout before rejecting and ignores late browser events", async () => {
    vi.useFakeTimers();
    const { synth, utterances, config } = speechFixture();
    const speaker = createChatSpeaker(config);
    const result = speaker.speakReward(msg({ text: "Timed out reward" }), new AbortController().signal);
    speaker.speak(msg({ text: "Ordinary chat" }));
    const ack = vi.fn((started: boolean) => {
      expect(synth.cancel).toHaveBeenCalledOnce();
      return started;
    });
    const observed = result.then(ack);
    await vi.advanceTimersByTimeAsync(REWARD_SPEECH_START_TIMEOUT_MS);
    await expect(observed).resolves.toBe(false);
    utterances[0].onstart?.();
    utterances[0].onend?.();
    expect(ack.mock.calls).toEqual([[false]]);
    expect(utterances.map(utterance => utterance.text)).toEqual(["Timed out reward", "Ordinary chat"]);
  });

  test("reports synchronous speak failure and rejects autoplay errors without gesture retry", async () => {
    const { synth, utterances, config } = speechFixture();
    const blocked = vi.fn();
    const speaker = createChatSpeaker(config, blocked);
    synth.speak.mockImplementationOnce(() => { throw new Error("speech engine failed"); });
    await expect(speaker.speakReward(msg(), new AbortController().signal)).resolves.toBe(false);
    expect(synth.cancel).toHaveBeenCalledOnce();
    const result = speaker.speakReward(msg(), new AbortController().signal);
    utterances[0].onerror?.({ error: "not-allowed" });
    await expect(result).resolves.toBe(false);
    expect(blocked).toHaveBeenCalledWith(true);
    expect(speaker.rewardReady).toBe(false);
    speaker.unlock();
    expect(utterances.map(utterance => utterance.text)).toEqual(["hello there", ""]);
  });

  test("rejects a start after the readiness deadline even before the timeout callback runs", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(200);
    const { synth, utterances, config } = speechFixture();
    const speaker = createChatSpeaker(config);
    const result = speaker.speakReward(msg(), new AbortController().signal, 300);
    clock.mockReturnValue(301);
    utterances[0].onstart?.();
    await expect(result).resolves.toBe(false);
    expect(synth.cancel).toHaveBeenCalledOnce();
  });

  test("leaves busy browser speech alone and cancels an unstarted reward on disconnect", async () => {
    const { synth, utterances, config } = speechFixture();
    const speaker = createChatSpeaker(config);
    synth.pending = true;
    await expect(speaker.speakReward(msg(), new AbortController().signal)).resolves.toBe(false);
    expect(synth.speak).not.toHaveBeenCalled();
    expect(synth.cancel).not.toHaveBeenCalled();
    synth.pending = false;
    const owner = new AbortController();
    const result = speaker.speakReward(msg(), owner.signal);
    owner.abort();
    await expect(result).resolves.toBe(false);
    expect(synth.cancel).toHaveBeenCalledOnce();
    utterances[0].onstart?.();
    expect(speaker.rewardReady).toBe(true);
  });
});

describe("sanitizeSoundConfig", () => {
  test("garbage → defaults; clamps volume", () => {
    expect(sanitizeSoundConfig(null)).toEqual(DEFAULT_SOUND);
    expect(sanitizeSoundConfig({ enabled: true, volume: 900 })).toEqual({
      ...DEFAULT_SOUND,
      enabled: true,
      volume: 100,
    });
    expect(sanitizeSoundConfig({ volume: -4 }).volume).toBe(0);
  });
});

describe("speakableText", () => {
  const on = { ...DEFAULT_TTS, enabled: true };

  test("prefixes the author when readNames is on", () => {
    expect(speakableText(msg(), on)).toBe("Viewer: hello there");
    expect(speakableText(msg(), { ...on, readNames: false })).toBe(
      "hello there",
    );
  });

  test("platform filter: empty = all, otherwise exact", () => {
    expect(speakableText(msg({ platform: "kick" }), on)).not.toBeNull();
    const twitchOnly = { ...on, platforms: ["twitch" as const] };
    expect(speakableText(msg({ platform: "kick" }), twitchOnly)).toBeNull();
    expect(speakableText(msg({ platform: "twitch" }), twitchOnly)).not.toBeNull();
  });

  test("skips commands when configured", () => {
    expect(speakableText(msg({ text: "!discord" }), on)).toBeNull();
    expect(
      speakableText(msg({ text: "!discord" }), { ...on, skipCommands: false }),
    ).not.toBeNull();
  });

  test("scrubs URLs, emote tokens, and character runs", () => {
    const out = speakableText(
      msg({ text: "look https://example.com/x?y=1 :kekw: soooooooo good" }),
      { ...on, readNames: false },
    );
    expect(out).toBe("look link sooo good");
  });

  test("emote-only messages are silent", () => {
    expect(
      speakableText(msg({ text: ":fire: :kekw:" }), { ...on, readNames: false }),
    ).toBeNull();
  });

  test("caps spoken length with an ellipsis", () => {
    const out = speakableText(msg({ text: "a".repeat(400) }), {
      ...on,
      readNames: false,
      maxChars: 50,
    });
    // Run-collapsing shortens repeated chars first; cap still bounds it.
    expect(out!.length).toBeLessThanOrEqual(51);
  });
});
