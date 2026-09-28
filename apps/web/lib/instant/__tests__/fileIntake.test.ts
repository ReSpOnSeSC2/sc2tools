import { describe, expect, it } from "vitest";
import {
  COLD_BOOT_SECONDS,
  MAX_TRY_FILES,
  MTIME_SLACK_MS,
  PER_FILE_PARSE_SECONDS,
  REPLAY_INPUT_ACCEPT,
  dateWindowLabel,
  detectPlatform,
  estimateParseSeconds,
  intakeKey,
  isInDateWindow,
  isReplayFileName,
  isZipFileName,
  makeIntakeFile,
  osPathHints,
  preFilterByDate,
  replayInputAccept,
} from "../fileIntake";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-27T12:00:00Z");

const UA_WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0";
const UA_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1";
const UA_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15";
const UA_ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128.0 Mobile";

describe("file name checks", () => {
  it("accepts .SC2Replay and .zip in any case", () => {
    expect(isReplayFileName("a.SC2Replay")).toBe(true);
    expect(isReplayFileName("a.sc2replay")).toBe(true);
    expect(isReplayFileName("a.SC2Replay.txt")).toBe(false);
    expect(isZipFileName("pack.ZIP")).toBe(true);
    expect(isZipFileName("pack.zip.bak")).toBe(false);
  });
});

describe("makeIntakeFile", () => {
  it("uses webkitRelativePath when present and builds a stable key", () => {
    const file = new File(["abc"], "a.SC2Replay", { lastModified: 1000 });
    Object.defineProperty(file, "webkitRelativePath", { value: "Multiplayer/a.SC2Replay" });
    const intake = makeIntakeFile(file, "folder");
    expect(intake.relativePath).toBe("Multiplayer/a.SC2Replay");
    expect(intake.key).toBe(intakeKey("Multiplayer/a.SC2Replay", 3, 1000));
    expect(intake.key).toBe("3:1000:Multiplayer/a.SC2Replay");
    expect(intake.blob).toBe(file);
    expect(intake.source).toBe("folder");
  });

  it("prefers an explicit relative path and normalises backslashes", () => {
    const file = new File(["x"], "b.SC2Replay", { lastModified: 5 });
    expect(makeIntakeFile(file, "folder", "1-S2-1-5\\Replays\\b.SC2Replay").relativePath).toBe(
      "1-S2-1-5/Replays/b.SC2Replay",
    );
  });

  it("falls back to the file name", () => {
    const file = new File(["x"], "c.SC2Replay");
    expect(makeIntakeFile(file, "drop").relativePath).toBe("c.SC2Replay");
  });
});

describe("replayInputAccept", () => {
  it("is permissive on iPhone and iPadOS (desktop UA + touch)", () => {
    expect(replayInputAccept(UA_IPHONE)).toBeUndefined();
    expect(replayInputAccept(UA_MAC, 5)).toBeUndefined();
  });

  it("filters by extension on desktop", () => {
    expect(replayInputAccept(UA_WINDOWS)).toBe(REPLAY_INPUT_ACCEPT);
    expect(replayInputAccept(UA_MAC, 0)).toBe(".SC2Replay,.zip");
  });
});

describe("date window", () => {
  const file = (daysAgo: number) => ({ lastModified: NOW - daysAgo * DAY, id: daysAgo });

  it("keeps everything for the all-time window", () => {
    const files = [file(1), file(900)];
    expect(preFilterByDate(files, { kind: "all" }, NOW)).toEqual(files);
  });

  it("pre-filters on lastModified with the agent's 7-day slack", () => {
    const kept = preFilterByDate([file(10), file(96), file(98)], { kind: "days90" }, NOW);
    expect(kept.map((f) => f.id)).toEqual([10, 96]);
    expect(MTIME_SLACK_MS).toBe(7 * DAY);
  });

  it("keeps files with unusable timestamps", () => {
    const kept = preFilterByDate([{ lastModified: 0 }, { lastModified: Number.NaN }], { kind: "days90" }, NOW);
    expect(kept).toHaveLength(2);
  });

  it("checks the real replay date without slack; missing date is included", () => {
    const window = { kind: "days90" } as const;
    expect(isInDateWindow(new Date(NOW - 89 * DAY).toISOString(), window, NOW)).toBe(true);
    expect(isInDateWindow(new Date(NOW - 91 * DAY).toISOString(), window, NOW)).toBe(false);
    expect(isInDateWindow(null, window, NOW)).toBe(true);
    expect(isInDateWindow("not a date", window, NOW)).toBe(true);
    expect(isInDateWindow("2001-01-01T00:00:00Z", { kind: "all" }, NOW)).toBe(true);
  });

  it("labels windows", () => {
    expect(dateWindowLabel({ kind: "days90" })).toBe("Last 90 days");
    expect(dateWindowLabel({ kind: "all" })).toBe("All time");
  });
});

describe("estimateParseSeconds", () => {
  it("adds the cold boot only when the engine is not warm", () => {
    expect(estimateParseSeconds(10, { warm: false }).seconds).toBe(
      Math.ceil(COLD_BOOT_SECONDS + 10 * PER_FILE_PARSE_SECONDS),
    );
    expect(estimateParseSeconds(10, { warm: true }).seconds).toBe(15);
  });

  it("labels in seconds, then minutes", () => {
    expect(estimateParseSeconds(MAX_TRY_FILES, { warm: false }).label).toBe("about 44 seconds");
    expect(estimateParseSeconds(200, { warm: false }).label).toBe("about 5 minutes");
    expect(estimateParseSeconds(0, { warm: true })).toEqual({ seconds: 0, label: "about 0 seconds" });
  });
});

describe("platform hints", () => {
  it("detects platforms from the user agent", () => {
    expect(detectPlatform(UA_WINDOWS)).toBe("windows");
    expect(detectPlatform(UA_MAC)).toBe("macos");
    expect(detectPlatform(UA_MAC, 5)).toBe("ios");
    expect(detectPlatform(UA_IPHONE)).toBe("ios");
    expect(detectPlatform(UA_ANDROID)).toBe("android");
    expect(detectPlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux");
    expect(detectPlatform("curl/8")).toBe("other");
  });

  it("gives the Accounts folder per OS", () => {
    expect(osPathHints("windows")).toEqual([
      { platform: "windows", label: "Windows", path: "Documents\\StarCraft II\\Accounts" },
    ]);
    expect(osPathHints("macos")[0].path).toBe(
      "~/Library/Application Support/Blizzard/StarCraft II/Accounts",
    );
    expect(osPathHints("ios").map((hint) => hint.platform)).toEqual(["windows", "macos"]);
  });
});
