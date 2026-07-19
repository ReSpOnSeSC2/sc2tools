/**
 * Bundled sound pack + unified sound namespace. Pins three contracts:
 *
 *   1. Pack metadata ↔ the actual MP3 files on disk (an id without a
 *      file would 404 in OBS; a file without an id is dead weight).
 *   2. Id uniqueness across ALL sound families (synth, pack, custom
 *      namespace) — the pickers and sanitizers assume it.
 *   3. resolveSound routes every id family to the right player input.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { PACK_SOUNDS, PACK_SOUND_IDS, isPackSoundId, packSoundUrl } from "@/lib/multichat/soundPack";
import { SOUND_EFFECT_IDS } from "@/lib/multichat/soundEffects";
import {
  CUSTOM_ID_RE,
  DEFAULT_SOUND,
  resolveSound,
  sanitizeSoundConfig,
} from "@/lib/multichat/sound";

const SOUNDS_DIR = path.join(process.cwd(), "public", "sounds", "multichat");

describe("bundled sound pack", () => {
  test("every pack id has a real MP3 on disk, and vice versa", () => {
    const files = fs
      .readdirSync(SOUNDS_DIR)
      .filter((f) => f.endsWith(".mp3"))
      .map((f) => f.replace(/\.mp3$/, ""))
      .sort();
    expect(files).toEqual([...PACK_SOUND_IDS].sort());
    for (const id of PACK_SOUND_IDS) {
      const stat = fs.statSync(path.join(SOUNDS_DIR, `${id}.mp3`));
      expect(stat.size).toBeGreaterThan(1000);
      expect(stat.size).toBeLessThan(120 * 1024);
    }
  });

  test("provenance doc ships next to the files", () => {
    const credits = fs.readFileSync(path.join(SOUNDS_DIR, "CREDITS.md"), "utf8");
    for (const id of PACK_SOUND_IDS) {
      expect(credits).toContain(`${id}.mp3`);
    }
    expect(credits).toContain("CC BY 3.0");
    expect(credits).toContain("Mixkit");
  });

  test("ids are unique across synth + pack, and none look custom", () => {
    const all = [...SOUND_EFFECT_IDS, ...PACK_SOUND_IDS];
    expect(new Set(all).size).toBe(all.length);
    for (const id of all) expect(CUSTOM_ID_RE.test(id)).toBe(false);
  });

  test("meta is complete", () => {
    for (const s of PACK_SOUNDS) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.durationMs).toBeGreaterThan(100);
      expect(["memes", "crowd", "gags", "hype", "impact"]).toContain(s.category);
    }
    expect(isPackSoundId("real-airhorn")).toBe(true);
    expect(isPackSoundId("ding")).toBe(false);
  });
});

describe("custom sounds sanitize", () => {
  test("url / tts / upload entries round-trip; junk drops", () => {
    const out = sanitizeSoundConfig({
      customSounds: [
        { id: "c-boom1", label: "My boom", kind: "url", url: "https://x.example/boom.mp3" },
        { id: "c-line", label: "Hype line", kind: "tts", text: "LETS GO", voiceName: "V", rate: 9 },
        { id: "c-upl", label: "Upl", kind: "upload", uploadId: "abcdef12-3456" },
        { id: "bad id", label: "x", kind: "url", url: "https://x/a.mp3" },
        { id: "c-http", label: "x", kind: "url", url: "http://insecure/a.mp3" },
        { id: "c-empty-tts", label: "x", kind: "tts", text: "  " },
        { id: "c-boom1", label: "dupe", kind: "url", url: "https://x.example/b.mp3" },
      ],
    });
    expect(out.customSounds.map((c) => c.id)).toEqual(["c-boom1", "c-line", "c-upl"]);
    expect(out.customSounds[1]).toMatchObject({ text: "LETS GO", rate: 2 });
  });

  test("custom ids are pickable for message + event sounds", () => {
    const out = sanitizeSoundConfig({
      messageSound: "c-boom1",
      eventSounds: { raid: "metal-pipe", sub: "c-boom1" },
      customSounds: [
        { id: "c-boom1", label: "My boom", kind: "url", url: "https://x.example/boom.mp3" },
      ],
    });
    expect(out.messageSound).toBe("c-boom1");
    expect(out.eventSounds.raid).toBe("metal-pipe");
    expect(out.eventSounds.sub).toBe("c-boom1");
  });

  test("unknown custom reference falls back", () => {
    const out = sanitizeSoundConfig({ messageSound: "c-ghost" });
    expect(out.messageSound).toBe("ding");
  });
});

describe("resolveSound", () => {
  test("routes each family to the right player input", () => {
    const config = sanitizeSoundConfig({
      customSounds: [
        { id: "c-u", label: "U", kind: "url", url: "https://x.example/u.mp3" },
        { id: "c-p", label: "P", kind: "upload", url: "/v1/multichat/tok/sound/abc12345" },
        { id: "c-t", label: "T", kind: "tts", text: "hello", voiceName: "", rate: 1 },
      ],
    });
    expect(resolveSound("ding", config)).toEqual({ type: "synth", id: "ding" });
    expect(resolveSound("real-airhorn", config)).toEqual({
      type: "file",
      url: "/sounds/multichat/real-airhorn.mp3",
    });
    expect(resolveSound("c-u", config)).toEqual({ type: "file", url: "https://x.example/u.mp3" });
    expect(resolveSound("c-p", config, "https://api.example")).toEqual({
      type: "file",
      url: "https://api.example/v1/multichat/tok/sound/abc12345",
    });
    expect(resolveSound("c-t", config)).toEqual({
      type: "tts",
      text: "hello",
      voiceName: "",
      rate: 1,
    });
    expect(resolveSound("none", config)).toBeNull();
    expect(resolveSound("c-missing", DEFAULT_SOUND)).toBeNull();
  });

  test("upload entry without a served url is unplayable (prefs-side)", () => {
    const config = sanitizeSoundConfig({
      customSounds: [{ id: "c-x", label: "X", kind: "upload", uploadId: "abcdef12-3456" }],
    });
    expect(resolveSound("c-x", config)).toBeNull();
    expect(packSoundUrl("cha-ching")).toBe("/sounds/multichat/cha-ching.mp3");
  });
});
