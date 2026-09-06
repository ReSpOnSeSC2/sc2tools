import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import AdminPlayerChannelsPage from "@/app/admin/player-channels/page";
import { SettingsPlayerChannels } from "@/components/analyzer/settings/SettingsPlayerChannels";
import type { MyPlayerChannelsResponse, PlayerChannelDirectoryResponse, PlayerChannelEntry } from "@/lib/playerChannelDirectory";

const apiCallMock = vi.fn();
const useApiMock = vi.fn();
const mutateMock = vi.fn();
const getToken = vi.fn();
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken }) }));
vi.mock("@/lib/clientApi", () => ({
  apiCall: (...args: unknown[]) => apiCallMock(...args),
  useApi: (...args: unknown[]) => useApiMock(...args),
}));

const ENTRY: PlayerChannelEntry = {
  id: "player-1", displayName: "Example player", pulseCharacterIds: [], toonHandles: ["1-S2-1-267727"],
  proId: null, channels: { twitch: "https://twitch.tv/example", youtube: "https://youtube.com/@example" },
  source: "self", removed: false, updatedAt: "2026-09-06T12:00:00Z", editable: true,
};

function setupMy(data: Partial<MyPlayerChannelsResponse> = {}) {
  const response = { entries: [ENTRY], identities: [{ toonHandle: "1-S2-1-267727" }], canConnect: true, ...data };
  useApiMock.mockReturnValue({ data: response, isLoading: false, mutate: mutateMock });
  return response;
}
function setupAdmin(data: Partial<PlayerChannelDirectoryResponse> = {}) {
  useApiMock.mockReturnValue({ data: { entries: [ENTRY], total: 1, page: 0, limit: 25, ...data }, isLoading: false, mutate: mutateMock });
}
function renderMy() {
  return render(<SettingsPlayerChannels savedPulseIds={["1-S2-1-267727"]} profileDirty={false} onDirtyChange={vi.fn()} />);
}

beforeEach(() => { apiCallMock.mockReset(); useApiMock.mockReset(); mutateMock.mockReset(); });
afterEach(cleanup);

describe("player channel settings", () => {
  it("saves canonical channels for the chosen stable identity and sends null to remove one platform", async () => {
    const response = setupMy();
    apiCallMock.mockResolvedValue(response);
    renderMy();
    fireEvent.change(screen.getByLabelText("Twitch channel URL"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("YouTube channel URL"), { target: { value: "https://www.youtube.com/@newchannel?si=tracking" } });
    fireEvent.click(screen.getByRole("button", { name: "Save channels" }));
    await waitFor(() => expect(apiCallMock).toHaveBeenCalledTimes(1));
    expect(apiCallMock.mock.calls[0][1]).toBe("/v1/me/player-channels");
    expect(JSON.parse(apiCallMock.mock.calls[0][2].body)).toEqual({
      identities: [{ toonHandle: "1-S2-1-267727" }], channels: { twitch: null, youtube: "https://youtube.com/@newchannel" },
    });
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(mutateMock).toHaveBeenCalledWith(response, { revalidate: false });
  });

  it("keeps the draft and reports a rejected save without claiming success", async () => {
    setupMy(); apiCallMock.mockRejectedValue({ status: 409, message: "This player is managed by an administrator." });
    renderMy();
    fireEvent.change(screen.getByLabelText("YouTube channel URL"), { target: { value: "https://youtube.com/@newchannel" } });
    fireEvent.click(screen.getByRole("button", { name: "Save channels" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "This player is managed by an administrator.");
    expect(screen.getByLabelText("YouTube channel URL")).toHaveProperty("value", "https://youtube.com/@newchannel");
    expect(screen.queryByRole("status")).toBeNull(); expect(mutateMock).not.toHaveBeenCalled();
  });

  it("shows imported entries as read-only and does not permit impersonating an existing player", () => {
    setupMy({ entries: [{ ...ENTRY, source: "sc2pulse", editable: false }] });
    renderMy();
    expect(screen.getByText(/managed by an administrator or another connected account/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save channels" })).toBeNull();
  });

  it("respects the server match when a saved toon resolves to a Pulse-only record", () => {
    setupMy({ entries: [{ ...ENTRY, toonHandles: [], pulseCharacterIds: ["994428"], source: "sc2pulse", editable: false }], identities: [{ toonHandle: "1-S2-1-267727", entryId: ENTRY.id }] });
    renderMy();
    expect(screen.getByText("Example player")).toBeTruthy();
    expect(screen.getByText(/managed by an administrator or another connected account/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save channels" })).toBeNull();
  });

  it("requires a saved identity before presenting a channel editor", () => {
    setupMy({ entries: [], identities: [], canConnect: false }); renderMy();
    expect(screen.getByText("Add your StarCraft II identity first")).toBeTruthy();
    expect(screen.queryByLabelText("YouTube channel URL")).toBeNull();
  });

  it("disconnects an owned record even after its profile identity was removed", async () => {
    setupMy({ identities: [], canConnect: false });
    apiCallMock.mockResolvedValue({ entries: [], identities: [], canConnect: false });
    renderMy();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Example player" }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect channels" }));
    await waitFor(() => expect(apiCallMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(apiCallMock.mock.calls[0][2].body)).toEqual({ id: "player-1", channels: { twitch: null, youtube: null } });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("status")).toHaveProperty("textContent", "Your connected channels have been removed.");
  });

  it("distinguishes pending submissions from approved public channels", () => {
    setupMy({ entries: [{ ...ENTRY, pending: true, channels: { youtube: "https://youtube.com/@requested" }, approvedChannels: { youtube: "https://youtube.com/@approved" } }] });
    renderMy();
    expect(screen.getByText("Pending review")).toBeTruthy();
    expect(screen.getByText("Your approved links remain public during review:")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "YouTube" }).map((link) => link.getAttribute("href"))).toEqual(["https://youtube.com/@requested", "https://youtube.com/@approved"]);
  });

  it("does not submit a video URL or an unrelated host", async () => {
    setupMy(); renderMy();
    fireEvent.change(screen.getByLabelText("YouTube channel URL"), { target: { value: "https://youtube.com/watch?v=123" } });
    fireEvent.click(screen.getByRole("button", { name: "Save channels" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Video and playlist links are not channel links"));
    expect(apiCallMock).not.toHaveBeenCalled();
  });

  it("makes users choose a single record when separate saved identities have channels", () => {
    setupMy({ entries: [ENTRY, { ...ENTRY, id: "player-2", toonHandles: ["2-S2-1-123"] }], identities: [{ toonHandle: "1-S2-1-267727" }, { toonHandle: "2-S2-1-123" }] });
    renderMy();
    expect(screen.getByText(/have separate channel records/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Connect channels for"), { target: { value: "2-S2-1-123" } });
    expect(screen.getByLabelText("Twitch channel URL")).toHaveProperty("value", "https://twitch.tv/example");
  });
});

describe("admin player channel directory", () => {
  it("adds a player absent from SC2Pulse using a toon handle", async () => {
    setupAdmin({ entries: [], total: 0 }); apiCallMock.mockResolvedValue({ entry: ENTRY });
    render(<AdminPlayerChannelsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Add player" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Player name" }), { target: { value: "Example player" } });
    fireEvent.change(within(dialog).getByLabelText("Toon handles"), { target: { value: "1-S2-1-267727, 1-S2-1-267727" } });
    fireEvent.change(within(dialog).getByLabelText("YouTube channel URL"), { target: { value: "https://www.youtube.com/@example" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save player" }));
    await waitFor(() => expect(apiCallMock).toHaveBeenCalledTimes(1));
    expect(apiCallMock.mock.calls[0][1]).toBe("/v1/admin/player-channels");
    expect(JSON.parse(apiCallMock.mock.calls[0][2].body)).toEqual({ displayName: "Example player", pulseCharacterIds: [], toonHandles: ["1-S2-1-267727"], proId: null, channels: { twitch: null, youtube: "https://youtube.com/@example" } });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText(/saved for everyone/)).toBeTruthy();
  });

  it("retains an editor when a conflicting identity is rejected", async () => {
    setupAdmin(); apiCallMock.mockRejectedValue({ status: 409, message: "This identity already belongs to another record." });
    render(<AdminPlayerChannelsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Example player" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Player name" }), { target: { value: "Updated player" } });
    fireEvent.click(screen.getByRole("button", { name: "Save player" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "This identity already belongs to another record.");
    expect(screen.getByRole("textbox", { name: "Player name" })).toHaveProperty("value", "Updated player");
    expect(mutateMock).not.toHaveBeenCalled();
  });

  it("retains removal confirmation on failure and removes only after a successful retry", async () => {
    setupAdmin(); apiCallMock.mockRejectedValueOnce({ message: "Temporarily unavailable." }).mockResolvedValueOnce({ ok: true });
    render(<AdminPlayerChannelsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Remove Example player" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove channels" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Temporarily unavailable"));
    expect(mutateMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove channels" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(apiCallMock.mock.calls[1][1]).toBe("/v1/admin/player-channels/player-1");
    expect(apiCallMock.mock.calls[1][2]).toEqual({ method: "DELETE" });
    expect(mutateMock).toHaveBeenCalledTimes(1);
  });

  it("restores a removed record through an explicit edit", async () => {
    setupAdmin({ entries: [{ ...ENTRY, removed: true }] }); apiCallMock.mockResolvedValue({ entry: ENTRY });
    render(<AdminPlayerChannelsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Edit or restore Example player" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Restore public channels/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save and restore" }));
    await waitFor(() => expect(apiCallMock).toHaveBeenCalledTimes(1));
    expect(apiCallMock.mock.calls[0][2].method).toBe("PUT");
    expect(JSON.parse(apiCallMock.mock.calls[0][2].body).removed).toBe(false);
  });

  it("reports real import counts from the API", async () => {
    setupAdmin(); apiCallMock.mockResolvedValue({ imported: 5, updated: 3, skipped: 2, total: 10 });
    render(<AdminPlayerChannelsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Import SC2Pulse" }));
    expect(await screen.findByText("SC2Pulse import complete: 5 added, 3 updated, 2 skipped (10 checked).")).toBeTruthy();
    expect(apiCallMock.mock.calls[0][1]).toBe("/v1/admin/player-channels/import-pulse");
  });

  it("requires explicit approval to publish a pending submission", async () => {
    setupAdmin({ entries: [{ ...ENTRY, pending: true, revision: 7 }] }); apiCallMock.mockResolvedValue({ entry: ENTRY });
    render(<AdminPlayerChannelsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Review Example player" }));
    expect(screen.getByText("Review this player's submission")).toBeTruthy();
    expect(apiCallMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Approve and save" }));
    await waitFor(() => expect(apiCallMock).toHaveBeenCalledTimes(1));
    expect(apiCallMock.mock.calls[0][2].method).toBe("PUT");
    expect(JSON.parse(apiCallMock.mock.calls[0][2].body).revision).toBe(7);
  });

  it("filters to pending submissions and resets pagination for review", () => {
    setupAdmin({ total: 50 }); render(<AdminPlayerChannelsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(useApiMock.mock.lastCall?.[0]).toContain("page=1");
    fireEvent.click(screen.getByRole("checkbox", { name: "Pending review only" }));
    expect(useApiMock.mock.lastCall?.[0]).toContain("pendingOnly=true");
    expect(useApiMock.mock.lastCall?.[0]).toContain("page=0");
  });

  it("keeps dirty edits when canceling the discard prompt", () => {
    setupAdmin(); render(<AdminPlayerChannelsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Example player" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Player name" }), { target: { value: "Updated player" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("dialog", { name: "Discard your changes?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("textbox", { name: "Player name" })).toHaveProperty("value", "Updated player");
    expect(apiCallMock).not.toHaveBeenCalled();
  });

  it("does not expose editing controls when the API denies admin access", () => {
    useApiMock.mockReturnValue({ error: { status: 403, message: "Forbidden" }, isLoading: false });
    render(<AdminPlayerChannelsPage />);
    expect(screen.queryByRole("button", { name: "Add player" })).toBeNull();
    expect(apiCallMock).not.toHaveBeenCalled();
  });
});
