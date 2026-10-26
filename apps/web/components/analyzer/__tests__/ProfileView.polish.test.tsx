import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const harness = vi.hoisted(() => ({ ownerId: "owner-a" as string | null, filters: {} as import("@/lib/filterContext").AnalyzerFilters, rev: 7, error: null as unknown, api: vi.fn(), retry: vi.fn(), refresh: vi.fn(async (_predicate?: unknown) => []), toast: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: harness.ownerId, isLoaded: true, isSignedIn: !!harness.ownerId, getToken: async () => "token" }) }));
vi.mock("swr", () => ({ useSWRConfig: () => ({ mutate: harness.refresh }) }));
vi.mock("@/lib/filterContext", async (load) => ({ ...await load<typeof import("@/lib/filterContext")>(), useFilters: () => ({ filters: harness.filters, seasons: [], dbRev: harness.rev }) }));
vi.mock("@/lib/useMyDisplayName", () => ({ useMyDisplayName: () => "Me" }));
vi.mock("@/lib/useOpponentScoutingPreference", () => ({ useOpponentScoutingPreference: () => ({ groupByPlayer: true, setGroupByPlayer: vi.fn(), loading: false, saving: false, unavailable: false, error: "", retry: vi.fn() }) }));
vi.mock("@/components/ui/Toast", () => ({ useToastOptional: () => ({ toast: { success: harness.toast, info: harness.toast } }) }));
vi.mock("../usePlayerChannels", () => ({ usePlayerChannels: () => () => undefined }));
vi.mock("../OpponentNotesCard", () => ({ OpponentNotesCard: () => <section aria-label="Notes" /> }));
vi.mock("../OpponentReplayHistory", () => ({ OpponentReplayHistory: ({ path }: { path: string }) => <section aria-label="Replay history" data-path={path} /> }));
vi.mock("../OpponentIdentityCandidates", () => ({ OpponentIdentityCandidates: () => null }));
vi.mock("../OpponentIdentitySubmission", () => ({ OpponentIdentitySubmission: () => null }));
vi.mock("../LadderContextCard", () => ({ LadderContextCard: () => null }));
vi.mock("../OpponentDiagnosticsPanel", () => ({ OpponentDiagnosticsPanel: ({ onRetried }: { onRetried: (response: unknown) => void }) => <button onClick={() => onRetried({ resolvedPulseCharacterId: true })}>Finish Pulse retry</button> }));
vi.mock("../StrategyTendencyChart", () => ({ StrategyTendencyChart: () => null }));
vi.mock("../DossierAnalysisSection", () => ({ DossierAnalysisSection: ({ onSelect, path }: { onSelect: (value: unknown) => void; path: string }) => <button data-path={path} onClick={() => onSelect({ token: "SpawningPool", label: "Spawning Pool", source: "opp_build_log", gameIds: ["one"] })}>Select timing sample</button> }));
vi.mock("../PredictedStrategiesList", () => ({ PredictedStrategiesList: () => null }));
vi.mock("../h2h/H2HTrendsSection", () => ({ H2HTrendsSection: ({ onSelectBuildMatchup }: { onSelectBuildMatchup: (selection: unknown) => void }) => <button onClick={() => onSelectBuildMatchup({ myBuild: "Blink", oppStrategy: "Macro" })}>Select build pairing</button> }));
vi.mock("@/lib/clientApi", () => ({ useApi: (...args: unknown[]) => harness.api(...args) }));
import { ProfileView } from "../ProfileView";
const profile = { name: "Rival", pulseCharacterId: "123", totals: { total: 2, wins: 1, losses: 1, winRate: .5 },
  byMap: { Alcyone: { wins: 1, losses: 0 }, River: { wins: 0, losses: 1 } }, byStrategy: { Macro: { wins: 1, losses: 0 }, Cheese: { wins: 0, losses: 1 } },
  games: [{ id: "one", map: "Alcyone", my_build: "Blink", opp_strategy: "Macro", result: "Victory" }, { id: "two", map: "River", my_build: "Expand", opp_strategy: "Cheese", result: "Defeat" }],
  phases: { finalPhaseDistribution: { mid: 2 } } };
beforeEach(() => { harness.ownerId = "owner-a"; window.history.replaceState(null, "", "/app/opponents/target"); harness.filters = {}; harness.rev = 7; harness.error = null; harness.refresh.mockClear(); harness.toast.mockClear(); harness.retry.mockClear(); harness.api.mockReset();
  harness.api.mockImplementation((path: string | null) => path?.startsWith("/v1/opponents/target?")
    ? { data: profile, error: harness.error, isLoading: false, mutate: harness.retry } : { data: undefined }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("debounces database revisions, retains data after refresh errors, and retries", () => {
  vi.useFakeTimers(); const view = render(<ProfileView pulseId="target" onBack={() => undefined} />);
  expect(harness.api).toHaveBeenCalledWith("/v1/opponents/target?mergeLinked=1#7", { keepPreviousData: true, shouldRetryOnError: false });
  harness.rev = 8; view.rerender(<ProfileView pulseId="target" onBack={() => undefined} />);
  expect(harness.api.mock.calls.some(([path]) => String(path).endsWith("#8"))).toBe(false);
  act(() => vi.advanceTimersByTime(2000));
  expect(harness.api).toHaveBeenCalledWith("/v1/opponents/target?mergeLinked=1#8", { keepPreviousData: true, shouldRetryOnError: false });
  harness.error = { status: 503 }; view.rerender(<ProfileView pulseId="target" onBack={() => undefined} />);
  expect(screen.getByRole("heading", { name: "Rival" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry" })); expect(harness.retry).toHaveBeenCalledOnce();
});
it("shows clearable map/strategy/build filters and keeps replay history immediately above notes", () => {
  render(<ProfileView pulseId="target" onBack={() => undefined} />);
  fireEvent.click(screen.getByRole("button", { name: /Alcyone/ }));
  expect(screen.getByText("Games (filtered)")).toBeTruthy();
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
  fireEvent.click(screen.getByRole("link", { name: "Data looks wrong?" }));
  await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Finish Pulse retry" })));
  const predicate = harness.refresh.mock.calls[0][0] as (key: unknown) => boolean;
  expect(predicate(["authenticated-api", "user", "/v1/opponents/target/pulse-races"])).toBe(true);
  expect(predicate(["authenticated-api", "user", "/v1/opponents/target/analysis?race=P#7"])).toBe(true);
  expect(predicate(["authenticated-api", "user", "/v1/opponents/other"])).toBe(false);
  expect(predicate(["player-channels", "identities"])).toBe(true);
  expect(harness.toast).toHaveBeenCalledWith("Pulse data refreshed");
});

it("keeps Show all time local and resets it for another opponent", () => {
  harness.filters = { preset: "custom", since: "2026-10-01T00:00:00.000Z", race: "P" };
  const view = render(<ProfileView pulseId="target" onBack={() => undefined} />);
  fireEvent.click(screen.getByRole("button", { name: /^Show all time$/ }));
  const paths = harness.api.mock.calls.map(([path]) => String(path)).filter(path => path.startsWith("/v1/opponents/target?"));
  expect(paths.at(-1)).toContain("race=P"); expect(paths.at(-1)).not.toContain("since=");
  expect(harness.filters.since).toBe("2026-10-01T00:00:00.000Z");
  view.rerender(<ProfileView pulseId="other" onBack={() => undefined} />);
  expect(harness.api.mock.calls.some(([path]) => String(path).startsWith("/v1/opponents/other?") && String(path).includes("since="))).toBe(true);
});
it("provides one page heading and a sticky section navigation without a duplicate back action", () => {
  render(<ProfileView pulseId="target" onBack={() => undefined} />);
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  expect(within(screen.getByRole("navigation", { name: "Dossier sections" })).getByRole("link", { name: "Brief" }).getAttribute("aria-current")).toBe("true");
  expect(screen.queryByRole("link", { name: "All opponents" })).toBeNull();
  expect(screen.queryByText(/Build tendencies/)).toBeNull();
});
it("shows busy analysis retries and distinguishes a missing history record", () => {
  harness.retry.mockResolvedValue(undefined);
  harness.api.mockImplementation((path: string | null) => path?.startsWith("/v1/opponents/target?") ? { error: { status: 503, code: "opponent_profile_busy" }, isLoading: false, mutate: harness.retry } : { data: undefined });
  const view = render(<ProfileView pulseId="target" onBack={() => undefined} />);
  expect(screen.getByText("Analyzing… retrying")).toBeTruthy();
  expect(screen.queryByText("Not in your history")).toBeNull();
  harness.api.mockImplementation((path: string | null) => path?.startsWith("/v1/opponents/target?") ? { error: { status: 404 }, isLoading: false, mutate: harness.retry } : { data: undefined });
  view.rerender(<ProfileView pulseId="target" onBack={() => undefined} />);
  expect(screen.getByText("Not in your history")).toBeTruthy();
});

it("forgets local cohort and open panels when a warm cached opponent switches account", () => {
  harness.filters = { preset: "custom", since: "2026-10-01T00:00:00.000Z", race: "P" };
  const view = render(<ProfileView pulseId="target" onBack={() => undefined} />);
  fireEvent.click(screen.getByRole("button", { name: /^Show all time$/ }));
  fireEvent.click(screen.getByRole("button", { name: /Alcyone/ }));
  fireEvent.click(screen.getByRole("link", { name: "Data looks wrong?" }));
  expect(screen.getByRole("region", { name: "Active dossier filters" })).toBeTruthy();
  expect(screen.getByText("Identity & data quality").closest("details")?.open).toBe(true);
  harness.ownerId = "owner-b"; view.rerender(<ProfileView pulseId="target" onBack={() => undefined} />);
  expect(screen.queryByRole("region", { name: "Active dossier filters" })).toBeNull();
  expect(screen.getByRole("button", { name: /^Show all time$/ })).toBeTruthy();
  expect(screen.getByText("Identity & data quality").closest("details")?.open).toBe(false);
  const callCount = harness.api.mock.calls.length;
  harness.ownerId = null; view.rerender(<ProfileView pulseId="target" onBack={() => undefined} />);
  expect(screen.getByText("Sign in to view opponent history.")).toBeTruthy();
  expect(harness.api).toHaveBeenCalledTimes(callCount);
});

it("filters history through the shared bar using only the selected analyzed IDs", async () => {
  render(<ProfileView pulseId="target" onBack={() => undefined} />);
  const select = await screen.findByRole("button", { name: "Select timing sample" });
  expect(select.getAttribute("data-path")).toBe("/v1/opponents/target/analysis?mergeLinked=1#7");
  fireEvent.click(select);
  const path = screen.getByLabelText("Replay history").getAttribute("data-path")!;
  expect(new URL(path, "https://example.test").searchParams.get("analysisGameIds")).toBe('["one"]');
  expect(screen.getByRole("region", { name: "Active dossier filters" }).textContent).toContain("Analyzed timing sample");
  expect(screen.getByText("Games (filtered)").parentElement?.textContent).toContain("1");
  fireEvent.click(screen.getByRole("button", { name: /Remove timing filter/ }));
  expect(screen.queryByRole("region", { name: "Active dossier filters" })).toBeNull();
  expect(screen.getByLabelText("Replay history").getAttribute("data-path")).not.toContain("analysisGameIds");
});
