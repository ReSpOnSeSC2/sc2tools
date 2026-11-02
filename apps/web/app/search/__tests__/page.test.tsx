import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enabled: true,
  published: new Set<string>() as ReadonlySet<string> | null,
  index: { kind: "ok", data: { maps: [{ map: "Fixture Station LE", slug: "fixture-station-le" }] } } as unknown,
  fetchPublishedGuidePaths: vi.fn(),
  fetchGuideIndex: vi.fn(),
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }),
}));
vi.mock("@/lib/guides/flags", () => ({ guidesEnabled: () => mocks.enabled }));
vi.mock("@/lib/guides/api", () => ({
  fetchPublishedGuidePaths: mocks.fetchPublishedGuidePaths, fetchGuideIndex: mocks.fetchGuideIndex,
}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));

import SearchPage, { dynamic, metadata } from "@/app/search/page";
import { createCommandGuideCatalog } from "@/lib/commandGuideSearch";

async function show(q?: string | string[]) {
  render(await SearchPage({ searchParams: Promise.resolve(q === undefined ? {} : { q }) }));
}
beforeEach(() => {
  mocks.enabled = true;
  mocks.published = new Set(["/guides/pvz/counter/12-pool", "/guides/maps/fixture-station-le"]);
  mocks.index = { kind: "ok", data: { maps: [{ map: "Fixture Station LE", slug: "fixture-station-le" }] } };
  mocks.fetchPublishedGuidePaths.mockReset().mockImplementation(async () => mocks.published);
  mocks.fetchGuideIndex.mockReset().mockImplementation(async () => mocks.index);
});
afterEach(() => { cleanup(); });

describe("/search", () => {
  it("is a per-request, noindex page with a fixed title and a strict-origin referrer", () => {
    expect(dynamic).toBe("force-dynamic");
    expect(metadata).toMatchObject({ title: "Search guides", robots: { index: false, follow: true }, referrer: "strict-origin",
      alternates: { canonical: "/search" } });
  });

  it("lists only published guides for the query, grouped, with the query echoed only in the field", async () => {
    await show("12 pool");
    const howToBeat = screen.getByRole("region", { name: "How to beat" });
    const link = within(howToBeat).getByRole("link", { name: /12 Pool/ });
    expect(link.getAttribute("href")).toBe("/guides/pvz/counter/12-pool");
    expect(screen.getByRole("searchbox").getAttribute("value")).toBe("12 pool");
    expect(screen.queryByText(/Not enough games yet/)).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("1 published guide matches.");
    expect(screen.getByRole("search", { name: "Search guides" }).getAttribute("action")).toBe("/search");
  });

  it("finds published map guides and notes when maps could not be checked", async () => {
    await show("fixture station");
    expect(within(screen.getByRole("region", { name: "Maps" })).getByRole("link").getAttribute("href"))
      .toBe("/guides/maps/fixture-station-le");
    cleanup();
    mocks.index = { kind: "unavailable" };
    await show("12 pool");
    expect(screen.getByText("Map guides couldn't be checked right now.")).toBeTruthy();
  });

  it("offers Retry, never an empty set, when publication is unknown", async () => {
    mocks.published = null;
    await show("12 pool");
    expect(screen.getByText("Guide search is temporarily unavailable.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Try again" }).getAttribute("href")).toBe("/search?q=12%20pool");
    expect(screen.queryByText(/No published guides match/)).toBeNull();
  });

  it("shows at most 30 rows a group and says when there are more", async () => {
    mocks.published = new Set(createCommandGuideCatalog({ publishedPaths: null }).map(row => row.id.slice("guide:".length)));
    await show("protoss");
    const openers = screen.getByRole("region", { name: "Openers" });
    expect(within(openers).getAllByRole("link")).toHaveLength(30);
    expect(within(openers).getByText("More matches in Openers. Add a matchup or another word.")).toBeTruthy();
  });

  it("says when nothing published matches", async () => {
    await show("zzzz-nothing");
    expect(screen.getByRole("status").textContent).toContain("No published guides match.");
    expect(screen.getByRole("link", { name: "all build guides" }).getAttribute("href")).toBe("/guides");
  });

  it.each([
    [undefined, null], [["a", "b"], null], ["\u0301", null], ["a".repeat(81), "Searches can be up to 80 characters."],
    ["bad\u0000query", "This search can't be used. Use letters, numbers and spaces."],
  ])("reads no guides for an empty, repeated, too long or invalid search %#", async (q, message) => {
    await show(q);
    expect(mocks.fetchPublishedGuidePaths).not.toHaveBeenCalled();
    expect(mocks.fetchGuideIndex).not.toHaveBeenCalled();
    if (message) expect(screen.getByRole("status").textContent).toBe(message);
    else expect(screen.getByRole("link", { name: "map guides" })).toBeTruthy();
  });

  it("is not found while guides are off", async () => {
    mocks.enabled = false;
    await expect(SearchPage({ searchParams: Promise.resolve({ q: "12 pool" }) })).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
