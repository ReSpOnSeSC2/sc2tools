import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { BuildEditorModalProps } from "@/components/builds/editor";
import type { GameIntentState } from "@/lib/buildIntent";
import { BUILD_ORDER, confirmedResponse, intent, opponentState } from "@/components/build-checkin/__tests__/cardFixtures";

const h = vi.hoisted(() => ({
  owner: "owner-a" as string | null, loaded: true, signedIn: true,
  state: undefined as GameIntentState | undefined,
  error: undefined as { status: number; message: string } | undefined,
  paths: [] as string[], mutate: vi.fn(), write: vi.fn(), getToken: vi.fn(async () => "token"),
  changed: vi.fn(), toast: { success: vi.fn(), error: vi.fn() },
  macroLoading: false, macroError: undefined as { status: number; message: string } | undefined,
}));

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: h.owner, isLoaded: h.loaded, isSignedIn: h.signedIn, getToken: h.getToken }) }));
vi.mock("@/lib/useUserSocket", () => ({ useUserSocket: () => undefined }));
vi.mock("@/components/ui/Toast", () => ({ useToastOptional: () => ({ toast: h.toast }) }));
vi.mock("@/components/builds/editor", async () => {
  const { Modal } = await import("@/components/ui/Modal");
  return { BuildEditorModal: (props: BuildEditorModalProps) => <Modal open={props.open} title="Build editor" onClose={props.onClose}><input aria-label="Build name" defaultValue={props.defaultName} /></Modal> };
});
vi.mock("@/lib/clientApi", async original => {
  const real = await original<typeof import("@/lib/clientApi")>();
  const React = await import("react");
  return { ...real, apiCall: (...args: unknown[]) => h.write(...args), useApi: (path: string | null) => {
    const [, update] = React.useReducer((value: number) => value + 1, 0);
    if (path) h.paths.push(path);
    const mutate = async (next?: unknown) => {
      h.mutate(next);
      if (typeof next === "function") h.state = (next as (current: GameIntentState | undefined) => GameIntentState)(h.state);
      update();
    };
    return { data: path?.endsWith("/build-order") ? BUILD_ORDER : path ? h.state : undefined, error: path ? h.error : undefined, isLoading: !h.state && !h.error, isValidating: false, mutate };
  } };
});
vi.mock("../useMacroRecompute", () => ({ useMacroRecompute: () => ({ data: null, isLoading: h.macroLoading, error: h.macroError, mutate: vi.fn(), recompute: vi.fn(), recomputing: false, recomputeMsg: null }) }));
vi.mock("@/lib/useMapReplay", () => ({ useMapReplay: () => ({ completedRequestId: null }) }));
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: () => null }));

import { MacroBuildSelector } from "../MacroBuildSelector";
import { MacroBreakdownPanel } from "../MacroBreakdownPanel";
import { GameMacroSection } from "@/components/analyzer/game/GameMacroSection";
import { BuildCheckInCard } from "@/components/build-checkin/BuildCheckInCard";
import { BuildCheckInProvider } from "@/components/build-checkin/BuildCheckInProvider";

beforeAll(async () => { await import("@/components/build-checkin/BuildCheckInCard"); });
beforeEach(() => {
  h.owner = "owner-a"; h.loaded = true; h.signedIn = true; h.state = intent({ opponent: opponentState() }); h.error = undefined;
  h.paths = []; h.mutate.mockReset(); h.write.mockReset(); h.changed.mockReset(); h.toast.success.mockReset(); h.toast.error.mockReset();
  h.macroLoading = false; h.macroError = undefined;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function openSelector() {
  fireEvent.click(screen.getByRole("button", { name: "Change build" }));
  return await screen.findByTestId("build-checkin-card");
}

describe("Macro build selection", () => {
  it("loads no check-in request before explicit intent and closes back to its launcher", async () => {
    render(<MacroBuildSelector gameId="g1" />);
    expect(screen.getByRole("heading", { name: "Build selection" })).toBeTruthy();
    expect(h.paths).toEqual([]);
    expect(screen.queryByTestId("build-checkin-card")).toBeNull();
    const card = await openSelector();
    expect(within(card).getByRole("group", { name: "Your build" })).toBeTruthy();
    expect(h.paths.some(path => path.includes("/g1/build-intent?include=options"))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Close build selection" }));
    expect(screen.queryByTestId("build-checkin-card")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Change build" }));
  });

  it("uses the real Change picker and confirm request, then notifies the game summary", async () => {
    h.write.mockResolvedValue(confirmedResponse("custom:dt-3-gate", "DT into 3 Gate"));
    render(<BuildCheckInProvider><MacroBuildSelector gameId="g1" onChanged={h.changed} /></BuildCheckInProvider>);
    const card = await openSelector();
    fireEvent.click(within(card).getByRole("button", { name: "Change…" }));
    const option = screen.getAllByRole("option").find(node => node.getAttribute("data-build-key") === "custom:dt-3-gate")!;
    fireEvent.click(option);
    fireEvent.click(screen.getByRole("button", { name: "Confirm DT into 3 Gate" }));
    await waitFor(() => expect(h.changed).toHaveBeenCalledTimes(1));
    expect(h.write.mock.calls[0][1]).toBe("/v1/games/g1/build-intent");
    expect(JSON.parse(h.write.mock.calls[0][2].body)).toEqual({ action: "confirm", buildKey: "custom:dt-3-gate" });
    expect(screen.getByText("Planned build")).toBeTruthy();
    expect(h.paths.some(path => path.endsWith("#checkin-1"))).toBe(true);
  });

  it("retains No set build and the opponent's existing correction flow", async () => {
    h.write.mockResolvedValue(intent({ status: "skipped", opponent: opponentState() }));
    render(<MacroBuildSelector gameId="g1" />);
    const card = await openSelector();
    fireEvent.click(within(card).getByRole("button", { name: "No set build" }));
    await waitFor(() => expect(h.write).toHaveBeenCalledTimes(1));
    expect(JSON.parse(h.write.mock.calls[0][2].body)).toEqual({ action: "skip" });
    expect(within(card).getByRole("button", { name: "Change the opponent's build" })).toBeTruthy();
  });

  it("opens an unchecked game directly into the picker, with no extra compact action", async () => {
    h.state = intent({ status: "none", suggestion: null });
    render(<MacroBuildSelector gameId="g1" />);
    await openSelector();
    expect(screen.getByRole("combobox")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Set planned build" })).toBeNull();
  });

  it("opens a confirmed card fully while the original top card keeps its compact default", async () => {
    h.state = intent({ ...confirmedResponse("pvz-2-stargate-phoenix", "PvZ - 2 Stargate Phoenix") });
    render(<><BuildCheckInCard gameId="g1" /><MacroBuildSelector gameId="g1" /></>);
    expect(screen.getByTestId("build-checkin-summary")).toBeTruthy();
    const card = await openSelector();
    expect(within(card).getByRole("button", { name: "Change…" })).toBeTruthy();
    expect(screen.getByTestId("build-checkin-summary")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Build editor" })).toBeNull();
  });

  it.each(["loading", "missing", "error"])("keeps the explicit editor visible during check-in %s", async mode => {
    h.state = undefined; h.error = mode === "loading" ? undefined : { status: mode === "missing" ? 404 : 503, message: "private raw failure" };
    render(<MacroBuildSelector gameId="g1" />);
    fireEvent.click(screen.getByRole("button", { name: "Change build" }));
    await screen.findByText(mode === "loading" ? "Loading build selection…" : mode === "missing" ? "Build selection isn't available for this game yet." : "Build selection couldn't load.");
    expect(screen.queryByText("private raw failure")).toBeNull();
    if (mode !== "loading") {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(h.mutate).toHaveBeenCalledTimes(1);
    }
    expect(screen.getByRole("button", { name: "Close build selection" })).toBeTruthy();
  });

  it.each(["unloaded", "signed-out", "missing-owner"])("does not expose an editor for %s auth", mode => {
    if (mode === "unloaded") h.loaded = false;
    if (mode === "signed-out") h.signedIn = false;
    if (mode === "missing-owner") h.owner = null;
    render(<MacroBuildSelector gameId="g1" />);
    expect(screen.queryByRole("heading", { name: "Build selection" })).toBeNull();
    expect(h.paths).toEqual([]);
  });

  it("keeps keyboard focus in the editor when a successful API retry removes Try again", async () => {
    h.state = undefined; h.error = { status: 503, message: "Synthetic failure" };
    render(<MacroBuildSelector gameId="g1" />);
    fireEvent.click(screen.getByRole("button", { name: "Change build" }));
    const retry = await screen.findByRole("button", { name: "Try again" });
    const stableRoot = retry.closest('[role="alert"]')!.parentElement;
    h.error = undefined; h.state = intent({ status: "none", suggestion: null });
    retry.focus(); fireEvent.click(retry);
    await screen.findByTestId("build-checkin-card");
    expect(document.activeElement).toBe(stableRoot);
    expect(screen.getByRole("combobox")).toBeTruthy();
  });

  it("does not steal focus from another control when a retried API response arrives", async () => {
    h.state = undefined; h.error = { status: 503, message: "Synthetic failure" };
    const content = <><MacroBuildSelector gameId="g1" /><button>Another control</button></>;
    const view = render(content);
    fireEvent.click(screen.getByRole("button", { name: "Change build" }));
    const retry = await screen.findByRole("button", { name: "Try again" });
    retry.focus(); fireEvent.click(retry);
    const other = screen.getByRole("button", { name: "Another control" }); other.focus();
    h.error = undefined; h.state = intent({ status: "none", suggestion: null });
    view.rerender(<><MacroBuildSelector gameId="g1" /><button>Another control</button></>);
    await screen.findByTestId("build-checkin-card");
    expect(document.activeElement).toBe(other);
  });

  it("retires notes and open editor state across games, accounts, and an account ABA", async () => {
    const view = render(<MacroBuildSelector gameId="g1" />);
    await openSelector();
    fireEvent.change(screen.getByLabelText(/What threw the build off/), { target: { value: "old private draft" } });
    view.rerender(<MacroBuildSelector gameId="g2" />);
    expect(screen.queryByDisplayValue("old private draft")).toBeNull();
    expect(screen.getByRole("button", { name: "Change build" })).toBeTruthy();
    h.owner = "owner-b"; view.rerender(<MacroBuildSelector gameId="g2" />);
    h.owner = "owner-a"; view.rerender(<MacroBuildSelector gameId="g2" />);
    expect(screen.queryByTestId("build-checkin-card")).toBeNull();
    expect(h.write).not.toHaveBeenCalled();
  });

  it("cancels a pending write on close without late summary updates or toast", async () => {
    let resolve!: (state: GameIntentState) => void;
    h.write.mockImplementation(() => new Promise<GameIntentState>(done => { resolve = done; }));
    render(<MacroBuildSelector gameId="g1" onChanged={h.changed} />);
    await openSelector();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(h.write).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Close build selection" }));
    await act(async () => resolve(confirmedResponse("pvz-2-stargate-phoenix", "PvZ - 2 Stargate Phoenix")));
    expect(h.changed).not.toHaveBeenCalled();
    expect(h.toast.success).not.toHaveBeenCalled();
    expect(h.toast.error).not.toHaveBeenCalled();
  });

  it.each(["loading", "error", "missing"])("offers actual build editing in the inline Macro %s state", async mode => {
    render(<GameMacroSection gameId="g1" data={null} loading={mode === "loading"} error={mode === "error" ? { status: 503, message: "Unavailable" } : undefined} onRetry={vi.fn()} action={null} onRecompute={vi.fn()} recomputing={false} headerMeta={{}} onBuildChanged={h.changed} />);
    await openSelector();
    expect(screen.getByRole("heading", { name: "Build check-in" })).toBeTruthy();
  });

  it.each(["loading", "error", "missing"])("offers the actual editor in the standalone Macro %s state", async mode => {
    h.macroLoading = mode === "loading";
    h.macroError = mode === "loading" ? undefined : { status: mode === "missing" ? 404 : 503, message: "Unavailable" };
    render(<MacroBreakdownPanel open gameId="g1" onClose={vi.fn()} />);
    await openSelector();
    expect(screen.getByRole("heading", { name: "Build check-in" })).toBeTruthy();
  });

  it("lets the nested Add new build dialog consume Escape before the Macro dialog", async () => {
    const onClose = vi.fn();
    render(<MacroBreakdownPanel open gameId="g1" onClose={onClose} />);
    const card = await openSelector();
    fireEvent.click(within(card).getByRole("button", { name: "Change…" }));
    fireEvent.click(screen.getByRole("button", { name: "Add new build…" }));
    const dialog = await screen.findByRole("dialog", { name: "Build editor" });
    const input = within(dialog).getByRole("textbox", { name: "Build name" });
    input.focus();
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Build editor" })).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("button", { name: "Close macro breakdown" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
