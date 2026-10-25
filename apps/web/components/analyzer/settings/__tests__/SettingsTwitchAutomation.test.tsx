import { StrictMode } from "react";
import Link from "next/link";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsTwitchAutomation } from "../SettingsTwitchAutomation";
import { LazyTwitchAutomationSettings } from "../LazyTwitchAutomationSettings";
import { DEFAULT_TWITCH_AUTOMATION } from "@/lib/twitchAutomation";
const auth = vi.hoisted(() => ({ value: { userId: "A" as string | null, isLoaded: true, isSignedIn: true, getToken: vi.fn<() => Promise<string | null>>() } }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => auth.value }));
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: ({ children }: { children: React.ReactNode }) => <Link href="/help/viewer-engagement#twitch-predictions">{children}</Link> }));
const ready = { serverEnabled: true, configured: true, connected: true, predictionPermission: true, markerPermission: true, eligible: true, isLive: true, reason: null, preferences: DEFAULT_TWITCH_AUTOMATION, current: null };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  auth.value = { userId: "A", isLoaded: true, isSignedIn: true, getToken: vi.fn(async () => "token-A") };
  fetcher = vi.fn(async (_url: string, init?: RequestInit) => init?.method === "PUT" ? json(JSON.parse(String(init.body))) : json(ready)); vi.stubGlobal("fetch", fetcher);
  window.history.replaceState(null, "", "/settings?tab=overlay&section=chat");
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function loaded() { await waitFor(() => expect(screen.getByRole("button", { name: "Refresh status" }).hasAttribute("disabled")).toBe(false)); }
const marker = () => screen.getByRole("switch", { name: "Add a stream marker at each game start" });

describe("Twitch automation explicit settings", () => {
  it("starts both choices off and only writes after an explicit valid Save", async () => {
    render(<SettingsTwitchAutomation />); await loaded(); expect(marker().getAttribute("aria-checked")).toBe("false");
    expect(fetcher.mock.calls.every(call => call[1]?.method !== "PUT")).toBe(true); fireEvent.click(marker());
    fireEvent.change(screen.getByLabelText("Prediction window (30–300 seconds)"), { target: { value: "29" } }); expect(screen.getByRole("button", { name: "Save Twitch automation" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("Prediction window (30–300 seconds)"), { target: { value: "120" } }); fireEvent.click(screen.getByRole("button", { name: "Save Twitch automation" }));
    await screen.findByText("Twitch automation preferences saved."); const call = fetcher.mock.calls.find(call => call[1]?.method === "PUT");
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ markersEnabled: true, predictionsEnabled: false, windowSec: 120 });
  });
  it("shows server-off and ranked-unknown capability honestly, with connection/enablement disabled", async () => {
    fetcher.mockResolvedValue(json({ ...ready, serverEnabled: false, eligible: null, reason: "server_not_enabled" })); render(<SettingsTwitchAutomation />); await loaded();
    expect(screen.getByText(/paused by the server owner/)).toBeTruthy(); expect(screen.getByText(/cannot prove ranked queue status/)).toBeTruthy();
    expect(marker().hasAttribute("disabled")).toBe(true); expect(screen.getByRole("button", { name: "Reconnect Predictions" }).hasAttribute("disabled")).toBe(true);
  });
  it("connect requests only its explicit purpose and never switches on a preference", async () => {
    const popup = { close: vi.fn(), location: { replace: vi.fn() } }; vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    fetcher.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === "POST" ? json({ authorizeUrl: "https://id.twitch.tv/oauth2/authorize?scope=channel%3Amanage%3Apredictions&state=fixture" }) : json(ready));
    render(<SettingsTwitchAutomation />); await loaded(); fireEvent.click(screen.getByRole("button", { name: "Reconnect Predictions" })); await screen.findByText(/Complete the Twitch connection in its window/);
    expect(JSON.parse(String(fetcher.mock.calls.find(call => call[1]?.method === "POST")?.[1]?.body))).toEqual({ purpose: "predictions" });
    expect(popup.location.replace).toHaveBeenCalledTimes(1); expect(marker().getAttribute("aria-checked")).toBe("false"); expect(fetcher.mock.calls.some(call => call[1]?.method === "PUT")).toBe(false);
  });
  it("StrictMode performs no automatic mutation or duplicate consent", async () => {
    render(<StrictMode><SettingsTwitchAutomation /></StrictMode>); await loaded(); expect(fetcher.mock.calls.every(call => !call[1]?.method)).toBe(true);
  });
  it("loading/signed-out with a stale userId hides settings and blocks held JWT reads", async () => {
    const token = deferred<string>(); auth.value.getToken.mockReturnValue(token.promise); const view = render(<SettingsTwitchAutomation />);
    auth.value = { ...auth.value, isLoaded: false }; view.rerender(<SettingsTwitchAutomation />); await act(async () => token.resolve("late-token")); expect(fetcher).not.toHaveBeenCalled(); expect(screen.queryByRole("switch")).toBeNull();
    auth.value = { ...auth.value, isLoaded: true, isSignedIn: false }; view.rerender(<SettingsTwitchAutomation />); expect(screen.queryByRole("switch")).toBeNull();
  });
  it("an account switch during Save JWT does not send the old draft under the new token", async () => {
    const view = render(<SettingsTwitchAutomation />); await loaded(); const token = deferred<string>(); auth.value.getToken.mockReturnValueOnce(token.promise);
    fireEvent.click(marker()); fireEvent.click(screen.getByRole("button", { name: "Save Twitch automation" }));
    auth.value = { ...auth.value, userId: "B", getToken: vi.fn(async () => "token-B") }; view.rerender(<SettingsTwitchAutomation />); await loaded(); await act(async () => token.resolve("token-B"));
    expect(fetcher.mock.calls.some(call => call[1]?.method === "PUT")).toBe(false); expect(marker().getAttribute("aria-checked")).toBe("false");
  });
  it("late response bodies from A cannot change B's draft or success copy", async () => {
    const body = deferred<unknown>(); fetcher.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === "PUT" ? ({ ok: true, json: () => body.promise } as Response) : json(ready));
    const view = render(<SettingsTwitchAutomation />); await loaded(); fireEvent.click(marker()); fireEvent.click(screen.getByRole("button", { name: "Save Twitch automation" })); await waitFor(() => expect(fetcher.mock.calls.some(call => call[1]?.method === "PUT")).toBe(true));
    auth.value = { ...auth.value, userId: "B" }; view.rerender(<SettingsTwitchAutomation />); await loaded(); await act(async () => body.resolve({ ...DEFAULT_TWITCH_AUTOMATION, markersEnabled: true }));
    expect(marker().getAttribute("aria-checked")).toBe("false"); expect(screen.queryByText("Twitch automation preferences saved.")).toBeNull();
  });
  it("a held authentication request reaches a real deadline and permits retry", async () => {
    vi.useFakeTimers(); const held = deferred<string>(); auth.value.getToken.mockReturnValue(held.promise); render(<SettingsTwitchAutomation />);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_001); }); expect(screen.getByRole("alert").textContent).toContain("too long");
    expect(screen.getByRole("button", { name: "Refresh status" }).hasAttribute("disabled")).toBe(false); vi.useRealTimers(); auth.value.getToken.mockResolvedValue("token-A"); fireEvent.click(screen.getByRole("button", { name: "Refresh status" })); await loaded(); expect(marker().getAttribute("aria-checked")).toBe("false");
  });
  it("an old A response cannot clear the new A Save after A→B→A", async () => {
    const first = deferred<unknown>(), second = deferred<unknown>(); let writes = 0;
    fetcher.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === "PUT" ? ({ ok: true, json: () => (++writes === 1 ? first.promise : second.promise) } as Response) : json(ready));
    const view = render(<SettingsTwitchAutomation />); await loaded(); fireEvent.click(marker()); fireEvent.click(screen.getByRole("button", { name: "Save Twitch automation" })); await waitFor(() => expect(writes).toBe(1));
    auth.value = { ...auth.value, userId: "B" }; view.rerender(<SettingsTwitchAutomation />); await loaded(); auth.value = { ...auth.value, userId: "A" }; view.rerender(<SettingsTwitchAutomation />); await loaded();
    fireEvent.click(marker()); fireEvent.click(screen.getByRole("button", { name: "Save Twitch automation" })); await waitFor(() => expect(writes).toBe(2));
    await act(async () => first.resolve({ ...DEFAULT_TWITCH_AUTOMATION, markersEnabled: true })); expect(screen.getByRole("button", { name: "Save Twitch automation" }).hasAttribute("disabled")).toBe(true); expect(screen.queryByText("Twitch automation preferences saved.")).toBeNull();
    await act(async () => second.resolve({ ...DEFAULT_TWITCH_AUTOMATION, markersEnabled: true })); await screen.findByText("Twitch automation preferences saved.");
  });
  it("keeps the optional settings chunk local and retries a failed load", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const loader = vi.fn().mockRejectedValueOnce(new Error("mock chunk failure")).mockResolvedValue(() => <p>Recovered Twitch editor</p>);
    const view = render(<LazyTwitchAutomationSettings loader={loader} />); expect(loader).not.toHaveBeenCalled(); const details = view.container.querySelector("details")!;
    details.open = true; fireEvent(details, new Event("toggle")); await screen.findByRole("button", { name: "Retry Twitch settings" }); fireEvent.click(screen.getByRole("button", { name: "Retry Twitch settings" })); await screen.findByText("Recovered Twitch editor"); expect(loader).toHaveBeenCalledTimes(2); consoleError.mockRestore();
  });
});
