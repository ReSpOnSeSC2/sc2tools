import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ response: {} as Record<string, unknown>, api: vi.fn(), retry: vi.fn(), phases: vi.fn(), composition: vi.fn(), transitions: vi.fn() }));
vi.mock("@/lib/clientApi", () => ({ useApi: (...args: unknown[]) => { state.api(...args); return state.response; } }));
vi.mock("../PhaseTrajectoryStrip", () => ({ PhaseTrajectoryStrip: (props: unknown) => { state.phases(props); return <p>Existing phase strip</p>; } }));
vi.mock("../PhaseCompositionTabs", () => ({ PhaseCompositionTabs: (props: unknown) => { state.composition(props); return <p>Existing composition tabs</p>; } }));
vi.mock("../BuildTransitionSankey", () => ({ BuildTransitionSankey: (props: unknown) => { state.transitions(props); return <p>Existing transition flow</p>; } }));
vi.mock("../PredictedStrategiesList", () => ({ PredictedStrategiesList: () => <p>Known strategy probabilities</p> }));
vi.mock("@/components/ui/Icon", () => ({ Icon: () => null }));
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: () => <span>Reading these timings</span> }));
import { DossierAnalysisSection } from "../DossierAnalysisSection";
const props = { path: "/v1/opponents/one/analysis?race=P&mergeLinked=1#7", sourceFilters: "race=P", scopeLabel: "Ranked 1v1 · Protoss", predictions: [], selected: null };
beforeEach(() => { state.api.mockReset(); state.retry.mockReset().mockResolvedValue(undefined); state.phases.mockReset(); state.composition.mockReset(); state.transitions.mockReset(); state.response = { isLoading: false, mutate: state.retry }; });
afterEach(cleanup);
it("labels the independent all-date predictions and withholds a previous cohort", () => {
  render(<DossierAnalysisSection {...props} predictions={null} onSelect={vi.fn()} />);
  expect(screen.getByText(/Recent matching meetings across all dates/)).toBeTruthy();
  expect(screen.getByText("Updating tendencies…")).toBeTruthy();
  expect(screen.queryByText("Known strategy probabilities")).toBeNull();
});
it("uses one analysis resource for timings and unchanged phase components, with sample-only history selection", () => {
  const phases = { sampleSize: {}, medianCrossings: {}, finalPhaseDistribution: {}, durationP95Sec: 600, perPhase: {}, byStrategy: [] };
  const transitions = { transitions: { nodes: [], edges: [] } };
  state.response.data = { analysisSampleSize: 3, analysisCohortSize: 9, analysisSampleLimit: 100, analysisSampleTruncated: true, buildOrdersAvailable: 2, buildOrdersTotal: 3, phases, transitions, medianTimingsLegacy: { SpawningPool: { source: "opp_build_log", sampleCount: 2, medianSeconds: 120, medianDisplay: "2:00", p25Seconds: 100, p75Seconds: 130, samples: [{ gameId: "a" }, { gameId: "b" }] } } };
  const select = vi.fn(); render(<DossierAnalysisSection {...props} onSelect={select} />);
  expect(state.api).toHaveBeenCalledOnce(); expect(state.api.mock.calls[0][0]).toBe(props.path);
  expect(screen.getByText("Needs build orders: 2 of 3 games have one.")).toBeTruthy();
  fireEvent.click(screen.getByText("SpawningPool").closest("button")!);
  expect(select).toHaveBeenCalledWith(expect.objectContaining({ source: "opp_build_log", gameIds: ["a", "b"] }));
  expect(state.api).toHaveBeenCalledOnce(); expect(state.phases).toHaveBeenCalledWith(expect.objectContaining({ crossings: phases.medianCrossings }));
  expect(state.composition).toHaveBeenCalledWith(expect.objectContaining({ perPhase: phases.perPhase }));
  expect(state.transitions).toHaveBeenCalledWith({ transitions });
});
it("shows admission retrying without inventing phase cards", () => {
  state.response.error = { status: 503, code: "opponent_profile_busy" };
  render(<DossierAnalysisSection {...props} onSelect={vi.fn()} />);
  expect(screen.getByText("Analyzing… retrying")).toBeTruthy(); expect(screen.queryByText("Existing phase strip")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry now" })); expect(state.retry).toHaveBeenCalledOnce();
});
it("keeps an ordinary network failure retryable", () => {
  state.response.error = { status: 0, message: "No network" };
  render(<DossierAnalysisSection {...props} onSelect={vi.fn()} />);
  expect(screen.queryByText("Analyzing… retrying")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" })); expect(state.retry).toHaveBeenCalledOnce();
});
