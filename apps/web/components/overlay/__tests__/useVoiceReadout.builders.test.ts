import { describe, expect, it } from "vitest";
import {
  buildScoutingLine,
  buildMatchEndLine,
  buildCheeseLine,
  sanitizeForSpeech,
} from "../useVoiceReadout.builders";
import { normalizeRace } from "../useVoiceReadout.builders";
import type { LiveGamePayload } from "../types";

const base = (extra: Partial<LiveGamePayload> = {}): LiveGamePayload => ({
  oppName: "TestUser",
  oppRace: "Protoss",
  ...extra,
});

describe("buildScoutingLine", () => {
  it("speaks name + race when both present", () => {
    expect(buildScoutingLine(base())).toContain("Facing TestUser, Protoss.");
  });

  it("drops race gracefully when unknown", () => {
    expect(buildScoutingLine(base({ oppRace: "unknown" }))).toContain(
      "Facing TestUser.",
    );
  });

  it("normalises Random into 'random race'", () => {
    expect(buildScoutingLine(base({ oppRace: "Random" }))).toContain(
      "random race",
    );
  });

  it("falls back when no name and no race", () => {
    expect(buildScoutingLine({} as LiveGamePayload)).toContain(
      "Facing an unknown opponent.",
    );
  });

  it("includes head-to-head when wins/losses populated", () => {
    const out = buildScoutingLine(
      base({ headToHead: { wins: 3, losses: 1 } }),
    );
    expect(out).toContain("You're 3 and 1 against them.");
  });

  it("says 'first meeting' when H2H exists but is empty", () => {
    const out = buildScoutingLine(
      base({ headToHead: { wins: 0, losses: 0 } }),
    );
    expect(out).toContain("First meeting.");
  });

  it("omits H2H when totally absent", () => {
    const out = buildScoutingLine(base());
    expect(out).not.toContain("First meeting");
    expect(out).not.toMatch(/against them/);
  });

  it("guards against NaN/undefined wins/losses", () => {
    const broken = base({
      // @ts-expect-error — intentionally malformed
      headToHead: { wins: "x", losses: undefined },
    });
    const out = buildScoutingLine(broken);
    expect(out).not.toContain("NaN");
    expect(out).not.toContain("undefined");
  });

  it("includes bestAnswer with win-rate when set", () => {
    const out = buildScoutingLine(
      base({ bestAnswer: { build: "3 Stargate Phoenix", winRate: 0.62, total: 8 } }),
    );
    expect(out).toContain("Best answer is 3 Stargate Phoenix");
    expect(out).toContain("62 percent win rate");
  });

  it("drops the win-rate clause when zero", () => {
    const out = buildScoutingLine(
      base({ bestAnswer: { build: "Stargate", winRate: 0, total: 0 } }),
    );
    expect(out).toContain("Best answer is Stargate.");
    expect(out).not.toContain("0 percent");
  });

  it("truncates long build strings on a word boundary", () => {
    const longBuild = "Three base macro into stargate phoenix into archon drop midgame";
    const out = buildScoutingLine(
      base({ bestAnswer: { build: longBuild, winRate: 0.5, total: 4 } }),
    );
    // Truncation kicks in around 60 chars; the original string is longer
    // than that so it must NOT be in the output verbatim.
    expect(out).not.toContain(longBuild);
    expect(out).toContain("Best answer is");
    // No mid-word truncation: every word in the spoken build should be
    // fully present in the original.
    const clause = out.split("Best answer is ")[1] ?? "";
    const spoken = clause.split(",")[0]?.replace(/\.$/, "") || "";
    for (const word of spoken.split(/\s+/).filter(Boolean)) {
      expect(longBuild).toContain(word);
    }
  });

  it("phrases cheese as 'high cheese risk' when ≥0.7", () => {
    const out = buildScoutingLine(base({ cheeseProbability: 0.85 }));
    expect(out.toLowerCase()).toContain("high cheese risk");
  });

  it("phrases cheese as 'possible cheese' when ≥0.4 and <0.7", () => {
    const out = buildScoutingLine(base({ cheeseProbability: 0.5 }));
    expect(out.toLowerCase()).toContain("possible cheese");
  });

  it("omits cheese phrasing under threshold", () => {
    const out = buildScoutingLine(base({ cheeseProbability: 0.1 }));
    expect(out.toLowerCase()).not.toContain("cheese");
  });

  it("omits cheese phrasing when cheeseProbability is null/NaN", () => {
    // @ts-expect-error — exercising malformed payload
    const out = buildScoutingLine(base({ cheeseProbability: null }));
    expect(out.toLowerCase()).not.toContain("cheese");
  });
});

describe("buildMatchEndLine", () => {
  it("speaks Victory + MMR delta on a win", () => {
    const out = buildMatchEndLine({ result: "win", mmrDelta: 22 } as LiveGamePayload);
    expect(out).toContain("Victory.");
    expect(out).toContain("plus 22 MMR.");
  });

  it("speaks Defeat with negative delta", () => {
    const out = buildMatchEndLine({
      result: "loss",
      mmrDelta: -18,
    } as LiveGamePayload);
    expect(out).toContain("Defeat.");
    expect(out).toContain("minus 18 MMR.");
  });

  it("omits MMR clause when delta is zero/missing", () => {
    expect(buildMatchEndLine({ result: "win" } as LiveGamePayload)).toBe(
      "Victory.",
    );
  });
});

describe("buildCheeseLine", () => {
  it("escalates phrasing past 0.7", () => {
    expect(
      buildCheeseLine({ cheeseProbability: 0.8 } as LiveGamePayload),
    ).toBe("High cheese risk.");
  });
  it("falls back to a generic warning between 0.4 and 0.7", () => {
    expect(
      buildCheeseLine({ cheeseProbability: 0.5 } as LiveGamePayload),
    ).toBe("Cheese warning.");
  });
});

describe("sanitizeForSpeech", () => {
  it("returns empty for null/undefined", () => {
    expect(sanitizeForSpeech(null)).toBe("");
    expect(sanitizeForSpeech(undefined)).toBe("");
  });

  it("strips emojis", () => {
    expect(sanitizeForSpeech("Hello 🎉 world")).toBe("Hello world");
  });

  it("flattens markdown link [text](url) to just text", () => {
    expect(sanitizeForSpeech("see [docs](https://x)")).toBe("see docs");
  });

  it("removes inline markdown markers", () => {
    expect(sanitizeForSpeech("**bold** _emph_ `code`")).toBe("bold emph code");
  });

  it("collapses whitespace", () => {
    expect(sanitizeForSpeech("  a   \n b  ")).toBe("a b");
  });
});

describe("normalizeRace", () => {
  it("returns the canonical race for full-word inputs (case-insensitive)", () => {
    expect(normalizeRace("Terran")).toBe("Terran");
    expect(normalizeRace("terran")).toBe("Terran");
    expect(normalizeRace("TERRAN")).toBe("Terran");
    expect(normalizeRace("Zerg")).toBe("Zerg");
    expect(normalizeRace("Protoss")).toBe("Protoss");
  });

  it("accepts single-letter agent variants (T/Z/P/R)", () => {
    // The agent occasionally emits the single-letter form when the
    // SC2 client's locale doesn't surface the full race string. The
    // voice readout needs the canonical word; without this mapping
    // the race clause would be silently dropped and the streamer
    // would hear "Facing <Name>." instead of "Facing <Name>, Terran."
    expect(normalizeRace("T")).toBe("Terran");
    expect(normalizeRace("t")).toBe("Terran");
    expect(normalizeRace("Z")).toBe("Zerg");
    expect(normalizeRace("z")).toBe("Zerg");
    expect(normalizeRace("P")).toBe("Protoss");
    expect(normalizeRace("p")).toBe("Protoss");
    expect(normalizeRace("R")).toBe("random race");
    expect(normalizeRace("r")).toBe("random race");
  });

  it("maps Random to 'random race'", () => {
    expect(normalizeRace("Random")).toBe("random race");
    expect(normalizeRace("random")).toBe("random race");
  });

  it("returns the empty string for unknown / missing inputs", () => {
    expect(normalizeRace("")).toBe("");
    expect(normalizeRace(undefined)).toBe("");
    expect(normalizeRace(null)).toBe("");
    expect(normalizeRace("unknown")).toBe("");
    expect(normalizeRace("???")).toBe("");
  });
});
