import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ArcadeDataset } from "../types";
import type { AnyMode } from "../modes";
import { ModeRunner } from "../ModeRunner";

const mocks = vi.hoisted(() => ({
  data: null as ArcadeDataset | null, baseData: null as ArcadeDataset | null,
  generate: vi.fn(), retry: vi.fn(), recordPlay: vi.fn(), earnBadge: vi.fn(), rng: () => 0.5,
  apiData: {} as Record<string, unknown>, analysis: { items: [] as ArcadeDataset["games"], isLoading: false, error: null },
  custom: { data: { items: [] }, isLoading: false, error: null },
  policyResult: { policy: null as ArcadeDataset["sessionPolicy"], loading: true, error: null as string | null, retry: vi.fn() },
}));
vi.mock("../hooks/useArcadeData", () => ({ useArcadeData: () => ({
  data: mocks.data, baseData: mocks.baseData, loading: false, error: null, retrySessionPolicy: mocks.retry,
}) }));
vi.mock("@/lib/clientApi", () => ({ useApi: (path: string) => ({ data: mocks.apiData[path], isLoading: false, error: null }) }));
vi.mock("@/lib/session-policy", () => ({ useSessionPolicy: () => mocks.policyResult }));
vi.mock("../hooks/useAnalysisGames", () => ({ useAnalysisGames: () => mocks.analysis }));
vi.mock("@/components/builds/useCustomBuildCatalog", () => ({ useCustomBuildCatalog: () => mocks.custom }));
vi.mock("../hooks/useDailySeed", () => ({ useDailySeed: () => ({ day: "2026-10-27", tz: "UTC", rng: mocks.rng }) }));
vi.mock("../hooks/useArcadeState", () => ({ useArcadeState: () => ({
  recordPlay: mocks.recordPlay, earnBadge: mocks.earnBadge, state: { buildleByDay: {} },
}) }));
vi.mock("../ShareCard", () => ({ shareCard: vi.fn() }));
vi.mock("../surfaces/DailyEmptyState", () => ({ DailyEmptyState: () => <p>Daily unavailable</p> }));
const mode: AnyMode = {
  id: "synthetic-independent", kind: "quiz", category: "macro", difficulty: "easy", ttp: "fast", depthTag: "conditional",
  title: "Independent round", blurb: "A bounded synthetic mode", generate: mocks.generate,
  score: () => ({ raw: 1, xp: 10, outcome: "correct", note: "Recorded" }),
  render: ctx => <section><h2>{String(ctx.question)}</h2><output aria-label="Round state">{ctx.revealed ? "answered" : "unanswered"}</output>
    <button onClick={() => ctx.onAnswer("yes")}>Answer round</button></section>,
};
const player = { gapMinutes: 90, source: "auto-player" as const, storedGapMinutes: null };
const overlay = { gapMinutes: 240, source: "auto-overlay" as const, storedGapMinutes: null };
beforeEach(() => {
  mocks.baseData = { games: [], opponents: [], builds: [], customBuilds: [], communityBuilds: [], matchups: [], maps: [], summary: null, mapPool: [] };
  mocks.data = { ...mocks.baseData, sessionPolicy: null, sessionPolicyError: "Loading session settings" };
  mocks.apiData = {}; mocks.analysis = { items: [], isLoading: false, error: null };
  mocks.custom = { data: { items: [] }, isLoading: false, error: null };
  mocks.policyResult = { policy: null, loading: true, error: null, retry: vi.fn() };
  mocks.generate.mockReset().mockResolvedValue({ ok: true, minDataMet: true, question: "Stable recorded round" });
  mocks.retry.mockReset().mockResolvedValue(undefined); mocks.recordPlay.mockReset(); mocks.earnBadge.mockReset();
});
afterEach(cleanup);

it("retains a non-session round and answer when policy arrives or changes", async () => {
  const view = render(<ModeRunner mode={mode} isDaily={false} />);
  await screen.findByRole("heading", { name: "Stable recorded round" });
  fireEvent.click(screen.getByRole("button", { name: "Answer round" }));
  expect(screen.getByRole("status", { name: "Round state" }).textContent).toBe("answered");
  expect(mocks.generate).toHaveBeenCalledOnce(); expect(mocks.recordPlay).toHaveBeenCalledOnce();
  mocks.data = { ...mocks.baseData!, sessionPolicy: player }; view.rerender(<ModeRunner mode={mode} isDaily={false} />);
  await act(async () => {});
  mocks.data = { ...mocks.baseData!, sessionPolicy: overlay }; view.rerender(<ModeRunner mode={mode} isDaily={false} />);
  await act(async () => {});
  expect(mocks.generate).toHaveBeenCalledOnce(); expect(mocks.recordPlay).toHaveBeenCalledOnce();
  expect(screen.getByRole("status", { name: "Round state" }).textContent).toBe("answered");
});
it("keeps a session quiz unavailable with narrow retry until its policy is admitted", async () => {
  const sessionMode: AnyMode = { ...mode, id: "first-game-of-day" };
  const view = render(<ModeRunner mode={sessionMode} isDaily={false} />);
  await screen.findByText("Session settings unavailable"); expect(mocks.generate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Retry session settings" })); expect(mocks.retry).toHaveBeenCalledOnce();
  mocks.data = { ...mocks.baseData!, sessionPolicy: player }; view.rerender(<ModeRunner mode={sessionMode} isDaily={false} />);
  await screen.findByRole("heading", { name: "Stable recorded round" });
  expect(mocks.generate).toHaveBeenCalledOnce(); expect(mocks.generate.mock.calls[0][0].data.sessionPolicy).toEqual(player);
  mocks.data = { ...mocks.baseData!, sessionPolicy: overlay }; view.rerender(<ModeRunner mode={sessionMode} isDaily={false} />);
  await waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(2));
  expect(mocks.generate.mock.calls[1][0].data.sessionPolicy).toEqual(overlay);
});
it("still generates a new non-session round after its actual corpus data changes", async () => {
  const view = render(<ModeRunner mode={mode} isDaily={false} />);
  await screen.findByRole("heading", { name: "Stable recorded round" });
  mocks.baseData = { ...mocks.baseData!, games: [{ gameId: "new", date: "2026-10-27T00:00:00Z", result: "Victory" }] };
  mocks.data = { ...mocks.baseData, sessionPolicy: player }; view.rerender(<ModeRunner mode={mode} isDaily={false} />);
  await waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(2));
  expect(mocks.generate.mock.calls[1][0].data.games[0].gameId).toBe("new");
});

it("the real dataset hook keeps base identity stable while only policy metadata changes", async () => {
  const actual = await vi.importActual<typeof import("../hooks/useArcadeData")>("../hooks/useArcadeData");
  const view = renderHook(() => actual.useArcadeData());
  const base = view.result.current.baseData;
  expect(base).not.toBeNull(); expect(view.result.current.data?.sessionPolicy).toBeNull();
  mocks.policyResult = { ...mocks.policyResult, policy: player, loading: false };
  view.rerender(); expect(view.result.current.baseData).toBe(base); expect(view.result.current.data?.sessionPolicy).toEqual(player);
  mocks.policyResult = { ...mocks.policyResult, policy: overlay };
  view.rerender(); expect(view.result.current.baseData).toBe(base); expect(view.result.current.data?.sessionPolicy).toEqual(overlay);
  mocks.analysis = { ...mocks.analysis, items: [{ gameId: "new", date: "2026-10-27T00:00:00Z", result: "Victory" }] };
  view.rerender(); expect(view.result.current.baseData).not.toBe(base); expect(view.result.current.baseData?.games[0].gameId).toBe("new");
});
