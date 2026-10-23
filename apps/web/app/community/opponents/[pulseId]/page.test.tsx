import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The public opponent profile: 404 + noindex below the player floor,
 * the error boundary (noindex) on an outage, and a profile that never
 * shows the toon handle. All data is synthetic.
 */
const mocks = vi.hoisted(() => ({
  getJsonWithStatus: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("@/lib/serverApi", () => ({ getJsonWithStatus: mocks.getJsonWithStatus }));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@/components/ui/Icon", () => ({ Icon: () => null }));

import CommunityOpponentPage, { generateMetadata } from "@/app/community/opponents/[pulseId]/page";

const TOON = "2-S2-1-4242";
const params = () => Promise.resolve({ pulseId: TOON });

function aggregate(overrides: Record<string, unknown> = {}) {
  return {
    pulseId: TOON,
    pulseCharacterId: "994428",
    race: "Zerg",
    contributors: 6,
    games: 40,
    wins: 22,
    losses: 18,
    winRate: 0.55,
    openings: {},
    strategies: { "Ling Flood": 6, "Roach Ravager": 12, "12 Pool": 2 },
    byMap: {
      "Alcyone": { wins: 2, losses: 1 },
      "Goldenaura": { wins: 10, losses: 9 },
      "Inside and Out": { wins: 5, losses: 3 },
    },
    ...overrides,
  };
}

async function renderPage(data = aggregate()) {
  mocks.getJsonWithStatus.mockResolvedValue({ data, status: 200 });
  return render(await CommunityOpponentPage({ params: params() }));
}

afterEach(() => {
  cleanup();
  mocks.getJsonWithStatus.mockReset();
  mocks.notFound.mockClear();
});

describe("/community/opponents/[pulseId]", () => {
  it("is a 404 below the player floor, in the page and the metadata", async () => {
    mocks.getJsonWithStatus.mockResolvedValue({ data: null, status: 404 });
    await expect(CommunityOpponentPage({ params: params() })).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(generateMetadata({ params: params() })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("never publishes an aggregate with too few players, even if the API sends one", async () => {
    mocks.getJsonWithStatus.mockResolvedValue({ data: aggregate({ contributors: 4 }), status: 200 });
    await expect(CommunityOpponentPage({ params: params() })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it.each([null, 503])("sends an outage (%s) to the error boundary with noindex, never 'not enough data'", async (status) => {
    mocks.getJsonWithStatus.mockResolvedValue({ data: null, status });
    await expect(CommunityOpponentPage({ params: params() })).rejects.toThrow("community_opponent_unavailable");
    expect(mocks.notFound).not.toHaveBeenCalled();
    const metadata = await generateMetadata({ params: params() });
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("titles the page by race and Pulse id, never the toon handle, and is indexable", async () => {
    mocks.getJsonWithStatus.mockResolvedValue({ data: aggregate(), status: 200 });
    const metadata = await generateMetadata({ params: params() });
    expect(metadata.title).toBe("Zerg opponent · Pulse #994428 · Community");
    expect(metadata.robots).toEqual({ index: true, follow: true });
    const { container } = await renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "Zerg opponent scouting profile" })).toBeTruthy();
    expect(container.textContent).not.toContain(TOON);
    expect(String(metadata.title)).not.toContain(TOON);
  });

  it("uses the community back link and eyebrow", async () => {
    await renderPage();
    expect(screen.getByRole("link", { name: "Back to community" }).getAttribute("href")).toBe("/community");
    expect(screen.getByText("Community · Opponent profile")).toBeTruthy();
  });

  it("labels every win/loss as the opponent's side", async () => {
    await renderPage();
    expect(screen.getAllByText("From the opponent's side")).toHaveLength(2);
    const table = screen.getByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Their W–L" })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: "Their win rate" })).toBeTruthy();
    expect(table.querySelector("caption")?.textContent).toContain("from the opponent's side");
  });

  it("sorts maps by games, most first, inside a scroll container", async () => {
    await renderPage();
    const table = screen.getByRole("table");
    const maps = within(table).getAllByRole("rowheader").map((cell) => cell.textContent);
    expect(maps).toEqual(["Goldenaura", "Inside and Out", "Alcyone"]);
    expect(table.parentElement?.className).toContain("overflow-x-auto");
  });

  it("shows strategies as shares with percentages and drops the openings card", async () => {
    await renderPage();
    expect(screen.getByText("Roach Ravager")).toBeTruthy();
    // 12 of the 20 games with a recognised strategy.
    expect(screen.getByText("60%")).toBeTruthy();
    expect(screen.queryByText(/Most-shown openings/)).toBeNull();
  });
});
