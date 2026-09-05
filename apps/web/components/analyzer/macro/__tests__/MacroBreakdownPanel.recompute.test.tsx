import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MacroBreakdownPanel } from "../MacroBreakdownPanel";

const harness = vi.hoisted(() => ({
  playback: null as Record<string, unknown> | null,
  macroError: null as { status: number; message?: string } | null,
  request: vi.fn(),
  macroRequest: vi.fn(),
  playbackMutate: vi.fn(),
  statusMutate: vi.fn(),
  macroMutate: vi.fn(),
  mapPollInterval: 0,
  fullPollInterval: 0,
  paths: [] as Array<string | null>,
}));

vi.mock("@/lib/clientApi", () => ({
  useApi: (path: string | null, options?: { refreshInterval?: number }) => {
    harness.paths.push(path);
    if (path?.endsWith("/macro-breakdown")) return {
      data: harness.macroError ? undefined : { macro_score: 60, race: "Protoss", raw: {} },
      error: harness.macroError,
      isLoading: false,
      mutate: harness.macroMutate,
      request: harness.macroRequest,
    };
    if (path?.endsWith("/map-playback/status")) {
      harness.mapPollInterval = options?.refreshInterval ?? 0;
      return {
        data: { rebuild: harness.playback?.rebuild ?? null },
        isLoading: false,
        error: null,
        mutate: harness.statusMutate,
      };
    }
    if (path?.endsWith("/map-playback")) harness.fullPollInterval = options?.refreshInterval ?? 0;
    return {
      data: path ? harness.playback : undefined,
      isLoading: false,
      error: null,
      request: (init: RequestInit) => init.method === "GET"
        ? Promise.resolve(harness.playback) : harness.request(init),
      mutate: harness.playbackMutate,
    };
  },
}));
vi.mock("@/components/analyzer/game/MapReplaySection", () => ({
  MapReplaySection: ({ controller }: { controller: { playback: { fidelity?: { positions?: string } } | null; refresh: () => void } }) => (
    <div aria-label="Shared map playback">{controller.playback?.fidelity?.positions ?? "missing"}
      <button onClick={controller.refresh}>Generate accurate playback</button>
    </div>
  ),
}));

const tracker = {
  v: 6, gameLength: 20,
  bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
  units: [{ owner: "me", name: "Probe", born: 0, died: null, wp: [0, 10, 10] }],
  fidelity: { positions: "tracker", paths: "observed", creep: "estimated", complete: true },
};
const recorded = {
  ...tracker,
  fidelity: { ...tracker.fidelity, positions: "engine", attacks: "observed" },
  rebuild: { requestId: "recording-1", status: "complete" },
};
const props = { open: true, gameId: "washout-game", onClose: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  harness.paths = [];
  harness.playback = tracker;
  harness.macroError = null;
  harness.request.mockResolvedValue({ rebuild: { requestId: "recording-1" } });
  harness.macroRequest.mockResolvedValue({ ok: true, requested: true });
  harness.playbackMutate.mockResolvedValue(undefined);
  harness.statusMutate.mockResolvedValue(undefined);
  harness.macroMutate.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("macro breakdown Recompute", () => {
  it("recomputes analysis without requesting engine capture and refreshes at bounded intervals", async () => {
    vi.useFakeTimers();
    render(<MacroBreakdownPanel {...props} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Recompute" })));
    expect(harness.macroRequest).toHaveBeenCalledWith({ method: "POST", body: "{}" });
    expect(harness.request).not.toHaveBeenCalled();
    expect(harness.mapPollInterval).toBe(0);
    expect(harness.statusMutate).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("does not start a StarCraft recording");
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(harness.macroMutate).toHaveBeenCalledTimes(4);
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(harness.macroMutate).toHaveBeenCalledTimes(4);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Recompute" })));
    await act(async () => vi.advanceTimersByTime(3000));
    expect(harness.macroMutate).toHaveBeenCalledTimes(5);
  });

  it("still refreshes analysis after a separately requested accurate recording finishes", async () => {
    const view = render(<MacroBreakdownPanel {...props} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Generate accurate playback" })));
    expect(harness.request).toHaveBeenCalledTimes(1);
    expect(harness.request).toHaveBeenCalledWith({ method: "POST", body: '{"fidelity":"engine"}' });
    expect(harness.paths).toContain("/v1/games/washout-game/map-playback");
    expect(harness.mapPollInterval).toBe(3000);
    expect(harness.fullPollInterval).toBe(0);
    expect(harness.playbackMutate).not.toHaveBeenCalled();
    expect(harness.statusMutate).toHaveBeenCalledTimes(1);
    expect(harness.macroRequest).not.toHaveBeenCalled();
    expect(harness.macroMutate).not.toHaveBeenCalled();

    harness.playback = recorded;
    view.rerender(<MacroBreakdownPanel {...props} />);
    await waitFor(() => expect(harness.macroMutate).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText("Shared map playback").textContent).toContain("engine");
    expect(harness.mapPollInterval).toBe(0);
    view.rerender(<MacroBreakdownPanel {...props} />);
    expect(harness.macroMutate).toHaveBeenCalledTimes(1);
  });

  it("shows an offline-agent failure instead of claiming a recompute was queued", async () => {
    harness.macroRequest.mockRejectedValue(new Error("Open the SC2 Tools desktop agent, then retry."));
    render(<MacroBreakdownPanel {...props} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Recompute" })));
    expect(screen.getByRole("status").textContent).toContain("Open the SC2 Tools desktop agent");
    expect((screen.getByRole("button", { name: "Recompute" }) as HTMLButtonElement).disabled).toBe(false);
    expect(harness.macroMutate).not.toHaveBeenCalled();
    expect(harness.mapPollInterval).toBe(0);
  });

  it("reparses a missing macro breakdown without requesting a new recording", async () => {
    harness.macroError = { status: 404 };
    harness.playback = null;
    render(<MacroBreakdownPanel {...props} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Recompute" })));
    expect(harness.macroRequest).toHaveBeenCalledWith({ method: "POST", body: "{}" });
    expect(harness.request).not.toHaveBeenCalled();
  });

  it("does not apply a late analysis acknowledgement to another game", async () => {
    let acknowledge!: (value: unknown) => void;
    harness.macroRequest.mockImplementation(() => new Promise(resolve => { acknowledge = resolve; }));
    const view = render(<MacroBreakdownPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Recompute" }));
    view.rerender(<MacroBreakdownPanel {...props} gameId="other-game" />);
    await act(async () => acknowledge({ requestId: "recording-1" }));
    expect(harness.paths).toContain("/v1/games/other-game/map-playback");
    expect(harness.macroMutate).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
    expect(harness.mapPollInterval).toBe(0);
  });
});
