import { afterEach, describe, expect, it, vi } from "vitest";
import {
  breadcrumbJsonLd,
  embeddedVideoJsonLd,
  guideMetadata,
  videoJsonLd,
} from "@/components/guides/guideSeo";
import {
  buildDescription,
  buildHeadline,
  counterHeadline,
  counterListMetadata,
  counterMetadata,
  hubMetadata,
  hubTotals,
  mapsListMetadata,
  matchupMetadata,
} from "@/components/guides/guideMetadata";
import { matchupOgCard } from "@/components/guides/og/guideOgData";
import { fmtUnitCount } from "@/components/guides/build/BuildArmySection";
import { lengthLabel } from "@/components/guides/build/BuildChartSections";
import { rankVsStrategyRows, splitBestWorstMaps } from "@/components/guides/build/BuildMatchupSections";
import { milestoneText, splitDelta } from "@/components/guides/build/BuildTimingsSection";
import { safeChannelUrl, safeVideoUrls } from "@/components/guides/youtubeUrls";
import { cellVerdict, unitDisplayName } from "@/components/guides/guideUi";
import { fmtClock, fmtPct } from "@/lib/guides/format";
import {
  FIXTURE_BUILD_PUBLISHED,
  FIXTURE_BUILD_UNPUBLISHED,
  FIXTURE_COUNTER_PUBLISHED,
  FIXTURE_COUNTER_UNPUBLISHED,
  FIXTURE_INDEX,
  FIXTURE_MATCHUP,
  VIDEO_PVZ_CRACKING_8_POOLS,
  fixtureCell,
} from "@/lib/guides/__fixtures__";
import type { GuideVsStrategyRow } from "@/lib/guides/types";

afterEach(() => vi.unstubAllEnvs());

describe("guideSeo", () => {
  it("builds absolute breadcrumb URLs from NEXT_PUBLIC_SITE_URL", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://staging.sc2tools.com/");
    const ld = breadcrumbJsonLd([
      { name: "Guides", path: "/guides" },
      { name: "PvZ", path: "/guides/pvz" },
    ]) as { itemListElement: Array<{ item: string; position: number }> };
    expect(ld.itemListElement.map((entry) => entry.item)).toEqual([
      "https://staging.sc2tools.com/guides",
      "https://staging.sc2tools.com/guides/pvz",
    ]);
    expect(ld.itemListElement.map((entry) => entry.position)).toEqual([1, 2]);
  });

  it("never puts a query string in the canonical and clamps long descriptions", () => {
    const md = guideMetadata({
      title: "t",
      description: "word ".repeat(200),
      canonical: "/guides/pvz?band=league:4",
      noindex: true,
    });
    expect(md.alternates?.canonical).toBe("/guides/pvz");
    expect(String(md.description).length).toBeLessThanOrEqual(300);
    expect(md.robots).toEqual({ index: false, follow: true });
  });

  it("describes a video with the author's excerpt", () => {
    expect(videoJsonLd(VIDEO_PVZ_CRACKING_8_POOLS)).toMatchObject({
      "@type": "VideoObject",
      name: "PvZ Cracking 8 Pools",
      description: VIDEO_PVZ_CRACKING_8_POOLS.excerpt,
      contentUrl: "https://www.youtube.com/watch?v=A4x6gR7J-AY",
      thumbnailUrl: ["https://i.ytimg.com/vi/A4x6gR7J-AY/hqdefault.jpg"],
    });
  });

  it("falls back to the title when the video has no excerpt, never an empty description", () => {
    const title = VIDEO_PVZ_CRACKING_8_POOLS.title;
    expect(videoJsonLd({ ...VIDEO_PVZ_CRACKING_8_POOLS, excerpt: "" })).toMatchObject({ description: title });
    expect(videoJsonLd({ ...VIDEO_PVZ_CRACKING_8_POOLS, excerpt: null })).toMatchObject({ description: title });
  });
});

describe("guideMetadata", () => {
  it("keeps numbers out of unpublished headlines", () => {
    expect(buildHeadline(FIXTURE_BUILD_UNPUBLISHED)).toBe("Carrier Rush PvZ build order guide (12 workers)");
    expect(buildHeadline(FIXTURE_BUILD_PUBLISHED)).toMatch(/— \d+\.\d% win rate vs Diamond \(/);
  });

  it("leads the build description with the same win rate as the title", () => {
    const { headline, overall } = FIXTURE_BUILD_PUBLISHED;
    if (!headline || headline.scope !== "league") throw new Error("fixture needs a league headline");
    const title = buildHeadline(FIXTURE_BUILD_PUBLISHED);
    const description = buildDescription(FIXTURE_BUILD_PUBLISHED);
    expect(title).toContain(`${fmtPct(headline.winRate)} win rate vs ${headline.label}`);
    expect(description).toContain(
      `wins ${fmtPct(headline.winRate)} vs ${headline.label} opponents and ${fmtPct(overall.winRate)} of decided games overall`,
    );
  });

  it("keeps the overall-only description without a league headline", () => {
    const data = {
      ...FIXTURE_BUILD_PUBLISHED,
      headline: {
        scope: "all" as const,
        value: null,
        label: null,
        games: FIXTURE_BUILD_PUBLISHED.overall.games,
        winRate: FIXTURE_BUILD_PUBLISHED.overall.winRate,
      },
    };
    expect(buildDescription(data)).toContain(`wins ${fmtPct(data.overall.winRate)} of decided games across`);
    expect(buildHeadline(data)).toContain(`${fmtPct(data.overall.winRate)} ladder win rate`);
  });

  it("titles the unfiltered matchup page with the opener count", () => {
    expect(matchupMetadata(FIXTURE_MATCHUP).title).toBe(
      `PvZ build orders — ${FIXTURE_MATCHUP.openers.length} openers ranked by win rate (12 workers) | SC2 Tools`,
    );
  });

  it("names the fixed 8-worker patch on a previous-era page, never the live patch", () => {
    const before = { ...FIXTURE_MATCHUP, era: "before" as const };
    const md = matchupMetadata(before);
    expect(md.title).toBe(
      `PvZ build orders — ${FIXTURE_MATCHUP.openers.length} openers ranked by win rate (8-worker patch 5.0.16) | SC2 Tools`,
    );
    expect(String(md.description)).toContain("on the 8-worker patch 5.0.16.");
    expect(`${md.title} ${md.description}`).not.toMatch(/5\.0\.17|12-worker/);
    expect(matchupOgCard(before)?.subtitle).toMatch(/· 8 workers · 5\.0\.16$/);
  });

  it("gives the matchup title and its social card the same opener count", () => {
    const published = FIXTURE_MATCHUP.openers.filter((row) => row.published).length;
    expect(published).toBeLessThan(FIXTURE_MATCHUP.openers.length);
    expect(matchupOgCard(FIXTURE_MATCHUP)?.subtitle).toBe(
      `${FIXTURE_MATCHUP.openers.length} openers ranked by win rate · 12 workers`,
    );
  });

  it("pluralizes counts of one in titles and descriptions", () => {
    const one = { ...FIXTURE_MATCHUP, openers: FIXTURE_MATCHUP.openers.slice(0, 1) };
    expect(matchupMetadata(one).title).toBe("PvZ build orders — 1 opener ranked by win rate (12 workers) | SC2 Tools");
    expect(String(matchupMetadata(one).description)).toMatch(/^1 PvZ opener ranked /);
    expect(matchupOgCard(one)?.subtitle).toMatch(/^1 opener ranked /);
    const oneCounter = {
      ...FIXTURE_MATCHUP,
      counters: FIXTURE_MATCHUP.counters.map((row, i) => ({ ...row, published: i === 0 && row.games !== null })),
    };
    expect(String(counterListMetadata(oneCounter).title)).toContain("— 1 counter guide (12 workers)");
    const oneMap = { ...FIXTURE_INDEX, maps: FIXTURE_INDEX.maps.slice(0, 1) };
    expect(String(mapsListMetadata(oneMap).title)).toContain("— 1 map with openers");
    expect(String(mapsListMetadata(oneMap).description)).toContain("on 1 ladder map,");
  });

  it("states n in the counter-list and maps-list descriptions", () => {
    const counterGames = FIXTURE_MATCHUP.counters
      .filter((row) => row.published && row.games !== null)
      .reduce((sum, row) => sum + (row.games ?? 0), 0);
    expect(counterGames).toBeGreaterThan(0);
    expect(String(counterListMetadata(FIXTURE_MATCHUP).description)).toContain(
      `across ${counterGames.toLocaleString("en-US")} PvZ ladder games.`,
    );
    const mapGames = FIXTURE_INDEX.maps.reduce((sum, map) => sum + map.games, 0);
    expect(String(mapsListMetadata(FIXTURE_INDEX).description)).toContain(
      `from ${mapGames.toLocaleString("en-US")} real ladder games.`,
    );
  });

  it("titles a videos-only hub with its video count and keeps it indexable", () => {
    const videosOnly = {
      ...FIXTURE_INDEX,
      matchups: FIXTURE_INDEX.matchups.map((row) => ({ ...row, published: false, top: [], publishedBuilds: 0 })),
      videos: [VIDEO_PVZ_CRACKING_8_POOLS],
    };
    const md = hubMetadata(videosOnly);
    expect(md.title).toBe("StarCraft II build order guides — 1 build-order video (12 workers) | SC2 Tools");
    expect(md.robots).toBeUndefined();
    expect(hubMetadata({ ...videosOnly, videos: [] }).title).toBe(
      "StarCraft II build order guides (12 workers) | SC2 Tools",
    );
  });
});

describe("section helpers", () => {
  it("labels game-length buckets in minutes", () => {
    expect(lengthLabel({ minSec: 360, maxSec: 600 })).toBe("6–10 min");
    expect(lengthLabel({ minSec: 1200, maxSec: null })).toBe("20+ min");
  });

  it("words milestones from their build-log event", () => {
    expect(milestoneText({ label: "Stargate", event: "start" })).toBe("Stargate started");
    expect(milestoneText({ label: "Blink", event: "finish" })).toBe("Blink done");
  });

  it("never lists a map as both best and worst", () => {
    const { best, worst } = splitBestWorstMaps(FIXTURE_BUILD_PUBLISHED.maps);
    const slugs = [...best, ...worst].map((map) => map.mapSlug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(best[0].ci.low).toBeGreaterThanOrEqual(best[best.length - 1].ci.low);
  });

  it("colours only a decisive interval", () => {
    expect(cellVerdict({ ci: { low: 0.51, high: 0.6 } })).toBe("win");
    expect(cellVerdict({ ci: { low: 0.4, high: 0.49 } })).toBe("loss");
    expect(cellVerdict({ ci: { low: 0.45, high: 0.55 } })).toBe("even");
    expect(unitDisplayName("VoidRay")).toBe("Void Ray");
  });

  it("accepts only first-party YouTube URLs", () => {
    expect(safeVideoUrls(VIDEO_PVZ_CRACKING_8_POOLS)).toEqual({
      embed: "https://www.youtube-nocookie.com/embed/A4x6gR7J-AY",
      watch: "https://www.youtube.com/watch?v=A4x6gR7J-AY",
      thumb: "https://i.ytimg.com/vi/A4x6gR7J-AY/hqdefault.jpg",
    });
    expect(safeVideoUrls({ ...VIDEO_PVZ_CRACKING_8_POOLS, url: "javascript:alert(1)" }).watch).toBeNull();
    expect(safeChannelUrl("https://www.youtube.com/@ReSpOnSeSC2")).toBe("https://www.youtube.com/@ReSpOnSeSC2");
    expect(safeChannelUrl("https://evil.example/@ReSpOnSeSC2")).toBeNull();
  });
});

function vsRow(strategySlug: string, cell: ReturnType<typeof fixtureCell>): GuideVsStrategyRow {
  return { ...cell, strategyKey: `Zerg - ${strategySlug}`, strategySlug, name: strategySlug, published: true };
}

describe("verifier regressions", () => {
  it("ranks vs-opener rows by the Wilson lower bound, not the raw win rate", () => {
    // Thin and lucky: 66.7% over 30 games (ci.low ≈ 0.49); solid: 60% over 400 (ci.low ≈ 0.55).
    const thin = vsRow("thin", fixtureCell(30, 5, 20));
    const solid = vsRow("solid", fixtureCell(400, 60, 240));
    expect(thin.winRate).toBeGreaterThan(solid.winRate);
    expect(solid.ci.low).toBeGreaterThan(thin.ci.low);
    expect(rankVsStrategyRows([thin, solid]).map((row) => row.strategySlug)).toEqual(["solid", "thin"]);
    const tieA = vsRow("a", fixtureCell(60, 9, 33));
    const tieB = vsRow("b", fixtureCell(60, 9, 33));
    expect(rankVsStrategyRows([tieA, tieB]).map((row) => row.strategySlug)).toEqual(["a", "b"]);
  });

  it("states the wins-vs-losses gap from the same rounded clocks the row prints", () => {
    const close = { winners: { games: 40, users: 9, median: 270.4 }, losers: { games: 40, users: 9, median: 270.6 } };
    expect([fmtClock(close.winners.median), fmtClock(close.losers.median)]).toEqual(["4:30", "4:31"]);
    expect(splitDelta(close)).toBe("1s earlier in wins");
    const same = { winners: { games: 40, users: 9, median: 270.2 }, losers: { games: 40, users: 9, median: 269.8 } };
    expect(splitDelta(same)).toBe("same in wins and losses");
    expect(splitDelta({ winners: close.winners })).toBeNull();
  });

  it("prints an interpolated army median with one decimal instead of rounding it up", () => {
    expect(fmtUnitCount(4)).toBe("4");
    expect(fmtUnitCount(2.5)).toBe("2.5");
    expect(fmtUnitCount(1.25)).toBe("1.3");
  });

  it("sums only published matchups into the hub totals", () => {
    const withThinMatchup = {
      ...FIXTURE_INDEX,
      matchups: [
        ...FIXTURE_INDEX.matchups,
        { ...FIXTURE_INDEX.matchups[0], matchup: "ZvZ" as const, slug: "zvz", published: false, games: 57, users: 3, top: [], publishedBuilds: 0 },
      ],
    };
    const before = hubTotals(FIXTURE_INDEX);
    expect(hubTotals(withThinMatchup)).toEqual(before);
    expect(String(hubMetadata(withThinMatchup).description)).not.toContain(
      (before.games + 57).toLocaleString("en-US"),
    );
  });

  it("words counter pages from the matchup, whatever the payload's race labels", () => {
    const terse = { ...FIXTURE_COUNTER_PUBLISHED, myRace: "P", oppRace: "Z" };
    expect(counterHeadline(terse)).toBe(
      `How to beat 12 Pool as Protoss — ${fmtPct(FIXTURE_COUNTER_PUBLISHED.overall.winRate)} win rate over 236 ladder games (12 workers)`,
    );
    expect(String(counterMetadata(terse).description)).toMatch(/^Protoss players win /);
    const unpublished = { ...FIXTURE_COUNTER_UNPUBLISHED, myRace: "P", oppRace: "Z" };
    expect(String(counterMetadata(unpublished).description)).toMatch(/^How to beat Lurker Contain \(Zerg\) as Protoss:/);
    expect(String(counterMetadata(unpublished).description)).not.toMatch(/\d+(\.\d+)?%/);
    // The only digits an unpublished title carries are the era tag's.
    expect(counterHeadline(unpublished).replace("(12 workers)", "")).not.toMatch(/\d/);
  });

  it("gives same-named published counters distinct titles from their own numbers", () => {
    const other = { ...FIXTURE_COUNTER_PUBLISHED, strategySlug: "zerg-12-pool", overall: fixtureCell(180, 33, 97) };
    expect(counterHeadline(other)).not.toBe(counterHeadline(FIXTURE_COUNTER_PUBLISHED));
    expect(counterHeadline(other)).toContain("over 180 ladder games");
  });

  it("restates the card image on the page-level twitter metadata", () => {
    const md = guideMetadata({ title: "t", description: "d", canonical: "/guides" });
    expect(md.twitter).toMatchObject({ card: "summary_large_image", images: ["/og.jpg"] });
  });

  it("emits VideoObject JSON-LD only for first-party YouTube URLs", () => {
    expect(embeddedVideoJsonLd([VIDEO_PVZ_CRACKING_8_POOLS])).toHaveLength(1);
    expect(embeddedVideoJsonLd([])).toEqual([]);
    const hostile = { ...VIDEO_PVZ_CRACKING_8_POOLS, embedUrl: "https://evil.example/embed/A4x6gR7J-AY" };
    expect(videoJsonLd(hostile)).toBeNull();
    expect(embeddedVideoJsonLd([hostile, VIDEO_PVZ_CRACKING_8_POOLS])).toEqual([]);
  });
});
