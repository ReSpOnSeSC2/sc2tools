import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsSaveScope } from "../SettingsSaveBar";
import { SettingsTwitchRewards } from "../SettingsTwitchRewards";

const auth = vi.hoisted(() => ({ userId: "fixture-owner", isLoaded: true, getToken: async () => "synthetic-token" }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => auth }));
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));

const TARGET = "a".repeat(64);
const INITIAL = { settings: { enabled: false, target: null, mappings: [] }, available: true, permission: true, targets: [{ id: TARGET, label: "My overlay" }], builds: [], activity: [] };
const REWARDS = [{ id: "managed", title: "Managed reward", manageable: true, enabled: true, autoSkipsQueue: false }, { id: "manual", title: "Dashboard reward", manageable: false, enabled: true, autoSkipsQueue: false }];
function fixture() {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const pathname = new URL(String(input), "http://localhost").pathname;
    if (pathname.endsWith("/catalog")) return Response.json({ rewards: REWARDS });
    if (init?.method === "PUT") return Response.json(JSON.parse(String(init.body)));
    if (pathname.endsWith("/connect")) return Response.json({ authorizeUrl: "https://id.twitch.tv/oauth2/authorize?state=synthetic" });
    return Response.json(INITIAL);
  });
  vi.stubGlobal("fetch", fetch);
  render(<SettingsSaveScope tabId="chat"><SettingsTwitchRewards /></SettingsSaveScope>);
  return fetch;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Twitch rewards Settings", () => {
  it("requests reward consent only on Connect and leaves actions off", async () => {
    const fetch = fixture();
    const popup = { close: vi.fn(), location: { replace: vi.fn() } };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    await waitFor(() => expect((screen.getByRole("button", { name: "Reconnect reward actions" }) as HTMLButtonElement).disabled).toBe(false));
    expect(fetch.mock.calls.some(([path]) => String(path).endsWith("/connect"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Reconnect reward actions" }));
    await waitFor(() => expect(popup.location.replace).toHaveBeenCalledOnce());
    const call = fetch.mock.calls.find(([path]) => String(path).endsWith("/connect"));
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ purpose: "rewards" });
    expect((screen.getByRole("checkbox", { name: "Run mapped reward actions" }) as HTMLInputElement).checked).toBe(false);
  });

  it("maps a stable reward id, disables settlement for unmanaged rewards, and saves through the chat tab", async () => {
    const fetch = fixture();
    await waitFor(() => expect((screen.getByRole("button", { name: "Load Twitch rewards" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Load Twitch rewards" }));
    await screen.findByRole("option", { name: "Dashboard reward" });
    fireEvent.change(screen.getByLabelText("Reward to map"), { target: { value: "manual" } });
    fireEvent.click(screen.getByRole("button", { name: "Add mapping" }));
    expect((screen.getByRole("option", { name: "Refund if unavailable" }) as HTMLOptionElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Overlay target"), { target: { value: TARGET } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Enable mapping" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Run mapped reward actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Twitch channel points" }));
    await screen.findByText("Twitch reward settings saved.");
    const save = fetch.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(JSON.parse(String(save?.[1]?.body))).toMatchObject({ enabled: true, target: TARGET, mappings: [{ rewardId: "manual", action: "recap", settlement: "none" }] });
  });
});
