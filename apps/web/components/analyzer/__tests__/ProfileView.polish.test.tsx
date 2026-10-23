import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const harness = vi.hoisted(() => ({ rev: 7, error: null as unknown, api: vi.fn(), retry: vi.fn(), refresh: vi.fn(async (_predicate?: unknown) => []), toast: vi.fn() }));
vi.mock("swr", () => ({ useSWRConfig: () => ({ mutate: harness.refresh }) }));
vi.mock("@/lib/filterContext", async (load) => ({ ...await load<typeof import("@/lib/filterContext")>(), useFilters: () => ({ filters: {}, dbRev: harness.rev }) }));
vi.mock("@/lib/useMyDisplayName", () => ({ useMyDisplayName: () => "Me" }));
vi.mock("@/lib/useLocalStorageState", () => ({ useLocalStorageState: () => [true, vi.fn()] }));
vi.mock("@/components/ui/Toast", () => ({ useToastOptional: () => ({ toast: { success: harness.toast, info: harness.toast } }) }));
vi.mock("../usePlayerChannels", () => ({ usePlayerChannels: () => () => undefined }));
vi.mock("../OpponentNotesCard", () => ({ OpponentNotesCard: () => <section aria-label="Notes" /> }));
vi.mock("../OpponentReplayHistory", () => ({ OpponentReplayHistory: ({ path }: { path: string }) => <section aria-label="Replay history" data-path={path} /> }));
vi.mock("../OpponentIdentityCandidates", () => ({ OpponentIdentityCandidates: () => null }));
vi.mock("../OpponentIdentitySubmission", () => ({ OpponentIdentitySubmission: () => null }));
vi.mock("../LadderContextCard", () => ({ LadderContextCard: () => null }));
vi.mock("../OpponentDiagnosticsPanel", () => ({ OpponentDiagnosticsPanel: ({ onRetried }: { onRetried: (response: unknown) => void }) => <button onClick={() => onRetried({ resolvedPulseCharacterId: true })}>Finish Pulse retry</button> }));
vi.mock("../StrategyTendencyChart", () => ({ StrategyTendencyChart: () => null }));
vi.mock("../PredictedStrategiesList", () => ({ PredictedStrategiesList: () => null }));
vi.mock("../h2h/H2HTrendsSection", () => ({ H2HTrendsSection: ({ onSelectBuildMatchup }: { onSelectBuildMatchup: (selection: unknown) => void }) => <button onClick={() => onSelectBuildMatchup({ myBuild: "Blink", oppStrategy: "Macro" })}>Select build pairing</button> }));
vi.mock("@/lib/clientApi", () => ({ useApi: (...args: unknown[]) => harness.api(...args) }));
import { ProfileView } from "../ProfileView";
const profile = { name: "Rival", pulseCharacterId: "123", totals: { total: 2, wins: 1, losses: 1, winRate: .5 },
  byMap: { Alcyone: { wins: 1, losses: 0 }, River: { wins: 0, losses: 1 } }, byStrategy: { Macro: { wins: 1, losses: 0 }, Cheese: { wins: 0, losses: 1 } },
  games: [{ id: "one", map: "Alcyone", my_build: "Blink", opp_strategy: "Macro", result: "Victory" }, { id: "two", map: "River", my_build: "Expand", opp_strategy: "Cheese", result: "Defeat" }],
  phases: { finalPhaseDistribution: { mid: 2 } } };
beforeEach(() => { harness.rev = 7; harness.error = null; harness.refresh.mockClear(); harness.toast.mockClear(); harness.retry.mockClear(); harness.api.mockReset();
  harness.api.mockImplementation((path: string | null) => path?.startsWith("/v1/opponents/target?")
    ? { data: profile, error: harness.error, isLoading: false, mutate: harness.retry } : { data: undefined }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("debounces database revisions, retains data after refresh errors, and retries", () => {
  vi.useFakeTimers(); const view = render(<ProfileView pulseId="target" onBack={() => undefined} />);
  expect(harness.api).toHaveBeenCalledWith("/v1/opponents/target?mergeLinked=1#7", { keepPreviousData: true });
  harness.rev = 8; view.rerender(<ProfileView pulseId="target" onBack={() => undefined} />);
  expect(harness.api.mock.calls.some(([path]) => String(path).endsWith("#8"))).toBe(false);
  act(() => vi.advanceTimersByTime(2000));
  expect(harness.api).toHaveBeenCalledWith("/v1/opponents/target?mergeLinked=1#8", { keepPreviousData: true });
  harness.error = { status: 503 }; view.rerender(<ProfileView pulseId="target" onBack={() => undefined} />);
  expect(screen.getByRole("heading", { name: "Rival" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry" })); expect(harness.retry).toHaveBeenCalledOnce();
});
it("shows clearable map/strategy/build filters and keeps replay history immediately above notes", () => {
  render(<ProfileView pulseId="target" onBack={() => undefined} />);
  fireEvent.click(screen.getByRole("button", { name: /Alcyone/ }));
  expect(screen.getByText("Games (filtered)")).toBeTruthy();
  expect(screen.getAllByText("All games, not filtered")).toHaveLength(3);
  expect(screen.getByLabelText("Replay history").getAttribute("data-path")).toContain("map=Alcyone");
  fireEvent.click(screen.getByRole("button", { name: "Remove map filter Alcyone" }));
  fireEvent.click(screen.getByRole("button", { name: /Cheese/ }));
  expect(screen.getByRole("button", { name: "Remove strategy filter Cheese" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Select build pairing" }));
  const bar = screen.getByRole("region", { name: "Active dossier filters" });
  expect(within(bar).queryByRole("button", { name: /Remove strategy/ })).toBeNull();
  expect(within(bar).getByRole("button", { name: /Remove build/ })).toBeTruthy();
  fireEvent.click(within(bar).getByRole("button", { name: "Clear all" }));
  expect(screen.queryByRole("region", { name: "Active dossier filters" })).toBeNull();
  expect(screen.getByLabelText("Replay history").nextElementSibling).toBe(screen.getByLabelText("Notes"));
});
it("refreshes all of this opponent's resources and channels after Pulse retry", async () => {
  render(<ProfileView pulseId="target" onBack={() => undefined} />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Finish Pulse retry" })));
  const predicate = harness.refresh.mock.calls[0][0] as (key: unknown) => boolean;
  expect(predicate(["authenticated-api", "user", "/v1/opponents/target/pulse-races"])).toBe(true);
  expect(predicate(["authenticated-api", "user", "/v1/opponents/other"])).toBe(false);
  expect(predicate(["player-channels", "identities"])).toBe(true);
  expect(harness.toast).toHaveBeenCalledWith("Pulse data refreshed");
});
