import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ macroError: null as unknown, buildError: null as unknown,
  gameError: null as unknown, loading: false, crash: false, retry: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }), usePathname: () => "/app/game/one" }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isSignedIn: false }) }));
vi.mock("@/lib/sentry", () => ({ captureException: vi.fn(async () => null) }));
vi.mock("@/lib/buildIntent", () => ({ useGameBuildIntent: () => ({}), effectiveBuild: () => null, effectiveOpponentBuild: () => null }));
vi.mock("@/components/build-checkin/BuildCheckInProvider", () => ({ useBuildCheckInRevision: () => ({ revision: 0 }) }));
vi.mock("@/components/build-checkin/BuildCheckInCard", () => ({ BuildCheckInCard: () => null }));
vi.mock("../GhostGradeCard", () => ({ GhostGradeCard: () => null, ArmGhostFromLogButton: () => null }));
vi.mock("../GameDetailShell", () => ({ GameDetailShell: ({ children }: { children: ReactNode }) => <><h1>My replay hero</h1>{children}</> }));
vi.mock("../MapReplaySection", () => ({ MapReplaySection: () => { if (state.crash) throw new Error("player crash"); return <p>Replay player recovered</p>; } }));
vi.mock("@/lib/clientApi", () => ({ useApi: (path: string) => {
  const macro = path?.endsWith("/macro-breakdown"); const build = path?.endsWith("/build-order");
  const game = path === "/v1/games/one";
  const error = macro ? state.macroError : build ? state.buildError : game ? state.gameError : null;
  return { error, mutate: state.retry, isLoading: macro && state.loading,
    data: error || (macro && state.loading) ? undefined : game ? { gameId: "one", result: "Defeat", opponent: {} }
      : macro ? {} : build ? { events: [], opp_events: [] } : undefined };
} }));
import { GameDetailPage } from "../GameDetailPage";
beforeEach(() => { state.macroError = null; state.buildError = null; state.gameError = null; state.loading = false; state.crash = false; state.retry.mockReset(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("shows retryable macro errors without claiming no analysis exists", async () => {
  state.macroError = { status: 500, message: "failed" };
  render(<GameDetailPage gameId="one" />);
  expect(await screen.findByText("Couldn't load the macro breakdown")).toBeTruthy();
  expect(screen.queryByText(/No timeline samples/)).toBeNull();
  expect(screen.queryByText(/No macro breakdown/)).toBeNull();
  fireEvent.click(screen.getAllByRole("button", { name: "Retry" })[0]);
  expect(state.retry).toHaveBeenCalledOnce();
});
it("reserves not-computed copy for the explicit missing-analysis code, and skeletons for an unsettled request", async () => {
  state.macroError = { status: 404, code: "macro_not_computed" };
  const view = render(<GameDetailPage gameId="one" />);
  expect(await within(screen.getByRole("region", { name: "Macro breakdown" })).findByText("No macro breakdown for this game")).toBeTruthy();
  state.macroError = null; state.loading = true; view.rerender(<GameDetailPage gameId="one" />);
  expect(screen.getByRole("status", { name: "Loading macro breakdown" })).toBeTruthy();
  expect(screen.queryByText(/Not enough data/)).toBeNull();
});
it("lets game and build-order requests retry", async () => {
  state.gameError = { status: 500 };
  const view = render(<GameDetailPage gameId="one" />);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(state.retry).toHaveBeenCalledOnce();
  state.gameError = null; state.buildError = { status: 500 }; view.rerender(<GameDetailPage gameId="one" />);
  expect(await screen.findByText("Couldn't load build orders")).toBeTruthy();
  expect(screen.queryByText(/No build events/)).toBeNull();
});
it("isolates a replay crash and remounts it without losing the hero or build orders", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  state.crash = true; render(<GameDetailPage gameId="one" />);
  expect(screen.getByRole("heading", { name: "My replay hero" })).toBeTruthy();
  expect(await screen.findByTestId("build-order-columns")).toBeTruthy();
  state.crash = false; fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(screen.getByText("Replay player recovered")).toBeTruthy();
});
