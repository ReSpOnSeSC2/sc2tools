import { cleanup, render, screen } from "@testing-library/react";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchGuideBuild: vi.fn(),
  fetchGuideCounter: vi.fn(),
  fetchGuideMatchup: vi.fn(),
  images: [] as Array<{ element: ReactElement; options: unknown }>,
}));

// satori/resvg don't run under jsdom: capture what the route would draw.
vi.mock("next/og", () => ({
  ImageResponse: class {
    constructor(element: ReactElement, options: unknown) {
      mocks.images.push({ element, options });
    }
  },
}));
vi.mock("@/lib/guides/api", () => ({
  fetchGuideBuild: mocks.fetchGuideBuild,
  fetchGuideCounter: mocks.fetchGuideCounter,
  fetchGuideMatchup: mocks.fetchGuideMatchup,
}));

import BuildOg, { size as buildSize } from "@/app/guides/[matchup]/[build]/opengraph-image";
import CounterOg from "@/app/guides/[matchup]/counter/[strategy]/opengraph-image";
import MatchupOg from "@/app/guides/[matchup]/opengraph-image";
import {
  GUIDE_OG_CACHE_CONTROL,
  GUIDE_OG_NEUTRAL_CACHE_CONTROL,
  GuideOgCard,
} from "@/components/guides/og/GuideOgCard";
import { buildOgCard, counterOgCard, matchupOgCard } from "@/components/guides/og/guideOgData";
import {
  buildMetadata,
  counterListMetadata,
  counterMetadata,
  hubMetadata,
  matchupMetadata,
} from "@/components/guides/guideMetadata";
import {
  FIXTURE_BUILD_PUBLISHED,
  FIXTURE_BUILD_UNPUBLISHED,
  FIXTURE_COUNTER_PUBLISHED,
  FIXTURE_COUNTER_UNPUBLISHED,
  FIXTURE_INDEX,
  FIXTURE_MATCHUP,
} from "@/lib/guides/__fixtures__";

const ok = <T,>(data: T) => ({ kind: "ok" as const, data });
const pct = (fraction: number) => `${(fraction * 100).toFixed(1)}%`;

beforeEach(() => vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "on"));
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  mocks.images.length = 0;
  mocks.fetchGuideBuild.mockReset();
  mocks.fetchGuideCounter.mockReset();
  mocks.fetchGuideMatchup.mockReset();
});

/** Every host element satori draws must be display:flex (its layout model). */
function nonFlexElements(node: ReactNode): string[] {
  if (Array.isArray(node)) return node.flatMap(nonFlexElements);
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<{ style?: { display?: string }; children?: ReactNode }>;
  if (typeof element.type === "function") {
    const render = element.type as (props: unknown) => ReactNode;
    return nonFlexElements(render(element.props));
  }
  const own = element.type === "div" && element.props.style?.display !== "flex" ? [String(element.type)] : [];
  return [...own, ...nonFlexElements(element.props.children)];
}

describe("guide OG card data", () => {
  it("draws the build headline cell: the Diamond band's rate, n and players", () => {
    const card = buildOgCard(FIXTURE_BUILD_PUBLISHED);
    const diamond = FIXTURE_BUILD_PUBLISHED.bands.league.find((row) => row.value === 4);
    expect(diamond).toBeDefined();
    expect(card).toMatchObject({
      kind: "Build guide",
      matchup: "PvZ",
      title: "Stargate into Glaives",
      rate: { label: "Win rate vs Diamond", winRate: diamond?.winRate, games: diamond?.games, ci: diamond?.ci },
    });
    expect(card?.stats).toEqual([
      { label: "Players", value: String(diamond?.users) },
      { label: "Game", value: "12 workers" },
    ]);
  });

  it("falls back to the overall cell when the headline covers all games", () => {
    const card = buildOgCard({ ...FIXTURE_BUILD_PUBLISHED, headline: null });
    expect(card?.rate).toEqual({
      label: "Ladder win rate",
      winRate: FIXTURE_BUILD_PUBLISHED.overall.winRate,
      ci: FIXTURE_BUILD_PUBLISHED.overall.ci,
      games: FIXTURE_BUILD_PUBLISHED.overall.games,
    });
  });

  it("uses the matchup's top published opener and the counter's overall cell", () => {
    const top = FIXTURE_MATCHUP.openers.find((row) => row.published);
    expect(matchupOgCard(FIXTURE_MATCHUP)?.rate).toMatchObject({ label: `Top opener: ${top?.name}`, games: top?.games });
    expect(counterOgCard(FIXTURE_COUNTER_PUBLISHED)).toMatchObject({
      title: "How to beat 12 Pool",
      rate: { label: "Protoss win rate vs 12 Pool", games: FIXTURE_COUNTER_PUBLISHED.overall.games },
    });
  });

  it("has no card (neutral image) below the publishing floor", () => {
    expect(buildOgCard(FIXTURE_BUILD_UNPUBLISHED)).toBeNull();
    expect(counterOgCard(FIXTURE_COUNTER_UNPUBLISHED)).toBeNull();
    expect(matchupOgCard({ ...FIXTURE_MATCHUP, published: false, games: null, users: null })).toBeNull();
  });
});

describe("GuideOgCard", () => {
  it("shows the headline win rate, n and the site", () => {
    const card = buildOgCard(FIXTURE_BUILD_PUBLISHED);
    render(<GuideOgCard card={card} />);
    expect(screen.getByText(pct(card?.rate?.winRate ?? Number.NaN))).toBeTruthy();
    expect(screen.getByText(`n = ${card?.rate?.games} games`)).toBeTruthy();
    expect(screen.getByText("sc2tools.com/guides")).toBeTruthy();
  });

  it("renders a neutral branded card without any number", () => {
    const { container } = render(<GuideOgCard card={null} />);
    expect(container.textContent).toContain("StarCraft II build order guides");
    // "SC2" is the brand, not a statistic.
    expect(container.textContent?.replace(/sc2/gi, "")).not.toMatch(/\d/);
  });

  it("keeps display:flex on every div (satori)", () => {
    expect(nonFlexElements(<GuideOgCard card={buildOgCard(FIXTURE_BUILD_PUBLISHED)} />)).toEqual([]);
    expect(nonFlexElements(<GuideOgCard card={matchupOgCard(FIXTURE_MATCHUP)} />)).toEqual([]);
    expect(nonFlexElements(<GuideOgCard card={null} />)).toEqual([]);
  });
});

describe("opengraph-image routes", () => {
  const lastCard = () => (mocks.images.at(-1)?.element.props as { card: unknown }).card;

  it("renders the build card from the cached guide payload", async () => {
    mocks.fetchGuideBuild.mockResolvedValue(ok(FIXTURE_BUILD_PUBLISHED));
    await BuildOg({ params: Promise.resolve({ matchup: "pvz", build: "stargate-into-glaives" }) });
    expect(mocks.fetchGuideBuild).toHaveBeenCalledWith("pvz", "stargate-into-glaives");
    expect(lastCard()).toEqual(buildOgCard(FIXTURE_BUILD_PUBLISHED));
    // Never next/og's default year-long immutable cache: the numbers move nightly.
    expect(mocks.images.at(-1)?.options).toEqual({
      ...buildSize,
      headers: { "cache-control": GUIDE_OG_CACHE_CONTROL },
    });
    expect(GUIDE_OG_CACHE_CONTROL).toContain("s-maxage=21600");
  });

  it.each([
    ["the API is down", { kind: "unavailable" }],
    ["the slug is unknown", { kind: "not_found" }],
    ["the slug moved", { kind: "moved", path: "/guides/pvz/new" }],
    ["the build is unpublished", ok(FIXTURE_BUILD_UNPUBLISHED)],
  ])("falls back to the neutral card when %s", async (_why, result) => {
    mocks.fetchGuideBuild.mockResolvedValue(result);
    await BuildOg({ params: Promise.resolve({ matchup: "pvz", build: "x" }) });
    expect(lastCard()).toBeNull();
    expect(mocks.images.at(-1)?.options).toMatchObject({
      headers: { "cache-control": GUIDE_OG_NEUTRAL_CACHE_CONTROL },
    });
  });

  it("never fetches while guides are off", async () => {
    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "");
    await MatchupOg({ params: Promise.resolve({ matchup: "pvz" }) });
    await CounterOg({ params: Promise.resolve({ matchup: "pvz", strategy: "12-pool" }) });
    expect(mocks.fetchGuideMatchup).not.toHaveBeenCalled();
    expect(mocks.fetchGuideCounter).not.toHaveBeenCalled();
    expect(mocks.images.map((image) => (image.element.props as { card: unknown }).card)).toEqual([null, null]);
  });

  it("renders the matchup (unfiltered) and counter cards", async () => {
    mocks.fetchGuideMatchup.mockResolvedValue(ok(FIXTURE_MATCHUP));
    mocks.fetchGuideCounter.mockResolvedValue(ok(FIXTURE_COUNTER_PUBLISHED));
    await MatchupOg({ params: Promise.resolve({ matchup: "pvz" }) });
    expect(mocks.fetchGuideMatchup).toHaveBeenCalledWith("pvz");
    expect(lastCard()).toEqual(matchupOgCard(FIXTURE_MATCHUP));
    await CounterOg({ params: Promise.resolve({ matchup: "pvz", strategy: "12-pool" }) });
    expect(mocks.fetchGuideCounter).toHaveBeenCalledWith("pvz", "12-pool");
    expect(lastCard()).toEqual(counterOgCard(FIXTURE_COUNTER_PUBLISHED));
  });
});

describe("page metadata vs the route OG image", () => {
  // Next uses a route's opengraph-image only when the page metadata sets
  // no openGraph.images (Twitter then inherits it), so those pages leave
  // images out; pages without their own image keep the site card.
  it.each([
    ["build", buildMetadata(FIXTURE_BUILD_PUBLISHED)],
    ["unpublished build", buildMetadata(FIXTURE_BUILD_UNPUBLISHED)],
    ["counter", counterMetadata(FIXTURE_COUNTER_PUBLISHED)],
    ["matchup", matchupMetadata(FIXTURE_MATCHUP)],
  ])("%s pages defer to their opengraph-image", (_name, md) => {
    expect(md.openGraph).toBeDefined();
    expect(md.openGraph).not.toHaveProperty("images");
    expect(md.twitter).not.toHaveProperty("images");
    expect(md.twitter).toMatchObject({ card: "summary_large_image" });
  });

  it.each([
    ["hub", hubMetadata(FIXTURE_INDEX)],
    ["counter list", counterListMetadata(FIXTURE_MATCHUP)],
  ])("%s pages keep the site card", (_name, md) => {
    expect(md.openGraph).toHaveProperty("images");
    expect(md.twitter).toMatchObject({ images: ["/og.jpg"] });
  });
});
