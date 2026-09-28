import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetchGuideMatchup: vi.fn() }));

vi.mock("@/lib/guides/api", () => ({ fetchGuideMatchup: mocks.fetchGuideMatchup }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" });
  },
  permanentRedirect: (path: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { path });
  },
}));

import MatchupGuidePage, { generateMetadata } from "@/app/guides/[matchup]/page";
import CounterListPage, { generateMetadata as counterListMetadata } from "@/app/guides/[matchup]/counter/page";
import { buildMatchupIntro } from "@/lib/guides/guideCopy";
import { FIXTURE_MATCHUP, FIXTURE_MATCHUP_BAND } from "@/lib/guides/__fixtures__";
import type { GuideMatchupPayload } from "@/lib/guides/types";

type Query = Record<string, string | string[] | undefined>;

function props(query: Query = {}) {
  return { params: Promise.resolve({ matchup: "pvz" }), searchParams: Promise.resolve(query) };
}

function ok(data: GuideMatchupPayload) {
  return { kind: "ok" as const, data };
}

beforeEach(() => vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "1"));
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  mocks.fetchGuideMatchup.mockReset();
});

describe("/guides/[matchup]", () => {
  it("titles the page with the real opener count and keeps the canonical query-free", async () => {
    mocks.fetchGuideMatchup.mockResolvedValue(ok(FIXTURE_MATCHUP_BAND));
    const md = await generateMetadata(props({ band: "league:4" }));
    expect(mocks.fetchGuideMatchup).toHaveBeenCalledWith("pvz", {
      band: { type: "league", value: 4 },
      era: "after",
    });
    expect(md.title).toBe(
      `PvZ build orders vs Diamond opponents — ${FIXTURE_MATCHUP_BAND.openers.length} openers ranked by win rate (Patch 5.0.16) | SC2 Tools`,
    );
    expect(md.alternates?.canonical).toBe("/guides/pvz");
    expect(String(md.description)).toContain("6,840 games");
  });

  it("ignores unknown filters", async () => {
    mocks.fetchGuideMatchup.mockResolvedValue(ok(FIXTURE_MATCHUP));
    await generateMetadata(props({ band: "league:99", era: "someday" }));
    expect(mocks.fetchGuideMatchup).toHaveBeenCalledWith("pvz", { band: null, era: "after" });
  });

  it("renders the ranked openers with CI whiskers, prevalence, n and trend", async () => {
    mocks.fetchGuideMatchup.mockResolvedValue(ok(FIXTURE_MATCHUP));
    render(await MatchupGuidePage(props()));
    expect(screen.getByRole("heading", { level: 1, name: "PvZ build orders" })).toBeTruthy();
    const table = screen.getByRole("table", { name: /PvZ openers/ });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(FIXTURE_MATCHUP.openers.length);
    expect(within(table).getAllByTestId("ci-whisker")).toHaveLength(FIXTURE_MATCHUP.openers.length);
    const first = FIXTURE_MATCHUP.openers[0];
    expect(within(rows[0]).getByRole("link", { name: first.name }).getAttribute("href")).toBe(
      `/guides/pvz/${first.buildSlug}`,
    );
    expect(rows[0].textContent).toContain(`${(first.winRate * 100).toFixed(1)}%`);
    expect(rows[0].textContent).toContain(String(first.games));
    expect(within(table).getByRole("columnheader", { name: "Played in" })).toBeTruthy();
    expect(within(table).queryByRole("link", { name: "Carrier Rush" })).toBeNull();
    for (const entry of buildMatchupIntro(FIXTURE_MATCHUP)) {
      expect(document.querySelector(`[data-copy-id="${entry.id}"]`)?.textContent).toBe(entry.text);
    }
  });

});

describe("/guides/[matchup] filters", () => {
  it("offers band and era links, the counters list and the latest videos", async () => {
    mocks.fetchGuideMatchup.mockResolvedValue(ok(FIXTURE_MATCHUP_BAND));
    render(await MatchupGuidePage(props({ band: "league:4" })));
    const nav = screen.getByRole("navigation", { name: "Filter openers" });
    expect(within(nav).getByRole("link", { name: "All" }).getAttribute("href")).toBe("/guides/pvz");
    const diamond = within(nav).getByRole("link", { name: "Diamond" });
    expect(diamond.getAttribute("href")).toBe("/guides/pvz?band=league:4");
    expect(diamond.getAttribute("aria-current")).toBe("page");
    expect(within(nav).getByRole("link", { name: "4500–5000 MMR" }).getAttribute("href")).toBe(
      "/guides/pvz?band=mmr:4500",
    );
    expect(within(nav).getByRole("link", { name: "Before 5.0.16" }).getAttribute("href")).toBe(
      "/guides/pvz?band=league:4&era=before",
    );
    expect(screen.queryByRole("columnheader", { name: "Played in" })).toBeNull();
    expect(screen.getByRole("link", { name: "How to beat 8 Pool" }).getAttribute("href")).toBe(
      "/guides/pvz/counter/8-pool",
    );
    expect(screen.queryByRole("link", { name: "How to beat Ling Bane Bust" })).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "Latest PvZ videos" })).toBeTruthy();
  });

});

describe("/guides/[matchup] states", () => {
  it("renders an unpublished matchup as 'Not enough games yet' (noindex)", async () => {
    const payload = { ...FIXTURE_MATCHUP, published: false, games: null, users: null, openers: [] };
    mocks.fetchGuideMatchup.mockResolvedValue(ok(payload));
    expect((await generateMetadata(props())).robots).toMatchObject({ index: false });
    const { container } = render(await MatchupGuidePage(props()));
    expect(screen.getByText("Not enough games yet")).toBeTruthy();
    expect(container.textContent ?? "").not.toMatch(/\d+(\.\d+)?%|\d[\d,]* games/);
  });

  it("permanently redirects an alias matchup slug", async () => {
    mocks.fetchGuideMatchup.mockResolvedValue({ kind: "moved", path: "/guides/pvz" });
    await expect(generateMetadata(props())).rejects.toMatchObject({ path: "/guides/pvz" });
    await expect(MatchupGuidePage(props())).rejects.toMatchObject({ path: "/guides/pvz" });
  });

  it("404s an unknown matchup from generateMetadata", async () => {
    mocks.fetchGuideMatchup.mockResolvedValue({ kind: "not_found" });
    await expect(generateMetadata(props())).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("/guides/[matchup]/counter", () => {
  it("lists every counter page, published ones with their game counts", async () => {
    mocks.fetchGuideMatchup.mockResolvedValue(ok(FIXTURE_MATCHUP));
    const md = await counterListMetadata({ params: Promise.resolve({ matchup: "pvz" }) });
    expect(md.title).toBe(
      "How to beat Zerg openers as Protoss (PvZ) — 3 counter guides (Patch 5.0.16) | SC2 Tools",
    );
    expect(md.alternates?.canonical).toBe("/guides/pvz/counter");
    render(await CounterListPage({ params: Promise.resolve({ matchup: "pvz" }) }));
    const pool = screen.getByRole("link", { name: "How to beat 8 Pool" });
    expect(pool.getAttribute("href")).toBe("/guides/pvz/counter/8-pool");
    expect(pool.closest("li")?.textContent).toContain("236 games");
    const lurker = screen.getByRole("link", { name: "How to beat Lurker Contain" });
    expect(lurker.closest("li")?.textContent).toContain("Not enough games yet");
  });

  it("keeps /counter when following a moved matchup and 404s when the flag is off", async () => {
    const params = { params: Promise.resolve({ matchup: "pvz" }) };
    mocks.fetchGuideMatchup.mockResolvedValue({ kind: "moved", path: "/guides/pvz" });
    await expect(counterListMetadata(params)).rejects.toMatchObject({ path: "/guides/pvz/counter" });
    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "");
    await expect(CounterListPage(params)).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
