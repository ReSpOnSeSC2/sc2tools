import { beforeEach, expect, it, vi } from "vitest";

// React's client test build has no server cache dispatcher. Emulate a fresh
// render's identity-based memo table, keeping object arguments distinct, so
// these tests check that metadata/page actually share primitive cache keys.
const mocks = vi.hoisted(() => ({ tables: [] as Array<Array<{ args: unknown[]; value: unknown }>>, getJson: vi.fn(), apiFetch: vi.fn() }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  cache: (fn: (...args: unknown[]) => unknown) => {
    const table: Array<{ args: unknown[]; value: unknown }> = []; mocks.tables.push(table);
    return (...args: unknown[]) => {
      const found = table.find((item) => item.args.length === args.length && item.args.every((arg, index) => arg === args[index]));
      if (found) return found.value;
      const value = fn(...args); table.push({ args, value }); return value;
    };
  },
}));
vi.mock("@/lib/serverApi", () => ({ getJsonWithStatus: (...args: unknown[]) => mocks.getJson(...args) }));
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => mocks.apiFetch(...args) }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("not-found"); }, redirect: () => { throw new Error("redirect"); } }));

import ProfilePage, { generateMetadata as profileMetadata } from "@/app/players/[player]/page";
import ArchivePage, { generateMetadata as archiveMetadata } from "@/app/players/[player]/replays/page";
import AnalysisPage, { generateMetadata as analysisMetadata } from "@/app/players/[player]/replays/[gameId]/page";

beforeEach(() => { for (const table of mocks.tables) table.length = 0; mocks.getJson.mockReset(); mocks.apiFetch.mockReset(); });
it("shares one fresh consent read between metadata and the page", async () => {
  mocks.getJson.mockResolvedValue({ status: 200, data: { archiveOnly: false, handle: "player-0123456789", displayName: "Player", profile: { handle: "player-0123456789", displayName: "Player", totals: { games: 0 }, matchups: [], signatureBuilds: [] } } });
  await profileMetadata({ params: Promise.resolve({ player: "player-0123456789" }) });
  await ProfilePage({ params: Promise.resolve({ player: "player-0123456789" }) });
  expect(mocks.getJson).toHaveBeenCalledTimes(1);
  expect(mocks.getJson).toHaveBeenCalledWith("/v1/public/players/player-0123456789", expect.objectContaining({ revalidateSec: 0, signal: expect.any(AbortSignal) }));
});
it("shares an archive read with matching filters despite separately parsed query objects", async () => {
  mocks.getJson.mockResolvedValue({ status: 200, data: { profile: { handle: "player", displayName: "Player" }, items: [], page: { hasMore: false } } });
  await archiveMetadata({ params: Promise.resolve({ player: "player" }), searchParams: Promise.resolve({ result: "win", cursor: "page-two" }) });
  await ArchivePage({ params: Promise.resolve({ player: "player" }), searchParams: Promise.resolve({ result: "win", cursor: "page-two", notice: "page-expired" }) });
  expect(mocks.getJson).toHaveBeenCalledTimes(1);
  expect(mocks.getJson).toHaveBeenCalledWith("/v1/public/replays/player?limit=25&sort=date_desc&result=win&cursor=page-two");
});
it("shares one authenticated analysis read between metadata and the page", async () => {
  mocks.apiFetch.mockResolvedValue({ ok: true, status: 200, data: { profile: { handle: "player" }, game: { gameId: "game/42" } } });
  await analysisMetadata({ params: Promise.resolve({ player: "player", gameId: "game/42" }) });
  await AnalysisPage({ params: Promise.resolve({ player: "player", gameId: "game/42" }) });
  expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
  expect(mocks.apiFetch).toHaveBeenCalledWith("/v1/public/replays/player/game%2F42");
});

it("shares filtered analysis metadata/page reads and resolves rolling dates once", async () => {
  mocks.apiFetch.mockResolvedValue({ ok: true, status: 200, data: { profile: { handle: "player" }, game: { gameId: "game/42" } } });
  await analysisMetadata({ params: Promise.resolve({ player: "player", gameId: "game/42" }), searchParams: Promise.resolve({ from: "result=loss&range=7d&cursor=old&page=3" }) });
  await AnalysisPage({ params: Promise.resolve({ player: "player", gameId: "game/42" }), searchParams: Promise.resolve({ from: "page=3&cursor=old&range=7d&result=loss&ignored=drop" }) });
  expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
  const url = new URL(mocks.apiFetch.mock.calls[0][0], "https://example.test"); expect(url.searchParams.get("result")).toBe("loss"); expect(url.searchParams.has("since")).toBe(true); expect(url.searchParams.has("until")).toBe(true); expect(url.searchParams.has("cursor")).toBe(false); expect(url.searchParams.has("page")).toBe(false);
});
