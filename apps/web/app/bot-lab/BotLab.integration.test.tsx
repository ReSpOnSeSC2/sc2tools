import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: "admin", isLoaded: true, isSignedIn: true, getToken: async () => "test-token" }) }));
import { BotLab } from "./BotLab";

afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });
describe("launch acknowledgement and status ordering", () => {
  it("does not query the journal before reservation and uses the accepted session after a delayed POST", async () => {
    localStorage.clear();
    let finish!: (response: Response) => void;
    let requestId = "";
    const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.includes("/catalog")) return Response.json({ enabled: true, startWorkers: 8, deviceId: "device", devices: [{ id: "device", label: "Desktop" }], activeSessionId: null,
        agent: { available: true, ready: true }, bots: [{ id: "coach", label: "Coached Protoss", race: "Protoss", maxApm: 200, cameraRestricted: true }], maps: [{ id: "map", label: "Map LE" }] });
      if (init.method === "POST") {
        requestId = JSON.parse(init.body as string).requestId;
        return new Promise<Response>(resolve => { finish = resolve; });
      }
      return Response.json({ id: requestId, deviceId: "device", status: "playing" });
    });
    vi.stubGlobal("fetch", fetcher);
    render(<SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}><BotLab /></SWRConfig>);
    await waitFor(() => expect((screen.getByRole("button", { name: "Start local game" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Start local game" }));
    await waitFor(() => expect(requestId).toHaveLength(32));
    expect(fetcher.mock.calls.filter(([url, init]) => url.includes("/sessions/") && init?.method !== "POST")).toHaveLength(0);
    await act(async () => finish(Response.json({ id: requestId, deviceId: "device", status: "starting" })));
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop local game" })).toBeTruthy());
    expect((screen.getByRole("button", { name: "Start local game" }) as HTMLButtonElement).disabled).toBe(true);
    expect(localStorage.getItem("sc2tools:bot-lab:admin")).toContain(requestId);
    await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.includes(`/sessions/${requestId}?deviceId=device`))).toBe(true));
    expect(screen.getByText("playing")).toBeTruthy();
  });
});
