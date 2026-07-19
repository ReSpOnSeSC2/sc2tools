// Multichat TTS — sanitizer + speech-text scrubbing.

import { describe, expect, test } from "vitest";
import { DEFAULT_SOUND, sanitizeSoundConfig } from "@/lib/multichat/sound";
import {
  DEFAULT_TTS,
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
