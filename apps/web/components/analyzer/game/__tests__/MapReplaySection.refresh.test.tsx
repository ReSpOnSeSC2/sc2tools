import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MapReplaySection } from "../MapReplaySection";

const harness = vi.hoisted(() => ({
  api: {
    data: null as unknown,
    isLoading: false,
    error: null as null | { status: number; code?: string; message: string },
    request: vi.fn(),
    mutate: vi.fn(),
  },
  paths: [] as Array<string | null>,
  interval: 0,
  statusMutate: vi.fn(),
}));
vi.mock("@/lib/clientApi", () => ({ useApi: (path: string | null, config: { refreshInterval: number }) => {
  harness.paths.push(path);
  harness.interval = config.refreshInterval;
  if (path?.endsWith("/status")) return { ...harness.api,
    data: { rebuild: (harness.api.data as { rebuild?: unknown } | null)?.rebuild ?? null },
    mutate: harness.statusMutate };
  return { ...harness.api, request: (init: RequestInit) => init.method === "GET"
    ? Promise.resolve(harness.api.data) : harness.api.request(init) };
} }));
vi.mock("../replay/ReplayStage", () => ({ ReplayStage: () => <div>Replay stage</div> }));
vi.mock("../replay/CompactReplayHost", () => ({ CompactReplayHost: () => <div>Compact replay</div> }));

function payload(positions = "tracker", complete = true, rebuild?: Record<string, string>) {
  return {
    v: 6, mapName: "Test", gameLength: 60,
    bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
    spawns: [], battles: [], units: [],
    buildings: [{ owner: "me", name: "Nexus", t: 0, x: 20, y: 20 }],
    fidelity: { positions, paths: "observed", creep: "estimated", attacks: positions === "engine" ? "observed" : "unavailable", complete },
    ...(rebuild ? { rebuild } : {}),
  };
}
function pending() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const button = () => screen.getByRole("button", { name: /Generate accurate playback|Recording replay/ }) as HTMLButtonElement;

beforeEach(() => {
  harness.api.data = payload();
  harness.api.error = null;
  harness.api.request.mockReset();
  harness.api.mutate.mockReset().mockResolvedValue(undefined);
  harness.statusMutate.mockReset().mockResolvedValue(undefined);
  harness.paths.length = 0;
  harness.api.isLoading = false;
});
afterEach(cleanup);

describe("map playback rebuild progress", () => {
  it("puts the compact recording action above the map and records through the engine endpoint", async () => {
    harness.api.request.mockResolvedValue({ requestId: "compact" });
    const view = render(<MapReplaySection gameId="g1" compact />);
    expect(button().compareDocumentPosition(screen.getByText("Compact replay")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("only occasional unit positions");
    await act(async () => fireEvent.click(button()));
    expect(new Set(harness.paths)).toEqual(new Set(["/v1/games/g1/map-playback", "/v1/games/g1/map-playback/status"]));
    expect(harness.api.mutate).not.toHaveBeenCalled();
    expect(harness.api.request).toHaveBeenCalledWith({ method: "POST", body: '{"fidelity":"engine"}' });
    expect(harness.interval).toBe(3000);
    harness.api.data = payload("tracker", true, { requestId: "compact", status: "uploading" });
    view.rerender(<MapReplaySection gameId="g1" compact />);
    expect(screen.getByRole("status").textContent).toContain("Uploading");
    harness.api.data = payload("engine", true, { requestId: "compact", status: "complete" });
    view.rerender(<MapReplaySection gameId="g1" compact />);
    expect(screen.getByRole("status").textContent).toBe("Recorded playback is ready.");
    expect(harness.interval).toBe(0);
  });

  it("keeps capture and runtime errors reachable for compact replays without playback", async () => {
    harness.api.data = null;
    harness.api.error = { status: 404, code: "playback_not_computed", message: "Not computed" };
    harness.api.request.mockResolvedValue({ requestId: "compact" });
    const view = render(<MapReplaySection gameId="g1" compact />);
    expect(screen.getByText(/No playback data for this game/)).toBeTruthy();
    await act(async () => fireEvent.click(button()));
    expect(harness.interval).toBe(3000);
    harness.api.error = null;
    harness.api.data = { ok: false, code: "not_computed", rebuild: {
      requestId: "compact", status: "failed", message: "The original replay file was moved.",
    } };
    view.rerender(<MapReplaySection gameId="g1" compact />);
    expect(screen.getByRole("status").textContent).toBe("The original replay file was moved.");
    expect(button().disabled).toBe(false);
    expect(harness.interval).toBe(0);
  });

  it("uses a supplied shared controller while disabling its own fetch", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    render(<MapReplaySection gameId="g1" compact controller={{
      playback: null, isLoading: false, error: undefined, canRefresh: true,
      refreshing: false, refreshMessage: "", refresh, completedRequestId: null,
    }} />);
    await act(async () => fireEvent.click(button()));
    expect(harness.paths.every(path => path === null)).toBe(true);
    expect(refresh).toHaveBeenCalledOnce();
    expect(harness.api.request).not.toHaveBeenCalled();
  });

  it("reports a completed recording without attacks and offers regeneration", async () => {
    harness.api.request.mockResolvedValue({ requestId: "current" });
    const view = render(<MapReplaySection gameId="g1" />);
    await act(async () => fireEvent.click(button()));
    const result = payload("engine", true, { requestId: "current", status: "complete" });
    result.fidelity.attacks = "unavailable";
    harness.api.data = result;
    await act(async () => view.rerender(<MapReplaySection gameId="g1" />));
    expect(screen.getByRole("status").textContent).toContain("no attack data");
    expect(screen.queryByText("Recorded playback is ready.")).toBeNull();
    expect(button().disabled).toBe(false);
  });
  it("waits for the acknowledged job instead of completing from cached engine data", async () => {
    harness.api.data = payload("engine", false, { requestId: "old", status: "complete" });
    const ack = pending();
    harness.api.request.mockReturnValue(ack.promise);
    const view = render(<MapReplaySection gameId="g1" />);
    fireEvent.click(button());
    expect(button().disabled).toBe(true);
    harness.api.data = payload("engine", true, { requestId: "old", status: "complete" });
    view.rerender(<MapReplaySection gameId="g1" />);
    expect(screen.queryByText("Recorded playback is ready.")).toBeNull();
    await act(async () => ack.resolve({ rebuild: { requestId: "new" } }));
    expect(button().disabled).toBe(true);
    expect(harness.api.request).toHaveBeenCalledWith({ method: "POST", body: '{"fidelity":"engine"}' });
    harness.api.data = payload("engine", true, { requestId: "new", status: "complete" });
    await act(async () => view.rerender(<MapReplaySection gameId="g1" />));
    expect(screen.getByText("Recorded playback is ready.")).toBeTruthy();
    expect(button().disabled).toBe(false);
  });

  it("ignores a late response after navigating away and back to the same game", async () => {
    const first = pending(), second = pending();
    harness.api.request.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const view = render(<MapReplaySection gameId="g1" />);
    fireEvent.click(button());
    view.rerender(<MapReplaySection gameId="g2" />);
    view.rerender(<MapReplaySection gameId="g1" />);
    fireEvent.click(button());
    await act(async () => first.resolve({ requestId: "old" }));
    expect(harness.api.mutate).not.toHaveBeenCalled();
    expect(button().disabled).toBe(true);
    await act(async () => second.resolve({ requestId: "current" }));
    expect(harness.statusMutate).toHaveBeenCalledTimes(1);
  });

  it("reports unacknowledged jobs and allows a retry", async () => {
    harness.api.request.mockResolvedValue({ ok: true });
    render(<MapReplaySection gameId="g1" />);
    await act(async () => fireEvent.click(button()));
    expect(screen.getByRole("status").textContent).toMatch(/not acknowledged/);
    expect(button().disabled).toBe(false);
    expect(harness.api.mutate).not.toHaveBeenCalled();
  });

  it("keeps polling an accepted rebuild after a transient GET failure", async () => {
    harness.api.request.mockResolvedValue({ requestId: "current" });
    harness.statusMutate.mockRejectedValue(new Error("temporary proxy failure"));
    const view = render(<MapReplaySection gameId="g1" />);
    await act(async () => fireEvent.click(button()));
    expect(button().disabled).toBe(true);
    harness.api.error = { status: 503, message: "temporary proxy failure" };
    view.rerender(<MapReplaySection gameId="g1" />);
    expect(screen.getByRole("status").textContent).toMatch(/Retrying while your desktop agent/);
    expect(button().disabled).toBe(true);
    harness.api.error = { status: 401, message: "You need to sign in again." };
    view.rerender(<MapReplaySection gameId="g1" />);
    expect(screen.getByRole("status").textContent).toBe("You need to sign in again.");
    expect(button().disabled).toBe(false);
  });

  it("shows the current job's capture error even when an old game has no playback", async () => {
    harness.api.data = null;
    harness.api.request.mockResolvedValue({ requestId: "current" });
    const view = render(<MapReplaySection gameId="g1" />);
    await act(async () => fireEvent.click(button()));
    harness.api.data = { ok: false, code: "not_computed", rebuild: {
      requestId: "previous", status: "failed", message: "Old failure",
    } };
    view.rerender(<MapReplaySection gameId="g1" />);
    expect(button().disabled).toBe(true);
    harness.api.data = { ok: false, code: "not_computed", rebuild: {
      requestId: "current", status: "failed", message: "Install StarCraft II before recording playback.",
    } };
    view.rerender(<MapReplaySection gameId="g1" />);
    expect(screen.getByRole("status").textContent).toBe("Install StarCraft II before recording playback.");
    expect(button().disabled).toBe(false);
  });
});
