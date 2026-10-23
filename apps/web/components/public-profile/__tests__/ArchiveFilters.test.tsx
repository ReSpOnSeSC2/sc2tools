import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { archiveFilterLabels, archiveHref, parseArchiveQuery } from "../archiveQuery";
import { ArchiveFilterEnhancer } from "../ArchiveFilterEnhancer";
import { PublicReplayLibrary } from "../PublicReplayLibrary";
import type { ReplayLibraryResponse } from "@/components/analyzer/replays/types";

vi.mock("../PublicReplayShareButton", () => ({ PublicReplayShareButton: () => null }));
vi.mock("@/components/analyzer/replays/ReplayList", () => ({ ReplayList: ({ emptyTitle }: { emptyTitle: string }) => <p>{emptyTitle}</p> }));
const data: ReplayLibraryResponse = { profile: { handle: "player", displayName: "Player" }, items: Array.from({ length: 25 }, (_, i) => ({ gameId: String(i) })), page: { hasMore: true, nextCursor: "next/cursor" }, summary: { total: 312, wins: 180, losses: 129, ties: 3, avgDurationSec: 785 }, facets: { matchups: ["PvZ", "TvP"], maps: ["Alcyone LE", "Oceanborn LE"] } };
beforeEach(() => vi.useRealTimers());
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); history.replaceState(null, "", "/"); });

it("bounds and allowlists every archive key and drops invalid values", () => {
  const query = parseArchiveQuery({ search: "  rush  ", result: ["loss", "win"], matchup: "PvZ", map: "  Alcyone  ", range: "30d", build: "B".repeat(150), sort: "date_asc", cursor: "C".repeat(600), page: "3", notice: "page-expired", ignored: "private" });
  expect(query).toMatchObject({ search: "rush", result: "loss", matchup: "PvZ", map: "Alcyone", range: "30d", sort: "date_asc", page: 3 });
  expect(query.build).toHaveLength(120); expect(query.cursor).toHaveLength(512);
  const url = new URL(archiveHref("/archive", query), "https://example.test"); expect(url.searchParams.has("ignored")).toBe(false); expect(url.searchParams.has("notice")).toBe(false);
  expect(parseArchiveQuery({ result: "evil", matchup: "PvZ$", range: "forever", page: "1001", map: {} })).toMatchObject({ result: undefined, matchup: undefined, range: undefined, page: undefined, map: undefined, sort: "date_desc" });
});

it("chips remove exactly their key and pagination; Clear all removes the whole view", () => {
  const query = parseArchiveQuery({ search: "rush", matchup: "PvZ", result: "loss", map: "Alcyone", range: "7d", build: "Blink", sort: "date_asc", cursor: "old", page: "3", notice: "page-expired" });
  render(<PublicReplayLibrary data={data} query={query} />);
  const nav = screen.getByRole("navigation", { name: "Active replay filters" });
  for (const { key, label } of archiveFilterLabels(query)) {
    const href = within(nav).getByRole("link", { name: `Remove filter: ${label}` }).getAttribute("href")!;
    const next = new URL(href, "https://example.test").searchParams;
    expect(next.has(key)).toBe(false); expect(next.has("cursor")).toBe(false); expect(next.has("page")).toBe(false); expect(next.has("notice")).toBe(false);
    for (const other of archiveFilterLabels(query).filter((item) => item.key !== key)) expect(next.get(other.key)).toBe(query[other.key]);
  }
  expect(within(nav).getByRole("link", { name: "Clear all" }).getAttribute("href")).toBe("/players/player/replays");
});

it("keeps facet choices stable while retaining unknown current values and falling back to all matchups", () => {
  const view = render(<PublicReplayLibrary data={data} query={{ matchup: "ZvR", map: "Unknown map" }} />);
  const select = screen.getByRole("combobox", { name: "Matchup" }); expect(within(select).getAllByRole("option").map((option) => option.textContent)).toEqual(["All matchups", "PvZ", "TvP", "ZvR"]); expect((select as HTMLSelectElement).value).toBe("ZvR");
  expect((screen.getByRole("combobox", { name: "Map" }) as HTMLSelectElement).value).toBe("Unknown map");
  view.rerender(<PublicReplayLibrary data={{ ...data, facets: undefined }} query={{}} />); expect(within(screen.getByRole("combobox", { name: "Matchup" })).getAllByRole("option")).toHaveLength(13);
});

it.each(["date_desc", "date_asc"] as const)("pager follows %s order and focuses the results hash", (sort) => {
  history.replaceState(null, "", "#replay-results"); render(<PublicReplayLibrary data={data} query={{ cursor: "old", page: 3, sort }} />);
  expect(screen.getByText("Page 3 · Showing 51–75")).toBeTruthy();
  const next = new URL(screen.getByRole("link", { name: `${sort === "date_asc" ? "Newer" : "Older"} replays` }).getAttribute("href")!, "https://example.test"); expect(next.searchParams.get("page")).toBe("4"); expect(next.hash).toBe("#replay-results");
  const reset = new URL(screen.getByRole("link", { name: `Back to ${sort === "date_asc" ? "oldest" : "newest"}` }).getAttribute("href")!, "https://example.test"); expect(reset.searchParams.has("cursor")).toBe(false); expect(reset.searchParams.has("page")).toBe(false); expect(reset.hash).toBe("#replay-results");
  expect(document.activeElement).toBe(screen.getByRole("region", { name: "Replay results" }));
});

it("renders accurate filtered records, tie counts and honest old-link paging", () => {
  const view = render(<PublicReplayLibrary data={data} query={{}} />);
  expect(screen.getByLabelText("Filtered replay record").textContent).toBe("312 replays · 180–129 · 58% · 3 ties · avg 13:05");
  view.rerender(<PublicReplayLibrary data={data} query={{ matchup: "PvZ", result: "loss", cursor: "legacy" }} />);
  expect(screen.getByLabelText("Filtered replay record").textContent).toBe("PvZ · Losses: 312 replays · 3 ties · avg 13:05"); expect(screen.getByText("Showing more")).toBeTruthy();
  expect(new URL(screen.getByRole("link", { name: "Older replays" }).getAttribute("href")!, "https://example.test").searchParams.has("page")).toBe(false);
  view.rerender(<PublicReplayLibrary data={{ ...data, items: [], summary: { ...data.summary!, total: 0 } }} query={{ map: "Unknown" }} />); expect(screen.queryByLabelText("Filtered replay record")).toBeNull(); expect(screen.getByText("No replays match these filters")).toBeTruthy(); expect(screen.getByRole("link", { name: "Remove filter: Map: Unknown" })).toBeTruthy(); expect(screen.queryByRole("link", { name: "Clear all" })).toBeNull();
});

it("does not invent page positions for a bare page number or after the bounded counter ends", () => {
  const view = render(<PublicReplayLibrary data={data} query={{ page: 3 }} />); expect(screen.getByText("Page 1 · Showing 1–25")).toBeTruthy();
  view.rerender(<PublicReplayLibrary data={data} query={{ cursor: "old", page: 1000 }} />);
  expect(new URL(screen.getByRole("link", { name: "Older replays" }).getAttribute("href")!, "https://example.test").searchParams.has("page")).toBe(false);
});

function Form({ children }: { children?: ReactNode }) { return <ArchiveFilterEnhancer action="/archive" build="Blink">{children || <label>Result<select name="result"><option value="">All</option><option value="win">Wins</option></select></label>}</ArchiveFilterEnhancer>; }

it("keeps a native Apply action for no-JS visitors and hides it after hydration", () => {
  const html = renderToStaticMarkup(<Form />); expect(html).toContain('method="get"'); expect(html).toContain('type="submit"'); expect(html).not.toContain('hidden=""');
  render(<Form />); expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
});

it("submits select changes immediately and search after 400ms, while one character waits", async () => {
  vi.useFakeTimers(); const submit = vi.spyOn(HTMLFormElement.prototype, "requestSubmit").mockImplementation(() => {}); render(<Form />);
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "win" } }); expect(submit).toHaveBeenCalledTimes(1);
  const input = screen.getByRole("searchbox"); fireEvent.change(input, { target: { value: "r" } }); await act(async () => vi.advanceTimersByTime(500)); expect(submit).toHaveBeenCalledTimes(1);
  fireEvent.change(input, { target: { value: "rush" } }); await act(async () => vi.advanceTimersByTime(399)); expect(submit).toHaveBeenCalledTimes(1); await act(async () => vi.advanceTimersByTime(1)); expect(submit).toHaveBeenCalledTimes(2);
  fireEvent.change(input, { target: { value: "rush more" } }); fireEvent.click(screen.getByRole("button", { name: "Clear search" })); expect(submit).toHaveBeenCalledTimes(3); expect((input as HTMLInputElement).value).toBe(""); await act(async () => vi.advanceTimersByTime(500)); expect(submit).toHaveBeenCalledTimes(3);
  const values = new FormData(screen.getByRole("search") as HTMLFormElement); expect(values.get("build")).toBe("Blink"); expect(values.has("cursor")).toBe(false); expect(values.has("page")).toBe(false);
});
