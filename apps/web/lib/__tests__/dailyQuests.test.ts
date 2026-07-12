import { describe, expect, it } from "vitest";
import type { ArcadeGame } from "@/components/analyzer/arcade/types";
import {
  buildQuestContext,
  evaluateQuests,
  gamesOnDay,
  QUEST_POOL,
  selectDailyQuests,
  type QuestContext,
} from "../dailyQuests";

/* ──────────────── fixtures ──────────────── */

const DAY = "2026-07-11";

let seq = 0;
function mkGame(partial: Partial<ArcadeGame>): ArcadeGame {
  seq += 1;
  return {
    gameId: `g${seq}`,
    date: `${DAY}T10:00:00Z`,
    result: "Win",
    ...partial,
  };
}

/**
 * A corpus rich enough that every quest in the pool is eligible:
 * 60 games across June 2026 (inside the 60-day struggle-map window of
 * any July date), all fields populated.
 */
function richCorpus(): ArcadeGame[] {
  const games: ArcadeGame[] = [];
  const base = Date.parse("2026-06-01T12:00:00Z");
  const maps = ["Alcyone", "Solaris", "Equilibrium", "Goldenaura"];
  for (let i = 0; i < 60; i++) {
    const win = i % 2 === 0;
    games.push(
      mkGame({
        gameId: `rich${i}`,
        date: new Date(base + i * 6 * 3_600_000).toISOString(),
        result: win ? "Win" : "Loss",
        oppRace: (["P", "T", "Z"] as const)[i % 3],
        myRace: "P",
        myToonHandle: "1-S2-1-267727",
        myMmr: 3500 + i,
        oppMmr: 3500 + i + (i % 5 === 0 ? 50 : -20),
        duration: 600 + (i % 10) * 60,
        map: maps[i % 4],
        myBuild: i % 3 === 0 ? "PvX - Signature Build" : "PvX - Other Opener",
        macro_score: 60 + (i % 20),
      }),
    );
  }
  return games;
}

function specFor(id: string) {
  const spec = QUEST_POOL.find((s) => s.id === id);
  if (!spec) throw new Error(`no quest spec ${id}`);
  return spec;
}

function defFor(id: string, ctx: QuestContext) {
  return specFor(id).build(ctx);
}

/** Context over a corpus that satisfies no personalization requirement. */
function bareContext(totalGames = 10): QuestContext {
  const games = Array.from({ length: totalGames }, (_, i) =>
    mkGame({ date: `2026-06-0${(i % 9) + 1}T10:00:00Z`, result: "Win" }),
  );
  return buildQuestContext(games, DAY);
}

/* ──────────────── determinism ──────────────── */

describe("selectDailyQuests determinism", () => {
  it("same date + corpus + user → identical quests (ids, titles, xp)", () => {
    const corpus = richCorpus();
    const a = selectDailyQuests(DAY, corpus, 3, "user-1");
    const b = selectDailyQuests(DAY, corpus, 3, "user-1");
    expect(b.quests.map((q) => q.id)).toEqual(a.quests.map((q) => q.id));
    expect(b.quests.map((q) => q.title)).toEqual(a.quests.map((q) => q.title));
    expect(b.quests.map((q) => q.xp)).toEqual(a.quests.map((q) => q.xp));
    expect(a.quests).toHaveLength(3);
  });

  it("different dates rotate the selection", () => {
    const corpus = richCorpus();
    const signatures = new Set<string>();
    for (let d = 1; d <= 28; d++) {
      const key = `2026-07-${String(d).padStart(2, "0")}`;
      const sel = selectDailyQuests(key, corpus, 3, "user-1");
      signatures.add(sel.quests.map((q) => q.id).join("|"));
    }
    expect(signatures.size).toBeGreaterThan(1);
  });

  it("never serves two quests of the same category on one day", () => {
    const corpus = richCorpus();
    for (let d = 1; d <= 28; d++) {
      const key = `2026-07-${String(d).padStart(2, "0")}`;
      const sel = selectDailyQuests(key, corpus, 3, "user-1");
      const cats = sel.quests.map((q) => q.category);
      expect(new Set(cats).size).toBe(cats.length);
      expect(sel.quests).toHaveLength(3);
    }
  });

  it("respects n", () => {
    const sel = selectDailyQuests(DAY, richCorpus(), 2, "user-1");
    expect(sel.quests).toHaveLength(2);
  });
});

/* ──────────────── eligibility exclusions ──────────────── */

describe("eligibility", () => {
  it("empty corpus → no quests at all", () => {
    expect(selectDailyQuests(DAY, []).quests).toHaveLength(0);
  });

  it("one bare game → only the participation quest", () => {
    const sel = selectDailyQuests(DAY, [mkGame({ date: "2026-06-01T10:00:00Z" })]);
    expect(sel.quests.map((q) => q.id)).toEqual(["play-3"]);
  });

  it("no macro_score history → macro quests never selected", () => {
    const corpus = richCorpus().map((g) => ({ ...g, macro_score: null }));
    for (let d = 1; d <= 20; d++) {
      const key = `2026-07-${String(d).padStart(2, "0")}`;
      const sel = selectDailyQuests(key, corpus, 3, "user-1");
      expect(sel.quests.some((q) => q.category === "macro")).toBe(false);
    }
  });

  it("worst-matchup needs 10 decided games vs a race and picks the lowest winrate", () => {
    // 12 decided vs Z at 25%, 12 vs T at 75% → Z is the demon.
    const games: ArcadeGame[] = [];
    for (let i = 0; i < 12; i++) {
      games.push(
        mkGame({
          date: `2026-06-10T0${i % 10}:00:00Z`,
          result: i < 3 ? "Win" : "Loss",
          oppRace: "Z",
        }),
      );
      games.push(
        mkGame({
          date: `2026-06-11T0${i % 10}:00:00Z`,
          result: i < 9 ? "Win" : "Loss",
          oppRace: "T",
        }),
      );
    }
    const ctx = buildQuestContext(games, DAY);
    expect(ctx.worstMatchup).toEqual({ race: "Z", decided: 12, winRate: 0.25 });
    expect(specFor("worst-matchup-win").eligible(ctx)).toBe(true);

    // Only 9 decided per race → ineligible.
    const thin = games.slice(0, 18); // 9 Z + 9 T
    const thinCtx = buildQuestContext(thin, DAY);
    expect(thinCtx.worstMatchup).toBeNull();
    expect(specFor("worst-matchup-win").eligible(thinCtx)).toBe(false);
  });

  it("signature build needs 5 plays and excludes 'Game Too Short'", () => {
    const games: ArcadeGame[] = [];
    for (let i = 0; i < 6; i++) {
      games.push(mkGame({ myBuild: "ZvT - Game Too Short", result: "Loss" }));
    }
    for (let i = 0; i < 5; i++) {
      games.push(mkGame({ myBuild: "ZvT - Hatch First", result: "Win" }));
    }
    const ctx = buildQuestContext(games, DAY);
    expect(ctx.signatureBuild?.name).toBe("ZvT - Hatch First");
    expect(specFor("signature-build-win").eligible(ctx)).toBe(true);

    // Drop one Hatch First play → below the 5-play bar → ineligible.
    const thinCtx = buildQuestContext(games.slice(0, 10), DAY);
    expect(thinCtx.signatureBuild).toBeNull();
    expect(specFor("signature-build-win").eligible(thinCtx)).toBe(false);
  });

  it("struggle map: <55% winrate, ≥4 recent decided, inside the 60-day window", () => {
    const mk = (map: string, result: string, date: string) =>
      mkGame({ map, result, date });
    const games = [
      // 3W-3L on Alcyone (50% → struggling).
      ...Array.from({ length: 3 }, (_, i) =>
        mk("Alcyone", "Win", `2026-06-2${i}T10:00:00Z`),
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        mk("Alcyone", "Loss", `2026-06-2${i}T11:00:00Z`),
      ),
      // 5W-3L on Solaris (62.5% → fine, excluded).
      ...Array.from({ length: 5 }, (_, i) =>
        mk("Solaris", "Win", `2026-06-1${i}T10:00:00Z`),
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        mk("Solaris", "Loss", `2026-06-1${i}T11:00:00Z`),
      ),
      // Ancient losses on OldMap — outside the 60-day window, ignored.
      ...Array.from({ length: 8 }, (_, i) =>
        mk("OldMap", "Loss", `2025-01-0${i + 1}T10:00:00Z`),
      ),
    ];
    const ctx = buildQuestContext(games, DAY);
    expect(ctx.struggleMap?.name).toBe("Alcyone");
    expect(ctx.struggleMap?.winRate).toBeCloseTo(0.5);
    expect(specFor("struggle-map-win").eligible(ctx)).toBe(true);

    // Below 4 decided on the struggling map → it can't qualify.
    const thin = games.slice(3); // drops all 3 Alcyone wins → 0W-3L (3 decided)
    expect(buildQuestContext(thin, DAY).struggleMap).toBeNull();

    // No struggling map anywhere → quest ineligible.
    const none = games.filter((g) => g.map !== "Alcyone");
    const noneCtx = buildQuestContext(none, DAY);
    expect(noneCtx.struggleMap).toBeNull();
    expect(specFor("struggle-map-win").eligible(noneCtx)).toBe(false);
  });

  it("long-game quest needs 5 timed wins; median is clamped to 8–15 minutes", () => {
    const shortWins = Array.from({ length: 5 }, () =>
      mkGame({ result: "Win", duration: 300 }),
    );
    const ctxShort = buildQuestContext(shortWins, DAY);
    expect(ctxShort.medianWinMinutes).toBe(5);
    const defShort = defFor("long-game-win", ctxShort);
    expect(defShort.description).toContain("8+");

    const longWins = Array.from({ length: 5 }, () =>
      mkGame({ result: "Win", duration: 1200 }),
    );
    const ctxLong = buildQuestContext(longWins, DAY);
    const defLong = defFor("long-game-win", ctxLong);
    expect(defLong.description).toContain("15+");

    // 4 timed wins → ineligible.
    const thinCtx = buildQuestContext(longWins.slice(0, 4), DAY);
    expect(specFor("long-game-win").eligible(thinCtx)).toBe(false);
  });

  it("MMR quests gate on rated / paired game counts", () => {
    const rated = Array.from({ length: 5 }, (_, i) =>
      mkGame({ myToonHandle: "1-S2-1-267727", myMmr: 3500 + i }),
    );
    const ratedCtx = buildQuestContext(rated, DAY);
    expect(specFor("mmr-climb").eligible(ratedCtx)).toBe(true);
    // myMmr alone isn't enough for giant-slayer (needs opponent MMR too).
    expect(specFor("giant-slayer").eligible(ratedCtx)).toBe(false);

    const paired = Array.from({ length: 5 }, (_, i) =>
      mkGame({
        myToonHandle: "1-S2-1-267727",
        myMmr: 3500 + i,
        opponent: { mmr: 3600 },
      }),
    );
    const pairedCtx = buildQuestContext(paired, DAY);
    expect(pairedCtx.mmrPairGames).toBe(5);
    expect(specFor("giant-slayer").eligible(pairedCtx)).toBe(true);

    const handlelessCtx = buildQuestContext(
      Array.from({ length: 5 }, (_, i) => mkGame({ myMmr: 3500 + i })),
      DAY,
    );
    expect(handlelessCtx.ratedGames).toBe(0);
    expect(specFor("mmr-climb").eligible(handlelessCtx)).toBe(false);
  });

  it("macro thresholds derive from the recent average (+5, clamped)", () => {
    const avg60 = Array.from({ length: 8 }, () => mkGame({ macro_score: 60 }));
    const ctx = buildQuestContext(avg60, DAY);
    expect(ctx.macroRecentAvg).toBe(60);
    expect(defFor("macro-beat-average", ctx).title).toContain("65");
    expect(defFor("macro-hold-the-line", ctx).title).toContain("60");

    // Ceiling: a 95-average player still gets a reachable bar.
    const avg95 = Array.from({ length: 8 }, () => mkGame({ macro_score: 95 }));
    const highCtx = buildQuestContext(avg95, DAY);
    expect(defFor("macro-beat-average", highCtx).title).toContain("95");
    expect(defFor("macro-hold-the-line", highCtx).title).toContain("90");
  });
});

/* ──────────────── per-verifier progress math ──────────────── */

describe("verifiers", () => {
  const ctx = bareContext();

  it("play-3 counts every game today and caps at target", () => {
    const def = defFor("play-3", ctx);
    expect(def.verify([mkGame({}), mkGame({})], ctx)).toEqual({
      progress: 2,
      done: false,
    });
    const four = [mkGame({}), mkGame({}), mkGame({}), mkGame({})];
    expect(def.verify(four, ctx)).toEqual({ progress: 3, done: true });
  });

  it("win-2 counts only wins", () => {
    const def = defFor("win-2", ctx);
    const today = [
      mkGame({ result: "Win" }),
      mkGame({ result: "Loss" }),
      mkGame({ result: "Victory" }),
    ];
    expect(def.verify(today, ctx)).toEqual({ progress: 2, done: true });
    expect(def.verify([mkGame({ result: "Loss" })], ctx)).toEqual({
      progress: 0,
      done: false,
    });
  });

  it("worst-matchup-win only counts wins vs the demon race", () => {
    const rich = buildQuestContext(richCorpus(), DAY);
    expect(rich.worstMatchup).not.toBeNull();
    const race = rich.worstMatchup!.race;
    const def = defFor("worst-matchup-win", rich);
    expect(
      def.verify([mkGame({ result: "Loss", oppRace: race })], rich).done,
    ).toBe(false);
    const otherRace = race === "P" ? "T" : "P";
    expect(
      def.verify([mkGame({ result: "Win", oppRace: otherRace })], rich).done,
    ).toBe(false);
    expect(
      def.verify([mkGame({ result: "Win", oppRace: race })], rich),
    ).toEqual({ progress: 1, done: true });
  });

  it("macro-beat-average passes at/above the threshold, even on a loss", () => {
    const macroCtx = buildQuestContext(
      Array.from({ length: 8 }, () => mkGame({ macro_score: 60 })),
      DAY,
    );
    const def = defFor("macro-beat-average", macroCtx); // threshold 65
    expect(def.verify([mkGame({ result: "Loss", macro_score: 64 })], macroCtx).done).toBe(false);
    expect(def.verify([mkGame({ result: "Loss", macro_score: 65 })], macroCtx).done).toBe(true);
    expect(def.verify([mkGame({ result: "Win" })], macroCtx).done).toBe(false); // no score → no credit
  });

  it("macro-hold-the-line needs two games at the average", () => {
    const macroCtx = buildQuestContext(
      Array.from({ length: 8 }, () => mkGame({ macro_score: 60 })),
      DAY,
    );
    const def = defFor("macro-hold-the-line", macroCtx); // threshold 60
    const one = [mkGame({ macro_score: 70 }), mkGame({ macro_score: 59 })];
    expect(def.verify(one, macroCtx)).toEqual({ progress: 1, done: false });
    const two = [...one, mkGame({ macro_score: 60 })];
    expect(def.verify(two, macroCtx)).toEqual({ progress: 2, done: true });
  });

  it("signature-build-win matches the build case-insensitively and requires a win", () => {
    const buildCtx = buildQuestContext(
      Array.from({ length: 5 }, () => mkGame({ myBuild: "ZvT - Hatch First" })),
      DAY,
    );
    const def = defFor("signature-build-win", buildCtx);
    expect(
      def.verify([mkGame({ result: "Win", myBuild: "  zvt - hatch first " })], buildCtx).done,
    ).toBe(true);
    expect(
      def.verify([mkGame({ result: "Loss", myBuild: "ZvT - Hatch First" })], buildCtx).done,
    ).toBe(false);
    expect(
      def.verify([mkGame({ result: "Win", myBuild: "ZvT - Roach Rush" })], buildCtx).done,
    ).toBe(false);
  });

  it("struggle-map-win matches the map case-insensitively and requires a win", () => {
    const mapCtx = buildQuestContext(
      [
        ...Array.from({ length: 2 }, () =>
          mkGame({ map: "Alcyone", result: "Win", date: "2026-06-20T10:00:00Z" }),
        ),
        ...Array.from({ length: 3 }, () =>
          mkGame({ map: "Alcyone", result: "Loss", date: "2026-06-21T10:00:00Z" }),
        ),
      ],
      DAY,
    );
    const def = defFor("struggle-map-win", mapCtx);
    expect(def.verify([mkGame({ result: "Win", map: " alcyone " })], mapCtx).done).toBe(true);
    expect(def.verify([mkGame({ result: "Loss", map: "Alcyone" })], mapCtx).done).toBe(false);
    expect(def.verify([mkGame({ result: "Win", map: "Solaris" })], mapCtx).done).toBe(false);
  });

  it("win-streak-2 tracks the best consecutive run; losses reset, undecided skipped", () => {
    const def = defFor("win-streak-2", ctx);
    const wlw = [
      mkGame({ result: "Win" }),
      mkGame({ result: "Loss" }),
      mkGame({ result: "Win" }),
    ];
    expect(def.verify(wlw, ctx)).toEqual({ progress: 1, done: false });
    const wuw = [
      mkGame({ result: "Win" }),
      mkGame({ result: "unknown" }),
      mkGame({ result: "Win" }),
    ];
    expect(def.verify(wuw, ctx)).toEqual({ progress: 2, done: true });
  });

  it("giant-slayer needs a WIN against strictly higher MMR (nested fallback works)", () => {
    const def = defFor("giant-slayer", ctx);
    expect(
      def.verify([mkGame({ result: "Win", myMmr: 3500, oppMmr: 3600 })], ctx).done,
    ).toBe(true);
    expect(
      def.verify([mkGame({ result: "Win", myMmr: 3500, opponent: { mmr: 3501 } })], ctx).done,
    ).toBe(true);
    expect(
      def.verify([mkGame({ result: "Win", myMmr: 3500, oppMmr: 3400 })], ctx).done,
    ).toBe(false);
    expect(
      def.verify([mkGame({ result: "Loss", myMmr: 3500, oppMmr: 3600 })], ctx).done,
    ).toBe(false);
    expect(def.verify([mkGame({ result: "Win", myMmr: 3500 })], ctx).done).toBe(false);
  });

  it("giant-slayer compares the opponent with that game's regional-account MMR", () => {
    const def = defFor("giant-slayer", ctx);
    const naHandle = "1-S2-1-267727";
    const euHandle = "2-S2-1-8780508";

    // The EU win is an upset relative to the EU account's 5,200 MMR even
    // though the player's separate NA account is rated above that opponent.
    expect(
      def.verify(
        [
          mkGame({
            result: "Loss",
            myToonHandle: naHandle,
            myMmr: 5400,
            oppMmr: 5500,
          }),
          mkGame({
            result: "Win",
            myToonHandle: euHandle,
            myMmr: 5200,
            oppMmr: 5250,
          }),
        ],
        ctx,
      ).done,
    ).toBe(true);

    // Conversely, a normal NA win must not borrow the lower EU rating and
    // become a false upset merely because both regions were played today.
    expect(
      def.verify(
        [
          mkGame({
            result: "Win",
            myToonHandle: naHandle,
            myMmr: 5400,
            oppMmr: 5300,
          }),
          mkGame({
            result: "Loss",
            myToonHandle: euHandle,
            myMmr: 5200,
            oppMmr: 5250,
          }),
        ],
        ctx,
      ).done,
    ).toBe(false);
  });

  it("long-game-win requires a win at/above the personalized duration", () => {
    const durCtx = buildQuestContext(
      Array.from({ length: 5 }, () => mkGame({ result: "Win", duration: 600 })),
      DAY,
    ); // median 10 min → threshold 10
    const def = defFor("long-game-win", durCtx);
    expect(def.verify([mkGame({ result: "Win", duration: 599 })], durCtx).done).toBe(false);
    expect(def.verify([mkGame({ result: "Win", duration: 600 })], durCtx).done).toBe(true);
    expect(def.verify([mkGame({ result: "Loss", duration: 1200 })], durCtx).done).toBe(false);
  });

  it("bounce-back fires on a win immediately after a loss (undecided skipped)", () => {
    const def = defFor("bounce-back", ctx);
    const lw = [mkGame({ result: "Loss" }), mkGame({ result: "Win" })];
    expect(def.verify(lw, ctx)).toEqual({ progress: 1, done: true });
    const wl = [mkGame({ result: "Win" }), mkGame({ result: "Loss" })];
    expect(def.verify(wl, ctx)).toEqual({ progress: 0, done: false });
    const luw = [
      mkGame({ result: "Loss" }),
      mkGame({ result: "unknown" }),
      mkGame({ result: "Win" }),
    ];
    expect(def.verify(luw, ctx)).toEqual({ progress: 1, done: true });
  });

  it("mmr-climb compares first vs last rated game of the day", () => {
    const def = defFor("mmr-climb", ctx);
    const account = "1-S2-1-267727";
    const up = [
      mkGame({ myToonHandle: account, myMmr: 3500 }),
      mkGame({ myToonHandle: account, myMmr: 3480 }),
      mkGame({ myToonHandle: account, myMmr: 3520 }),
    ];
    expect(def.verify(up, ctx)).toEqual({ progress: 1, done: true });
    const down = [
      mkGame({ myToonHandle: account, myMmr: 3520 }),
      mkGame({ myToonHandle: account, myMmr: 3500 }),
    ];
    expect(def.verify(down, ctx)).toEqual({ progress: 0, done: false });
    expect(
      def.verify([mkGame({ myToonHandle: account, myMmr: 3500 })], ctx),
    ).toEqual({ progress: 0, done: false });
  });

  it("mmr-climb cannot combine a one-game NA start with a one-game EU finish", () => {
    const def = defFor("mmr-climb", ctx);
    const today = [
      mkGame({
        date: `${DAY}T09:00:00Z`,
        myToonHandle: "1-S2-1-267727",
        myMmr: 5100,
      }),
      mkGame({
        date: `${DAY}T10:00:00Z`,
        myToonHandle: "2-S2-1-8780508",
        myMmr: 5200,
      }),
    ];

    expect(def.verify(today, ctx)).toEqual({ progress: 0, done: false });
  });

  it("mmr-climb cannot combine separate accounts from the same region", () => {
    const def = defFor("mmr-climb", ctx);
    const today = [
      mkGame({ myToonHandle: "1-S2-1-267727", myMmr: 5100 }),
      mkGame({ myToonHandle: "1-S2-1-13835879", myMmr: 5200 }),
    ];

    expect(def.verify(today, ctx)).toEqual({ progress: 0, done: false });
  });

  it("mmr-climb does not infer one account from handle-less MMR points", () => {
    const def = defFor("mmr-climb", ctx);
    const today = [mkGame({ myMmr: 5100 }), mkGame({ myMmr: 5200 })];

    expect(def.verify(today, ctx)).toEqual({ progress: 0, done: false });
  });

  it("mmr-climb completes when one regional account ends above its own start", () => {
    const def = defFor("mmr-climb", ctx);
    const today = [
      mkGame({
        date: `${DAY}T09:00:00Z`,
        myToonHandle: "1-S2-1-267727",
        myMmr: 5400,
      }),
      mkGame({
        date: `${DAY}T10:00:00Z`,
        myToonHandle: "2-S2-1-8780508",
        myMmr: 5200,
      }),
      mkGame({
        date: `${DAY}T11:00:00Z`,
        myToonHandle: "1-S2-1-267727",
        myMmr: 5420,
      }),
      mkGame({
        date: `${DAY}T12:00:00Z`,
        myToonHandle: "2-S2-1-8780508",
        myMmr: 5190,
      }),
    ];

    expect(def.verify(today, ctx)).toEqual({ progress: 1, done: true });
  });
});

/* ──────────────── day-boundary filtering ──────────────── */

describe("day boundaries (arcade local-day convention)", () => {
  it("gamesOnDay keeps only games on the key's UTC day when tz=UTC, sorted ascending", () => {
    const games = [
      mkGame({ gameId: "late", date: "2026-07-11T23:59:59Z" }),
      mkGame({ gameId: "before", date: "2026-07-10T23:59:59Z" }),
      mkGame({ gameId: "early", date: "2026-07-11T00:00:00Z" }),
      mkGame({ gameId: "after", date: "2026-07-12T00:00:00Z" }),
      mkGame({ gameId: "junk", date: "not-a-date" }),
    ];
    const today = gamesOnDay(games, DAY, "UTC");
    expect(today.map((g) => g.gameId)).toEqual(["early", "late"]);
  });

  it("respects the user's timezone: a late-UTC game lands on the LOCAL day", () => {
    // 2026-07-12T02:00Z is 2026-07-11 22:00 in New York.
    const games = [mkGame({ gameId: "ny", date: "2026-07-12T02:00:00Z" })];
    expect(gamesOnDay(games, DAY, "America/New_York").map((g) => g.gameId)).toEqual(["ny"]);
    expect(gamesOnDay(games, DAY, "UTC")).toHaveLength(0);
  });

  it("evaluateQuests counts only the day's games", () => {
    const corpus = [
      // Yesterday: 3 wins (must NOT count).
      mkGame({ date: "2026-07-10T10:00:00Z", result: "Win" }),
      mkGame({ date: "2026-07-10T11:00:00Z", result: "Win" }),
      mkGame({ date: "2026-07-10T12:00:00Z", result: "Win" }),
      // Today: 1 win, 1 loss.
      mkGame({ date: "2026-07-11T10:00:00Z", result: "Loss" }),
      mkGame({ date: "2026-07-11T11:00:00Z", result: "Win" }),
    ];
    const sel = selectDailyQuests(DAY, corpus, 12, "user-1");
    const evals = evaluateQuests(sel.quests, corpus, DAY, "UTC", sel.context);
    const byId = new Map(evals.map((e) => [e.quest.id, e]));
    expect(byId.get("play-3")).toMatchObject({ progress: 2, done: false });
    expect(byId.get("win-2")).toMatchObject({ progress: 1, done: false });
    // The loss→win sequence today completes bounce-back.
    expect(byId.get("bounce-back")).toMatchObject({ progress: 1, done: true });
  });

  it("evaluateQuests sorts the day's games chronologically before verifying", () => {
    // mmr-climb depends on first-vs-last ordering; feed the array reversed.
    const account = "1-S2-1-267727";
    const corpus = [
      mkGame({ date: "2026-07-11T18:00:00Z", myToonHandle: account, myMmr: 3550 }),
      mkGame({ date: "2026-07-11T09:00:00Z", myToonHandle: account, myMmr: 3500 }),
      mkGame({ date: "2026-06-01T09:00:00Z", myToonHandle: account, myMmr: 3400 }),
      mkGame({ date: "2026-06-02T09:00:00Z", myToonHandle: account, myMmr: 3410 }),
      mkGame({ date: "2026-06-03T09:00:00Z", myToonHandle: account, myMmr: 3420 }),
    ];
    const ctx = buildQuestContext(corpus, DAY);
    const def = defFor("mmr-climb", ctx);
    const evals = evaluateQuests([def], corpus, DAY, "UTC", ctx);
    expect(evals[0]).toMatchObject({ progress: 1, done: true });
  });
});
