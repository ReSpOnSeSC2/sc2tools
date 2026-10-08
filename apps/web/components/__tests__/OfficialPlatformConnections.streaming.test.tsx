import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { OfficialPlatformConnections } from "@/components/analyzer/settings/OfficialPlatformConnections";

const apiCallMock = vi.fn();
const useApiMock = vi.fn();
const mutateMock = vi.fn();
const successMock = vi.fn();
const errorMock = vi.fn();
const getToken = vi.fn();
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken }) }));
vi.mock("@/lib/clientApi", () => ({
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

beforeEach(() => {
  vi.useFakeTimers();
  apiCallMock.mockReset(); useApiMock.mockReset(); mutateMock.mockReset();
  successMock.mockReset(); errorMock.mockReset();
  const popup = { document: { title: "", body: { textContent: "" } },
    location: { replace: vi.fn() }, closed: false, close: vi.fn() };
  vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
  useApiMock.mockReturnValue({ data: response(), isLoading: false, mutate: mutateMock });
  apiCallMock.mockResolvedValue({ authorizeUrl: "https://id.twitch.tv/oauth2/authorize?state=fixture-state" });
});
afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

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
