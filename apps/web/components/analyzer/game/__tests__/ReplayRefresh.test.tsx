import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MapReplaySection } from "../MapReplaySection";

const state = vi.hoisted(() => ({ data: null as any, config: null as any, request: vi.fn(), mutate: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/clientApi", () => ({ useApi: (_: string, config: unknown) => {
  state.config = config;
  return { data: state.data, isLoading: false,
    request: (init: RequestInit) => init.method === "GET" ? Promise.resolve(state.data) : state.request(init),
    mutate: state.mutate };
} }));
vi.mock("../replay/ReplayStage", () => ({ ReplayStage: () => <div>Replay stage</div> }));
const raw = {
  v: 6, gameLength: 20, bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
  units: [{ owner: "me", name: "Probe", born: 0, died: null, wp: [0, 10, 10] }],
  fidelity: { positions: "tracker", paths: "observed", creep: "estimated", complete: true },
};
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

describe("accurate replay refresh", () => {
  it("requests recording explicitly and stops polling when observed playback arrives", async () => {
    state.data = raw;
    state.request.mockResolvedValue({ requestId: "r1" });
    const view = render(<MapReplaySection gameId="game1" />);
    fireEvent.click(screen.getByRole("button", { name: "Generate accurate playback" }));
    await waitFor(() => expect(state.mutate).toHaveBeenCalled());
    expect(state.request).toHaveBeenCalledWith({ method: "POST", body: '{"fidelity":"engine"}' });
    expect(state.config.refreshInterval).toBe(3000);
    state.data = { ...raw, fidelity: { ...raw.fidelity, positions: "engine", attacks: "observed" }, rebuild: { requestId: "r1", status: "complete" } };
    view.rerender(<MapReplaySection gameId="game1" />);
    expect(screen.getByRole("status").textContent).toBe("Recorded playback is ready.");
    expect(state.config.refreshInterval).toBe(0);
  });

  it("shows offline failures and enables retry", async () => {
    state.data = raw;
    state.request.mockRejectedValue({ message: "Open your desktop agent to record this replay." });
    render(<MapReplaySection gameId="game1" />);
    fireEvent.click(screen.getByRole("button", { name: "Generate accurate playback" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Open your desktop agent"));
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(false);
    expect(state.config.refreshInterval).toBe(0);
  });

  it("ignores an earlier failed request and reports this recording's failure", async () => {
    state.data = { ...raw, rebuild: { status: "failed", requestId: "old", message: "Earlier failure" } };
    state.request.mockResolvedValue({ requestId: "r2" });
    const view = render(<MapReplaySection gameId="game1" />);
    fireEvent.click(screen.getByRole("button", { name: "Generate accurate playback" }));
    await waitFor(() => expect(state.mutate).toHaveBeenCalled());
    expect(state.config.refreshInterval).toBe(3000);
    state.data = { ...raw, rebuild: { status: "failed", requestId: "r2", message: "Replay file was moved." } };
    view.rerender(<MapReplaySection gameId="game1" />);
    expect(screen.getByRole("status").textContent).toBe("Replay file was moved.");
    expect(state.config.refreshInterval).toBe(0);
  });

  it("bounds background polling and resets when changing games", async () => {
    vi.useFakeTimers();
    state.data = raw;
    state.request.mockResolvedValue({ requestId: "r3" });
    const view = render(<MapReplaySection gameId="game1" />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Generate accurate playback" })); });
    await act(async () => { vi.advanceTimersByTime(18 * 60 * 1000); });
    expect(state.config.refreshInterval).toBe(0);
    expect(screen.getByRole("status").textContent).toContain("still processing");
    view.rerender(<MapReplaySection gameId="game2" />);
    expect(screen.getByRole("status").textContent).toContain("only occasional unit positions");
  });
});
