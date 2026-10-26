import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { OfficialPlatformConnections } from "@/components/analyzer/settings/OfficialPlatformConnections";

const apiCallMock = vi.fn();
const useApiMock = vi.fn();
const mutateMock = vi.fn();
const successMock = vi.fn();
const errorMock = vi.fn();
const getToken = vi.fn();
let actualApiCall: typeof import("@/lib/clientApi").apiCall;
const auth = vi.hoisted(() => ({ owner: "owner-a" as string | null, loaded: true, signedIn: true }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken, userId: auth.owner, isLoaded: auth.loaded, isSignedIn: auth.signedIn }) }));
vi.mock("@/lib/clientApi", async original => ({
  ...await original<typeof import("@/lib/clientApi")>(),
  apiCall: (...args: unknown[]) => apiCallMock(...args),
  useApi: (...args: unknown[]) => useApiMock(...args),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: { success: successMock, error: errorMock } }) }));

function response(overrides: Record<string, unknown> = {}) {
  return { platforms: ["twitch", "kick", "youtube"].map((platform) => ({
    platform, configured: true, streamingAvailable: true, connected: false,
    ready: false, streamingConsent: false, platformUserName: "fixture_account",
    scopes: [], connectedAt: null, lastSyncedAt: null, lastError: null,
    ...(platform === "twitch" ? overrides : {}),
  })) };
}

beforeEach(async () => {
  actualApiCall = (await vi.importActual<typeof import("@/lib/clientApi")>("@/lib/clientApi")).apiCall;
  vi.useFakeTimers();
  apiCallMock.mockReset(); useApiMock.mockReset(); mutateMock.mockReset();
  successMock.mockReset(); errorMock.mockReset();
  auth.owner = "owner-a"; auth.loaded = true; auth.signedIn = true;
  getToken.mockReset().mockResolvedValue("owner-a-token");
  mutateMock.mockResolvedValue(undefined);
  const popup = { document: { title: "", body: { textContent: "" } },
    location: { replace: vi.fn() }, closed: false, close: vi.fn() };
  vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
  useApiMock.mockReturnValue({ data: response(), isLoading: false, mutate: mutateMock });
  apiCallMock.mockResolvedValue({ authorizeUrl: "https://id.twitch.tv/oauth2/authorize?state=fixture-state" });
});
afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("explicit stream control permission upgrade", () => {
  it("labels notification readiness separately from stream-control authorization", () => {
    const data = response();
    data.platforms = data.platforms.map((row) => ({ ...row, connected: true, ready: true,
      streamingConsent: row.platform !== "kick" }));
    useApiMock.mockReturnValue({ data, isLoading: false, mutate: mutateMock });
    render(<OfficialPlatformConnections />);
    const kick = within(screen.getByRole("group", { name: "Kick account permissions" }));
    expect(kick.getByText("Notifications ready")).toBeTruthy();
    expect(kick.getByText("Stream controls need permission")).toBeTruthy();
    expect(kick.getByRole("button", { name: "Connect stream controls" })).toHaveProperty("disabled", false);
    for (const platform of ["Twitch", "YouTube"]) {
      const account = within(screen.getByRole("group", { name: `${platform} account permissions` }));
      expect(account.getByText("Stream controls authorized")).toBeTruthy();
      expect(account.queryByRole("button", { name: "Connect stream controls" })).toBeNull();
    }
    expect(screen.queryByText(/^Connected$/)).toBeNull();
  });
  it("keeps authorized controls visible when notification setup needs a retry", () => {
    useApiMock.mockReturnValue({ data: response({ connected: true, ready: false, streamingConsent: true }),
      isLoading: false, mutate: mutateMock });
    render(<OfficialPlatformConnections />);
    const twitch = within(screen.getByRole("group", { name: "Twitch account permissions" }));
    expect(twitch.getByText("Notifications need retry")).toBeTruthy();
    expect(twitch.getByText("Stream controls authorized")).toBeTruthy();
  });
  it("requires a current connection before displaying old consent as authorized", () => {
    useApiMock.mockReturnValue({ data: response({ connected: false, streamingConsent: true }),
      isLoading: false, mutate: mutateMock });
    render(<OfficialPlatformConnections />);
    const twitch = within(screen.getByRole("group", { name: "Twitch account permissions" }));
    expect(twitch.queryByText("Stream controls authorized")).toBeNull();
    expect(twitch.getByRole("button", { name: "Connect stream controls" })).toHaveProperty("disabled", false);
  });
  it("explains that the same SC2Tools account shares permissions while pairing and OBS setup are separate", () => {
    render(<OfficialPlatformConnections />);
    expect(screen.getByText(/desktop agent paired to this same SC2Tools account/)).toBeTruthy();
    expect(screen.getByText(/Agent pairing and OBS output setup are separate steps/)).toBeTruthy();
  });
  it("preserves the normal notification-only connection request", async () => {
    render(<OfficialPlatformConnections />);
    fireEvent.click(screen.getAllByRole("button", { name: /^Connect$/ })[0]);
    await act(async () => { await Promise.resolve(); });
    expect(apiCallMock.mock.calls[0][1]).toBe("/v1/me/integrations/twitch/connect");
    expect(apiCallMock.mock.calls[0][2]).toEqual({ method: "POST", body: "{}" });
  });
  it("requests streaming scopes only when the user chooses Connect stream controls", async () => {
    render(<OfficialPlatformConnections />);
    fireEvent.click(screen.getAllByRole("button", { name: "Connect stream controls" })[0]);
    await act(async () => { await Promise.resolve(); });
    expect(JSON.parse(apiCallMock.mock.calls[0][2].body)).toEqual({ purpose: "streaming" });
    expect(window.open).toHaveBeenCalledTimes(1);
  });
  it("does not offer an enabled stream control action when coordination is unavailable", () => {
    useApiMock.mockReturnValue({ data: response({ streamingAvailable: false }), isLoading: false, mutate: mutateMock });
    render(<OfficialPlatformConnections />);
    expect(screen.getAllByRole("button", { name: "Connect stream controls" })[0]).toHaveProperty("disabled", true);
    expect(screen.getAllByRole("button", { name: /^Connect$/ })[0]).toHaveProperty("disabled", false);
  });
  it("confirms streaming consent independently from notification worker readiness", async () => {
    apiCallMock.mockResolvedValueOnce({ authorizeUrl: "https://id.twitch.tv/oauth2/authorize?state=fixture-state" })
      .mockResolvedValueOnce(response({ connected: true, streamingConsent: true, ready: false,
        connectedAt: "2026-10-08T12:00:00Z" }));
    render(<OfficialPlatformConnections />);
    fireEvent.click(screen.getAllByRole("button", { name: "Connect stream controls" })[0]);
    await act(async () => { await Promise.resolve(); await vi.advanceTimersByTimeAsync(2_000); });
    expect(successMock).toHaveBeenCalledWith("Twitch stream controls connected", expect.any(Object));
    expect(errorMock).not.toHaveBeenCalled();
  });
  it("reconnects already authorized stream controls without downgrading their permissions", async () => {
    useApiMock.mockReturnValue({ data: response({ connected: true, streamingConsent: true, ready: true,
      connectedAt: "2026-10-07T12:00:00Z" }), isLoading: false, mutate: mutateMock });
    render(<OfficialPlatformConnections />);
    fireEvent.click(screen.getByRole("button", { name: /^Reconnect$/ }));
    await act(async () => { await Promise.resolve(); });
    expect(JSON.parse(apiCallMock.mock.calls[0][2].body)).toEqual({ purpose: "streaming" });
  });
});

const connectedAt = "2026-10-26T12:00:00Z";
const connected = () => response({ connected: true, ready: true, streamingConsent: true, connectedAt });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function mockDisconnectTransport() {
  const transport = vi.fn(async (_url: string, init?: RequestInit) => json(init?.method === "DELETE" ? { disconnected: true } : response()));
  vi.stubGlobal("fetch", transport);
  mutateMock.mockImplementation(async update => typeof update === "function" ? update(connected()) : update);
  // Keep real JWT/header/body handling and the real owner-request hook.
  apiCallMock.mockImplementation((token: () => Promise<string | null>, path: string, init?: RequestInit) => actualApiCall(token, path, init));
  return transport;
}
function showConnection(data = connected()) {
  useApiMock.mockReturnValue({ data, isLoading: false, mutate: mutateMock });
}
async function consent() {
  const trigger = within(screen.getByRole("group", { name: "Twitch account permissions" })).getByRole("button", { name: "Disconnect" });
  trigger.focus(); fireEvent.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: "Disconnect Twitch?" });
  expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(dialog.textContent).toContain("This stops its notifications and stream controls.");
  return { trigger, dialog, approve: within(dialog).getByRole("button", { name: "Disconnect Twitch" }) };
}

describe("explicit platform disconnect consent", () => {
  beforeEach(() => { vi.useRealTimers(); showConnection(); });

  it.each(["Cancel", "Escape", "scrim"])("makes no request after %s and returns focus", async method => {
    const transport = mockDisconnectTransport(); const native = vi.spyOn(window, "confirm");
    render(<OfficialPlatformConnections />);
    const { trigger, dialog } = await consent();
    if (method === "Escape") fireEvent.keyDown(dialog, { key: "Escape" });
    else fireEvent.click(method === "Cancel" ? within(dialog).getByRole("button", { name: "Cancel" }) : screen.getByRole("button", { name: "Close dialog" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(transport).not.toHaveBeenCalled(); expect(native).not.toHaveBeenCalled(); expect(window.open).not.toHaveBeenCalled();
  });

  it("requires one danger approval, deletes once, and seeds the same-owner status without another read", async () => {
    const transport = mockDisconnectTransport(); const fresh = response();
    const view = render(<OfficialPlatformConnections />);
    mutateMock.mockImplementation(async (update, revalidate) => {
      expect(revalidate).toBe(false);
      const value = typeof update === "function" ? update(connected()) : update;
      showConnection(value); view.rerender(<OfficialPlatformConnections />); return value;
    });
    const { trigger, approve } = await consent();
    fireEvent.click(trigger); expect(screen.getAllByRole("dialog")).toHaveLength(1);
    fireEvent.click(approve); fireEvent.click(approve);
    await waitFor(() => expect(successMock).toHaveBeenCalledWith("Twitch disconnected"));
    expect(transport).toHaveBeenCalledTimes(2);
    const [url, options] = transport.mock.calls[0];
    expect(url).toMatch(/\/v1\/me\/integrations\/twitch$/); expect(options?.method).toBe("DELETE");
    expect(options?.body).toBeUndefined(); expect(new Headers(options?.headers).get("authorization")).toBe("Bearer owner-a-token");
    expect(transport.mock.calls[1][0]).toMatch(/\/v1\/me\/integrations$/);
    expect(transport.mock.calls[1][1]?.method).toBeUndefined(); expect(mutateMock).toHaveBeenCalledWith(expect.any(Function), false);
    expect(mutateMock.mock.calls[0][0](fresh)).toBe(fresh);
    expect(errorMock).not.toHaveBeenCalled(); expect(window.open).not.toHaveBeenCalled();
  });

  it.each(["delete", "refresh"])("does not repeat a mutation after a failed %s without new approval", async failure => {
    const transport = mockDisconnectTransport(); let failing = true;
    transport.mockImplementation(async (_url, init) => failing && (failure === "delete" ? init?.method === "DELETE" : !init?.method)
      ? json({ error: { code: "internal_error", message: "Synthetic unavailable" } }, 503) : json(init?.method === "DELETE" ? { disconnected: true } : response()));
    const view = render(<OfficialPlatformConnections />); fireEvent.click((await consent()).approve);
    await waitFor(() => expect(errorMock).toHaveBeenCalledWith("Could not confirm Twitch disconnection", expect.objectContaining({ description: expect.stringContaining("Check this account's status") })));
    view.rerender(<OfficialPlatformConnections />);
    expect(transport.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
    failing = false; fireEvent.click((await consent()).approve);
    await waitFor(() => expect(successMock).toHaveBeenCalledWith("Twitch disconnected"));
    expect(transport.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(2);
  });

  it.each(["still connected", "missing", "invalid", "duplicate", "invalid response"])("does not claim success for a %s status after DELETE", async variant => {
    const transport = mockDisconnectTransport(); const stale = connected();
    let fresh: unknown = response();
    if (variant === "still connected") fresh = stale;
    if (variant === "missing") fresh = { platforms: response().platforms.filter(row => row.platform !== "twitch") };
    if (variant === "invalid") fresh = { platforms: response().platforms.map(row => row.platform === "twitch" ? { ...row, connected: "false" } : row) };
    if (variant === "duplicate") fresh = { platforms: [response().platforms[0], ...response().platforms] };
    if (variant === "invalid response") fresh = { platforms: null };
    transport.mockImplementation(async (_url, init) => json(init?.method === "DELETE" ? { disconnected: true } : fresh));
    render(<OfficialPlatformConnections />); fireEvent.click((await consent()).approve);
    await waitFor(() => expect(errorMock).toHaveBeenCalledWith("Could not confirm Twitch disconnection", expect.objectContaining({ description: expect.stringContaining("Check this account's status") })));
    expect(transport).toHaveBeenCalledTimes(2); expect(mutateMock).not.toHaveBeenCalled(); expect(successMock).not.toHaveBeenCalled();
    const { dialog } = await consent(); fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(transport).toHaveBeenCalledTimes(2);
  });
});

describe("disconnect cache acknowledgement admission", () => {
  beforeEach(() => { vi.useRealTimers(); showConnection(); });

  it.each([false, true])("retires success and cache publication after a reconnect while cache ACK is held (ABA %s)", async aba => {
    const transport = mockDisconnectTransport();
    let release!: () => void;
    let publish!: (cached: ReturnType<typeof response>) => ReturnType<typeof response>;
    const view = render(<OfficialPlatformConnections />);
    mutateMock.mockImplementation((update, revalidate) => {
      expect(revalidate).toBe(false); expect(update).toBeTypeOf("function"); publish = update;
      showConnection(update(connected())); view.rerender(<OfficialPlatformConnections />);
      return new Promise<void>(resolve => { release = resolve; });
    });
    fireEvent.click((await consent()).approve);
    await waitFor(() => expect(release).toBeTypeOf("function"));
    const reconnected = response({ connected: true, ready: true, streamingConsent: true, connectedAt: "2026-10-26T14:00:00Z" });
    showConnection(reconnected); view.rerender(<OfficialPlatformConnections />);
    if (aba) { showConnection(response()); view.rerender(<OfficialPlatformConnections />); }
    // An updater invoked after retirement must retain whatever is now cached.
    expect(publish(reconnected)).toBe(reconnected);
    await act(async () => { release(); });
    expect(successMock).not.toHaveBeenCalled(); expect(errorMock).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledTimes(2); expect(mutateMock).toHaveBeenCalledOnce();
  });

  it("retains a newer cache revision before React has rendered it and never revives the old updater", async () => {
    const transport = mockDisconnectTransport(); let release!: () => void;
    let publish!: (cached: ReturnType<typeof response>) => ReturnType<typeof response>;
    mutateMock.mockImplementation(update => {
      publish = update; return new Promise<void>(resolve => { release = resolve; });
    });
    render(<OfficialPlatformConnections />); fireEvent.click((await consent()).approve);
    await waitFor(() => expect(release).toBeTypeOf("function"));
    const newer = response({ connected: true, ready: true, connectedAt: "2026-10-26T15:00:00Z" });
    // Deliberately do not rerender: the guarded updater sees the newer cache first.
    expect(publish(newer)).toBe(newer);
    const expectedAgain = response(); expect(publish(expectedAgain)).toBe(expectedAgain);
    await act(async () => { release(); });
    expect(successMock).not.toHaveBeenCalled(); expect(errorMock).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledTimes(2); expect(mutateMock).toHaveBeenCalledOnce();
  });

  it("does not repopulate a cleared cache or revive when expected values return before React renders", async () => {
    const transport = mockDisconnectTransport(); let release!: () => void;
    let publish!: (cached: ReturnType<typeof response> | undefined) => ReturnType<typeof response> | undefined;
    mutateMock.mockImplementation(update => {
      publish = update; return new Promise<void>(resolve => { release = resolve; });
    });
    render(<OfficialPlatformConnections />); fireEvent.click((await consent()).approve);
    await waitFor(() => expect(release).toBeTypeOf("function"));
    expect(publish(undefined)).toBeUndefined();
    const expectedAgain = response(); expect(publish(expectedAgain)).toBe(expectedAgain);
    await act(async () => { release(); });
    expect(successMock).not.toHaveBeenCalled(); expect(errorMock).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledTimes(2); expect(mutateMock).toHaveBeenCalledOnce();
  });
});

type Retirement = "owner ABA" | "revision ABA" | "auth loading" | "sign out" | "unmount";
function retire(view: ReturnType<typeof render>, boundary: Retirement) {
  if (boundary === "unmount") { view.unmount(); return; }
  if (boundary === "owner ABA") auth.owner = "owner-b";
  if (boundary === "revision ABA") showConnection(response({ connected: true, ready: true, connectedAt: "2026-10-26T13:00:00Z" }));
  if (boundary === "auth loading") auth.loaded = false;
  if (boundary === "sign out") { auth.signedIn = false; auth.owner = null; }
  view.rerender(<OfficialPlatformConnections />);
  if (boundary === "owner ABA" || boundary === "revision ABA") {
    auth.owner = "owner-a"; showConnection(); view.rerender(<OfficialPlatformConnections />);
  }
}
const boundaries: Retirement[] = ["owner ABA", "revision ABA", "auth loading", "sign out", "unmount"];

describe("retired disconnect decisions and JWTs", () => {
  beforeEach(() => { vi.useRealTimers(); showConnection(); });

  it.each(boundaries)("retires a pending approval on %s", async boundary => {
    const transport = mockDisconnectTransport(); const view = render(<OfficialPlatformConnections />);
    const { approve } = await consent(); retire(view, boundary);
    expect(screen.queryByRole("dialog")).toBeNull(); fireEvent.click(approve);
    expect(transport).not.toHaveBeenCalled(); expect(successMock).not.toHaveBeenCalled();
  });

  it.each(boundaries)("withholds a held JWT after approval on %s", async boundary => {
    const transport = mockDisconnectTransport(); let release!: (value: string) => void;
    getToken.mockImplementation(() => new Promise<string>(resolve => { release = resolve; }));
    const view = render(<OfficialPlatformConnections />); fireEvent.click((await consent()).approve);
    await waitFor(() => expect(release).toBeTypeOf("function")); retire(view, boundary);
    await act(async () => { release("retired-token"); });
    expect(transport).not.toHaveBeenCalled(); expect(mutateMock).not.toHaveBeenCalled(); expect(successMock).not.toHaveBeenCalled(); expect(errorMock).not.toHaveBeenCalled();
  });

  it("does not offer a live disconnect action while authentication is not ready", () => {
    auth.loaded = false; render(<OfficialPlatformConnections />);
    expect(within(screen.getByRole("group", { name: "Twitch account permissions" })).getByRole("button", { name: "Disconnect" })).toHaveProperty("disabled", true);
  });

  it.each(["delete body", "status body"])("retires a held %s after an owner ABA without a late toast or refresh", async held => {
    const transport = mockDisconnectTransport(); let release!: (value: unknown) => void;
    transport.mockImplementation(async (_url, init) => {
      if ((held === "delete body") === (init?.method === "DELETE")) {
        return { ok: true, status: 200, json: () => new Promise(resolve => { release = resolve; }) } as Response;
      }
      return json({ disconnected: true });
    });
    const view = render(<OfficialPlatformConnections />); fireEvent.click((await consent()).approve);
    await waitFor(() => expect(release).toBeTypeOf("function"));
    const calls = transport.mock.calls.length; retire(view, "owner ABA");
    await act(async () => { release(held === "delete body" ? { disconnected: true } : response()); });
    expect(transport).toHaveBeenCalledTimes(calls); expect(mutateMock).not.toHaveBeenCalled(); expect(successMock).not.toHaveBeenCalled(); expect(errorMock).not.toHaveBeenCalled();
  });

  it("does not send an anonymous DELETE when the current JWT is unavailable", async () => {
    const transport = mockDisconnectTransport(); getToken.mockResolvedValue(null);
    render(<OfficialPlatformConnections />); fireEvent.click((await consent()).approve);
    await waitFor(() => expect(errorMock).toHaveBeenCalledWith("Could not confirm Twitch disconnection", expect.objectContaining({ description: expect.stringContaining("Sign in again") })));
    expect(transport).not.toHaveBeenCalled(); expect(mutateMock).not.toHaveBeenCalled();
  });
});

describe("whole disconnect request deadline", () => {
  beforeEach(() => { showConnection(); });

  it.each(["token", "delete body", "status body"])("settles a held %s at20s and retires its later delivery", async held => {
    const transport = mockDisconnectTransport(); let release!: (value: unknown) => void;
    if (held === "token") getToken.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    else transport.mockImplementation(async (_url, init) => {
      if ((held === "delete body") === (init?.method === "DELETE")) {
        return { ok: true, status: 200, json: () => new Promise(resolve => { release = resolve; }) } as Response;
      }
      return init?.method === "DELETE" ? new Response(null, { status: 204 }) : json(response());
    });
    render(<OfficialPlatformConnections />);
    fireEvent.click(within(screen.getByRole("group", { name: "Twitch account permissions" })).getByRole("button", { name: "Disconnect" }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Twitch" }));
    for (let turn = 0; turn < 8 && !release; turn += 1) await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(release).toBeTypeOf("function");
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(errorMock).toHaveBeenCalledWith("Could not confirm Twitch disconnection", expect.objectContaining({ description: expect.stringContaining("Check this account's status") }));
    expect(successMock).not.toHaveBeenCalled(); expect(mutateMock).not.toHaveBeenCalled();
    const calls = transport.mock.calls.length;
    if (release) await act(async () => { release(held === "token" ? "late-token" : held === "delete body" ? { disconnected: true } : response()); });
    expect(transport).toHaveBeenCalledTimes(calls); expect(successMock).not.toHaveBeenCalled(); expect(mutateMock).not.toHaveBeenCalled();
    expect(screen.getByRole("group", { name: "Twitch account permissions" }).querySelector('button[aria-busy="true"]')).toBeNull();
  });
});
