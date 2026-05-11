import { describe, expect, it } from "vitest";
import {
  buildScoutingLine,
  buildMatchEndLine,
  buildCheeseLine,
  buildLiveGameScoutingLine,
  sanitizeForSpeech,
} from "../useVoiceReadout.builders";
import { normalizeRace } from "../useVoiceReadout.builders";
import type { LiveGameEnvelope, LiveGamePayload } from "../types";

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

  it("includes head-to-head with win-% when wins/losses populated", () => {
    // Mirrors the live builder's phrasing exactly so a Settings → Overlay
    // → Test click plays the same sentence as a real match-start readout.
    const out = buildScoutingLine(
      base({ headToHead: { wins: 3, losses: 1 } }),
    );
    expect(out).toContain("You're 3 and 1 against them, 75 percent win rate.");
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

  it("speaks the opponent's MMR when oppMmr is set", () => {
    const out = buildScoutingLine(base({ oppMmr: 4250 }));
    expect(out).toContain("4250 MMR.");
  });

  it("omits the MMR clause cleanly when oppMmr is 0 or missing", () => {
    // Never say "0 MMR" or "unknown MMR" — drop the slot silently.
    expect(buildScoutingLine(base({ oppMmr: 0 }))).not.toMatch(/MMR/);
    expect(buildScoutingLine(base())).not.toMatch(/MMR/);
  });

  it("always ends with 'Good luck.'", () => {
    expect(buildScoutingLine(base()).trim().endsWith("Good luck.")).toBe(true);
    expect(
      buildScoutingLine(base({ headToHead: { wins: 5, losses: 2 } }))
        .trim()
        .endsWith("Good luck."),
    ).toBe(true);
  });

  it("produces the full spec sentence end-to-end", () => {
    // Same shape as the live readout: name, race, MMR, H2H with win-%,
    // and "Good luck." The Settings → Overlay → Test path uses this
    // builder, so the test fire stays in lockstep with what streamers
    // actually hear in OBS at match start.
    const out = buildScoutingLine(
      base({
        oppName: "Maru",
        oppRace: "Terran",
        oppMmr: 6720,
        headToHead: { wins: 3, losses: 1 },
      }),
    );
    expect(out).toContain("Facing Maru, Terran.");
    expect(out).toContain("6720 MMR.");
    expect(out).toContain("You're 3 and 1 against them, 75 percent win rate.");
    expect(out.trim().endsWith("Good luck.")).toBe(true);
  });

  it("no longer speaks the best-answer or cheese clauses", () => {
    // Those clauses stay on the visual scouting card. Keeping the
    // voice line concise matches the streamer-stated spec and the
    // live-envelope readout.
    const out = buildScoutingLine(
      base({
        bestAnswer: { build: "3 Stargate Phoenix", winRate: 0.62, total: 8 },
        cheeseProbability: 0.85,
      }),
    );
    expect(out.toLowerCase()).not.toContain("best answer");
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

describe("buildLiveGameScoutingLine", () => {
  const envBase = (
    extra: Partial<LiveGameEnvelope> = {},
  ): LiveGameEnvelope => ({
    type: "liveGameState",
    phase: "match_loading",
    capturedAt: 0,
    ...extra,
  });

  it("speaks name + race + Good luck when both are set", () => {
    const out = buildLiveGameScoutingLine(
      envBase({ opponent: { name: "Serral", race: "Zerg" } }),
    );
    expect(out).toContain("Facing Serral, Zerg.");
    expect(out).toContain("Good luck.");
  });

  it("appends MMR when the bridge's profile carries it", () => {
    expect(
      buildLiveGameScoutingLine(
        envBase({
          opponent: { name: "Serral", race: "Zerg", profile: { mmr: 7100 } },
        }),
      ),
    ).toContain("7100 MMR.");
  });

  it("falls back to 'unknown opponent' when neither name nor race is set", () => {
    expect(buildLiveGameScoutingLine(envBase())).toContain(
      "Facing an unknown opponent.",
    );
  });

  it("normalises single-letter race variants from the agent", () => {
    // Agent occasionally emits ``T`` / ``Z`` / ``P`` / ``R`` rather
    // than the full race word; the readout must map to the canonical
    // form so the streamer hears "Facing Maru, Terran." not "Facing
    // Maru." with the race silently dropped.
    expect(
      buildLiveGameScoutingLine(
        envBase({ opponent: { name: "Maru", race: "T" } }),
      ),
    ).toContain("Facing Maru, Terran.");
    expect(
      buildLiveGameScoutingLine(
        envBase({ opponent: { name: "Serral", race: "z" } }),
      ),
    ).toContain("Facing Serral, Zerg.");
    expect(
      buildLiveGameScoutingLine(
        envBase({ opponent: { name: "Stats", race: "P" } }),
      ),
    ).toContain("Facing Stats, Protoss.");
  });

  it("announces head-to-head record and win percentage when streamerHistory carries them", () => {
    // Mirrors the THEBLOB-style case: pre-game card has the cloud's
    // enrichment attached. The voice line must include the record
    // (the agent's match-loading utterance previously read only the
    // name) and the win % the streamer asked for at match start.
    const out = buildLiveGameScoutingLine(
      envBase({
        opponent: { name: "THEBLOB", race: "Protoss" },
        streamerHistory: {
          oppName: "THEBLOB",
          oppRace: "Protoss",
          matchup: "PvP",
          headToHead: { wins: 3, losses: 1 },
        },
      }),
    );
    expect(out).toContain("Facing THEBLOB, Protoss.");
    // 3 + 1 = 4; 3/4 = 75% win rate.
    expect(out).toContain("You're 3 and 1 against them, 75 percent win rate.");
    expect(out).toContain("Good luck.");
  });

  it("says 'First meeting.' when streamerHistory confirms an empty record", () => {
    const out = buildLiveGameScoutingLine(
      envBase({
        opponent: { name: "FreshAccount", race: "Terran" },
        streamerHistory: {
          oppName: "FreshAccount",
          oppRace: "Terran",
          matchup: "PvT",
          headToHead: { wins: 0, losses: 0 },
        },
      }),
    );
    expect(out).toContain("First meeting.");
    expect(out).not.toMatch(/percent win rate/);
    expect(out).toContain("Good luck.");
  });

  it("stays silent on H2H when streamerHistory has not landed yet (no false 'first meeting')", () => {
    // Envelope arrived before the cloud's enrichment hook ran — we
    // can't tell whether this is a first meeting or a repeat
    // opponent, so the utterance must omit the H2H clause rather
    // than claim "first meeting" and risk lying.
    const out = buildLiveGameScoutingLine(
      envBase({ opponent: { name: "Maybe", race: "Zerg" } }),
    );
    expect(out).not.toMatch(/First meeting/);
    expect(out).not.toMatch(/against them/);
    expect(out).toContain("Good luck.");
  });

  it("prefers SC2Pulse's current MMR over the cloud's saved last-game MMR", () => {
    // Pulse is the authoritative "current season rating" source —
    // when it has a value the spoken line uses it, even if the
    // cloud's opponents row carries an older saved value from the
    // last encounter.
    const out = buildLiveGameScoutingLine(
      envBase({
        opponent: {
          name: "THEBLOB",
          race: "Protoss",
          profile: { mmr: 4480 }, // current Pulse rating
        },
        streamerHistory: {
          oppName: "THEBLOB",
          oppRace: "Protoss",
          matchup: "PvP",
          oppMmr: 4327, // saved at end of last game
          headToHead: { wins: 3, losses: 1 },
        },
      }),
    );
    expect(out).toContain("4480 MMR.");
    expect(out).not.toContain("4327 MMR.");
  });

  it("falls back to the saved last-game MMR when Pulse has no usable rating", () => {
    // THEBLOB-style case: Pulse returned a profile but no MMR
    // (insufficient season games / off-ladder activity). The voice
    // line should still announce the saved last-game MMR rather
    // than going silent on the MMR slot.
    const out = buildLiveGameScoutingLine(
      envBase({
        opponent: {
          name: "THEBLOB",
          race: "Protoss",
          profile: { mmr: 0 }, // Pulse returned nothing usable
        },
        streamerHistory: {
          oppName: "THEBLOB",
          oppRace: "Protoss",
          matchup: "PvP",
          oppMmr: 4327,
          headToHead: { wins: 3, losses: 1 },
        },
      }),
    );
    expect(out).toContain("4327 MMR.");
  });

  it("omits the MMR clause cleanly when neither Pulse nor saved MMR is available", () => {
    // First-meeting + Pulse-down case: no profile MMR, no saved
    // history MMR. Never say "0 MMR" or "unknown MMR" — just skip
    // the clause and keep the rest of the sentence intact.
    const out = buildLiveGameScoutingLine(
      envBase({
        opponent: { name: "Stranger", race: "Zerg" },
        streamerHistory: {
          oppName: "Stranger",
          oppRace: "Zerg",
          matchup: "PvZ",
          headToHead: { wins: 0, losses: 0 },
        },
      }),
    );
    expect(out).toContain("Facing Stranger, Zerg.");
    expect(out).not.toMatch(/MMR/);
    expect(out).toContain("First meeting.");
    expect(out).toContain("Good luck.");
  });
});
