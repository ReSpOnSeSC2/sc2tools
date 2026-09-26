import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotLabCatalog, BotLabSession } from "@/lib/botLab";

const harness = vi.hoisted(() => ({
  userId: "admin", post: vi.fn(), refresh: vi.fn(), statusMutate: vi.fn(),
  catalog: null as BotLabCatalog | null, session: undefined as BotLabSession | undefined,
  statusPath: null as string | null, interval: undefined as ((value?: BotLabSession) => number) | undefined,
}));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: harness.userId, getToken: async () => "test-token" }) }));
vi.mock("@/lib/clientApi", () => ({
  apiCall: (...args: unknown[]) => harness.post(...args),
  useApi: (path: string | null, config: { refreshInterval?: (value?: BotLabSession) => number }) => {
    if (path?.includes("/catalog")) return { data: harness.catalog, mutate: harness.refresh };
    harness.statusPath = path; harness.interval = config.refreshInterval;
    return { data: harness.session, mutate: harness.statusMutate };
  },
}));
import { BotLab } from "./BotLab";

const id = "1".repeat(32);
beforeEach(() => {
  localStorage.clear(); harness.userId = "admin"; harness.session = undefined;
  harness.post.mockReset(); harness.refresh.mockReset(); harness.statusMutate.mockReset();
  vi.spyOn(crypto, "randomUUID").mockReturnValue("11111111-1111-1111-1111-111111111111");
  harness.catalog = { enabled: true, startWorkers: 8, devices: [{ id: "device", label: "Desktop" }], deviceId: "device", activeSessionId: null,
    agent: { available: true, ready: true }, bots: [{ id: "coach", label: "Coached Protoss", race: "Protoss", updates: 0, maxApm: 200, cameraRestricted: true }], maps: [{ id: "map", label: "Map LE" }] };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("private bot practice controls", () => {
  it("saves the exact request before sending and does not launch twice on a double click", async () => {
    let resolve!: (value: BotLabSession) => void;
    harness.post.mockImplementation(() => {
      expect(JSON.parse(localStorage.getItem("sc2tools:bot-lab:admin")!).id).toBe(id);
      return new Promise(done => { resolve = done; });
    });
    render(<BotLab />);
    fireEvent.click(screen.getByRole("button", { name: "Start local game" }));
    fireEvent.click(screen.getByRole("button", { name: "Starting local game…" }));
    expect(harness.post).toHaveBeenCalledTimes(1);
    expect(JSON.parse(harness.post.mock.calls[0][2].body)).toEqual({ deviceId: "device", requestId: id, botId: "coach", mapId: "map", humanRace: "Protoss" });
    await act(async () => resolve({ id, deviceId: "device", status: "playing" }));
    expect(screen.getByText("playing")).toBeTruthy();
    expect(harness.statusPath).toBe(`/v1/bot-lab/sessions/${id}?deviceId=device`);
  });
  it("retains a lost acknowledgement and explicitly retries the SAME request", async () => {
    harness.post.mockRejectedValue(new Error("Connection interrupted"));
    render(<BotLab />);
    fireEvent.click(screen.getByRole("button", { name: "Start local game" }));
    await screen.findByRole("button", { name: "Retry same start request" });
    expect((screen.getByRole("button", { name: "Start local game" }) as HTMLButtonElement).disabled).toBe(true);
    const body = harness.post.mock.calls[0][2].body;
    fireEvent.click(screen.getByRole("button", { name: "Retry same start request" }));
    await waitFor(() => expect(harness.post).toHaveBeenCalledTimes(2));
    expect(harness.post.mock.calls[1][2].body).toBe(body);
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
  });
  it("restores a saved uncertain launch using GET status without automatically launching", () => {
    localStorage.setItem("sc2tools:bot-lab:admin", JSON.stringify({ id, deviceId: "device" }));
    render(<BotLab />);
    expect(harness.statusPath).toContain(id); expect(harness.post).not.toHaveBeenCalled();
    expect(harness.interval?.({ id, deviceId: "device", status: "playing" })).toBe(4000);
    expect(harness.interval?.({ id, deviceId: "device", status: "finished" })).toBe(0);
  });
  it("offers the same saved start after reopening an unconfirmed launch", async () => {
    const start = { requestId: id, deviceId: "device", mapId: "map", botId: "coach", humanRace: "Protoss" };
    localStorage.setItem("sc2tools:bot-lab:admin", JSON.stringify({ id, deviceId: "device", start }));
    harness.session = { id, deviceId: "device", status: "unknown" };
    harness.post.mockResolvedValue({ id, deviceId: "device", status: "playing" });
    render(<BotLab />);
    expect(harness.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry same start request" }));
    await waitFor(() => expect(harness.post).toHaveBeenCalledTimes(1));
    expect(JSON.parse(harness.post.mock.calls[0][2].body)).toEqual(start);
    expect(crypto.randomUUID).not.toHaveBeenCalled();
  });
  it("does not start while the replay engine is busy", () => {
    harness.catalog!.agent = { available: true, ready: false, code: "engine_busy", message: "Replay mapping is using StarCraft II." };
    render(<BotLab />);
    expect((screen.getByRole("button", { name: "Start local game" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Replay mapping is using StarCraft II.")).toBeTruthy();
    expect(harness.post).not.toHaveBeenCalled();
  });
  it("stops only the saved session on its selected computer", async () => {
    localStorage.setItem("sc2tools:bot-lab:admin", JSON.stringify({ id, deviceId: "device" }));
    harness.session = { id, deviceId: "device", status: "playing" };
    harness.post.mockResolvedValue({ id, deviceId: "device", status: "closed" });
    render(<BotLab />); fireEvent.click(screen.getByRole("button", { name: "Stop local game" }));
    await waitFor(() => expect(harness.statusMutate).toHaveBeenCalled());
    expect(harness.post.mock.calls[0][1]).toBe(`/v1/bot-lab/sessions/${id}/stop`);
    expect(JSON.parse(harness.post.mock.calls[0][2].body)).toEqual({ deviceId: "device" });
  });
  it("does not reveal the previous account's session after an account switch", () => {
    localStorage.setItem("sc2tools:bot-lab:admin", JSON.stringify({ id, deviceId: "device" }));
    const view = render(<BotLab />); expect(harness.statusPath).toContain(id);
    harness.userId = "other-admin"; view.rerender(<BotLab />);
    expect(harness.statusPath).toBeNull(); expect(screen.queryByRole("region", { name: "Game status" })).toBeNull();
  });
  it("adopts an existing catalog session after a different start was definitively refused", () => {
    localStorage.setItem("sc2tools:bot-lab:admin", JSON.stringify({ id, deviceId: "device" }));
    harness.session = { id, deviceId: "device", status: "failed", error: "A game is already active." };
    harness.catalog!.activeSessionId = "2".repeat(32);
    render(<BotLab />);
    expect(harness.statusPath).toContain("2".repeat(32));
    expect(JSON.parse(localStorage.getItem("sc2tools:bot-lab:admin")!).id).toBe("2".repeat(32));
    expect(harness.post).not.toHaveBeenCalled();
  });
});
