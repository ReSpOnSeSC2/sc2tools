import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";
import { SettingsPublicProfile } from "../SettingsPublicProfile";
import { PLAYER_SETTINGS } from "@/components/public-profile/__fixtures__/publicPlayer";
const mocks = vi.hoisted(() => ({ owner: "owner-a" as string | null, token: vi.fn(), fetch: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: mocks.owner, isLoaded: true, isSignedIn: Boolean(mocks.owner), getToken: mocks.token }) }));
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: () => <a href="/help/public-profile">Help</a> }));
const response = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(next => { resolve = next; }); return { promise, resolve }; }
function mount() {
  const store = new Map();
  const ui = () => <SWRConfig value={{ provider: () => store, dedupingInterval: 0, shouldRetryOnError: false }}><SettingsPublicProfile /></SWRConfig>;
  const view = render(ui()); return { ...view, update: () => view.rerender(ui()) };
}
beforeEach(() => {
  mocks.owner = "owner-a"; mocks.token.mockReset(); mocks.fetch.mockReset();
  mocks.token.mockImplementation(async () => `fixture-token-${mocks.owner}`);
  mocks.fetch.mockImplementation(async () => response(PLAYER_SETTINGS));
  vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("public player privacy settings", () => {
  it("does no write on mount and creates an address without enabling either public surface", async () => {
    mocks.fetch.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === "PUT" ? response(PLAYER_SETTINGS) : response({ ...PLAYER_SETTINGS, slug: null }));
    mount(); const create = await screen.findByRole("button", { name: "Create player link" });
    expect(mocks.fetch.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(0);
    fireEvent.click(create);
    await screen.findByText("Player link created. Your profile is still off.");
    const write = mocks.fetch.mock.calls.find(([, init]) => init?.method === "PUT")!;
    expect(JSON.parse(write[1].body)).toEqual({ enabled: false, slug: null, revision: 0, showReplays: false, showChannels: false, showRecentForm: false, showMmrHistory: false, showSeasons: false, showMaps: false });
    expect(JSON.parse(write[1].body)).not.toHaveProperty("signal");
    expect(screen.getByRole("checkbox", { name: "Public profile on" })).toHaveProperty("checked", false);
  });
  it("saves explicit Off even for a grandfathered named-build profile", async () => {
    const initial = { ...PLAYER_SETTINGS, legacyPublic: true };
    mocks.fetch.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === "PUT" ? response({ ...PLAYER_SETTINGS, revision: 1 }) : response(initial));
    mount(); const toggle = await screen.findByRole("checkbox", { name: "Public profile on" });
    expect(toggle).toHaveProperty("checked", true); fireEvent.click(toggle); fireEvent.click(screen.getByRole("button", { name: "Save public profile" }));
    await screen.findByText("Public profile settings saved.");
    const body = JSON.parse(mocks.fetch.mock.calls.find(([, init]) => init?.method === "PUT")![1].body);
    expect(body.enabled).toBe(false); expect(body.showReplays).toBe(false);
    expect(screen.queryByRole("link", { name: "Preview profile" })).toBeNull();
  });
  it("cannot rename an active archive or edit the server-owned suffix", async () => {
    mocks.fetch.mockResolvedValue(response({ ...PLAYER_SETTINGS, replaySharingEnabled: true }));
    mount(); const prefix = await screen.findByRole("textbox", { name: "Player link prefix" });
    expect(prefix).toHaveProperty("disabled", true); expect(screen.getByText(/Turn off replay sharing explicitly/)).toBeTruthy();
    expect(screen.getByText("sc2tools.com/players/frontier-0123456789")).toBeTruthy();
  });
  it("fences a save across A to B to A, without stale feedback or draft replacement", async () => {
    const pending = deferred<Response>();
    mocks.fetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") return pending.promise;
      const owner = new Headers(init?.headers).get("authorization");
      return response({ ...PLAYER_SETTINGS, slug: owner?.endsWith("owner-b") ? "beta-0123456789" : PLAYER_SETTINGS.slug });
    });
    const view = mount(); await screen.findByDisplayValue("frontier");
    fireEvent.click(screen.getByRole("checkbox", { name: "Public profile on" })); fireEvent.click(screen.getByRole("button", { name: "Save public profile" }));
    await waitFor(() => expect(mocks.fetch.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(true));
    mocks.owner = "owner-b"; view.update(); await screen.findByDisplayValue("beta");
    mocks.owner = "owner-a"; view.update(); await screen.findByDisplayValue("frontier");
    await act(async () => pending.resolve(response({ ...PLAYER_SETTINGS, enabled: true, revision: 1 })));
    expect(screen.getByRole("checkbox", { name: "Public profile on" })).toHaveProperty("checked", false);
    expect(screen.queryByText("Public profile settings saved.")).toBeNull();
  });
  it("does not dispatch after a deferred JWT belongs to a retired owner", async () => {
    const token = deferred<string | null>(); const view = mount(); await screen.findByDisplayValue("frontier");
    mocks.token.mockImplementationOnce(() => token.promise);
    fireEvent.click(screen.getByRole("checkbox", { name: "Public profile on" })); fireEvent.click(screen.getByRole("button", { name: "Save public profile" }));
    mocks.owner = "owner-b"; view.update(); await screen.findByDisplayValue("frontier");
    await act(async () => token.resolve("fixture-token-owner-a"));
    expect(mocks.fetch.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(0);
    expect(screen.queryByText("Public profile settings saved.")).toBeNull();
  });
  it("bounds a stalled save, keeps the draft and permits a retry", async () => {
    const pending = deferred<Response>();
    mocks.fetch.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === "PUT" ? pending.promise : response(PLAYER_SETTINGS));
    mount(); await screen.findByDisplayValue("frontier"); vi.useFakeTimers();
    fireEvent.click(screen.getByRole("checkbox", { name: "Public profile on" })); fireEvent.click(screen.getByRole("button", { name: "Save public profile" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(20_001); });
    expect(screen.getByRole("alert").textContent).toMatch(/Couldn't save/);
    expect(screen.getByRole("checkbox", { name: "Public profile on" })).toHaveProperty("checked", true);
    expect(screen.getByRole("button", { name: "Save public profile" })).toHaveProperty("disabled", false);
    await act(async () => pending.resolve(response({ ...PLAYER_SETTINGS, enabled: false })));
    expect(screen.getByRole("checkbox", { name: "Public profile on" })).toHaveProperty("checked", true);
  });
  it("keeps unavailable-prefix responses distinct from transient availability failures", async () => {
    mocks.fetch.mockImplementation(async (url: string) => url.includes("/public-profile/slug?") ? response({ slug: "reserved-0123456789", available: false, reason: "invalid_or_reserved" }) : response(PLAYER_SETTINGS));
    mount(); const prefix = await screen.findByRole("textbox", { name: "Player link prefix" }); fireEvent.change(prefix, { target: { value: "reserved" } });
    await screen.findByText("That prefix is unavailable or reserved.");
    expect(screen.getByRole("button", { name: "Save public profile" })).toHaveProperty("disabled", true);
  });
});
