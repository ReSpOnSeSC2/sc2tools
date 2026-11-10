import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { reportFixtures } from "@/lib/battleReport/__tests__/fixtures";
import { battleReportFacts } from "@/lib/battleReport/facts";
import { planBattleReport } from "@/lib/battleReport/plan";
import { sharedReportInput, type SharedGameAnalysis } from "@/lib/sharedGame";
import { ShareReportDialog } from "../ShareReportDialog";

const h = vi.hoisted(() => ({ fetch: vi.fn(), writeText: vi.fn(), live: false }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: "owner", isLoaded: true, isSignedIn: true, getToken: async () => "owner-token" }) }));

const GAME_ID = "2026-10-20T12:00:00|SecretFoe#1234|Fixture|960";
const TOKEN = "AbCdEfGhIjKlMnOp";
const SHARED: SharedGameAnalysis = {
  game: {
    matchup: "ZvP", myRace: "Zerg", oppRace: "Protoss", map: "Fixture comeback", result: "Win", durationSec: 960, playedOn: "2026-10-20",
    myBuild: "Zerg replay opening", oppStrategy: null, macroScore: 70, apm: null, spq: null, playerLabel: "Zerg player", playerMmr: 4200,
    playerBand: null, opponentLabel: "Opponent (Protoss, ~4,100 MMR)", opponentMmr: 4100, opponentBand: null, matchFormat: "1v1", playerCount: 2,
  },
  macroBreakdown: reportFixtures[3].breakdown ?? null,
  buildOrder: null,
  playback: { mode: "none" },
  benchmark: null,
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const share = { token: TOKEN, gameId: GAME_ID, url: `/g/${TOKEN}`, active: true, createdAt: "2026-11-10T10:00:00Z", revokedAt: null, viewCount: 0, lastViewedAt: null };

beforeEach(() => {
  h.live = false;
  h.writeText.mockReset().mockResolvedValue(undefined);
  h.fetch.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === `/v1/games/${encodeURIComponent(GAME_ID)}/shares` && init?.method === "POST") { h.live = true; return json({ share, created: true }, 201); }
    if (path === `/v1/games/${encodeURIComponent(GAME_ID)}/shares`) return json({ shares: h.live ? [share] : [], activeCount: h.live ? 1 : 0, limit: 200 });
    if (path === `/v1/shares/${TOKEN}`) return json(SHARED);
    return json({}, 404);
  });
  vi.stubGlobal("fetch", h.fetch);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: h.writeText } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("ShareReportDialog", () => {
  it("creates the link only when asked, previews exactly what the link serves and copies a link to the report", async () => {
    render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><ShareReportDialog gameId={GAME_ID} open onClose={vi.fn()} /></SWRConfig>);
    const create = await screen.findByRole("button", { name: "Create share link" });
    expect(h.fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    fireEvent.click(create);
    const expected = planBattleReport(battleReportFacts(sharedReportInput(SHARED, `share-${TOKEN}`)), "battle");
    expect(await screen.findByRole("heading", { name: expected.headline })).toBeTruthy();
    expect(screen.getByRole("article", { name: "Report preview" }).textContent).not.toMatch(/SecretFoe|\byou\b/i);
    fireEvent.click(screen.getByRole("button", { name: "Copy report link" }));
    await waitFor(() => expect(h.writeText).toHaveBeenCalledWith(`${window.location.origin}/g/${TOKEN}#battle-report`));
  });
});
