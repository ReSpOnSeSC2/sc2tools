import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsContextProvider, useSettingsContext } from "../SettingsContext";
import { SettingsChat } from "../SettingsChat";
import { ChatBotCard } from "../ChatBotCard";

const state = vi.hoisted(() => ({ owner: "owner-a" as string | null, getToken: vi.fn(), api: vi.fn(), mutate: vi.fn(), success: vi.fn(), failure: vi.fn(), current: true }));
const BOT = { enabled: false, username: "", channel: "", replyCommands: true, announceOracle: true, announceLevelUps: true, hasToken: false, status: { state: "off", channel: null, lastError: null, lastConnectedAt: null } };
const EMPTY_CONFIG = {};
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: !!state.owner, userId: state.owner, getToken: state.getToken }) }));
vi.mock("@/components/ui/Toast", async importOriginal => ({
  ...(await importOriginal<typeof import("@/components/ui/Toast")>()),
  useToast: () => ({ toast: { success: state.success, error: state.failure } }),
}));
vi.mock("../SettingsStreamingTokenOwner", () => ({ useSettingsStreamingToken: () => ({ token: { token: "synthetic-selected" }, isCurrent: () => state.current }) }));
vi.mock("../OfficialPlatformConnections", () => ({ OfficialPlatformConnections: () => <section id="platform-connections"><h3>Connected accounts</h3></section> }));
vi.mock("../ChatCommandsCard", () => ({ ChatCommandsCard: () => <h3>Chat command settings</h3> }));
vi.mock("@/lib/clientApi", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/clientApi")>()),
  useApi: (path: string) => ({ data: path === "/v1/me/chatbot" ? BOT : EMPTY_CONFIG, isLoading: false, error: null, mutate: state.mutate }),
  apiCall: (...args: unknown[]) => state.api(...args),
}));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const text = (element: HTMLElement) => (element.textContent ?? "").replace(/\s+/g, " ").trim();
function DirtyStatus() { const ctx = useSettingsContext(); return <p data-testid="dirty">{String(ctx.isDirty("chat"))}:{String(ctx.isDirty("overlay"))}</p>; }
function body() { return <SettingsContextProvider><SettingsChat origin="https://fixture.invalid" /><DirtyStatus /></SettingsContextProvider>; }
beforeEach(() => {
  state.owner = "owner-a"; state.current = true; state.getToken.mockReset().mockResolvedValue("synthetic-jwt"); state.mutate.mockReset().mockResolvedValue(BOT); state.success.mockReset(); state.failure.mockReset();
  state.api.mockReset().mockImplementation(async (getToken, _path, options) => { await getToken(); options?.signal?.throwIfAborted(); return BOT; });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("the actual Chat & alerts body", () => {
  it("has one real form, one Dock URL, one bot and unique addressable sections", () => {
    const view = render(body());
    expect(screen.getAllByRole("button", { name: "Save chat settings" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Save bot settings" })).toHaveLength(1);
    for (const id of ["platforms", "platform-connections", "appearance", "alerts", "tts", "translation", "commands", "dock", "stream-dock", "bot", "twitch-automation"]) expect(view.container.querySelectorAll(`[id="${id}"]`)).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Overlay → Widgets" }).getAttribute("href")).toBe("/settings?tab=overlay&section=widgets&widget=multichat");
    const dock = within(view.container.querySelector<HTMLElement>("#stream-dock")!);
    const url = dock.getByLabelText("Widget Browser Source URL");
    expect(url.textContent).toBe("https://fixture.invalid/dock/••••••");
    expect(view.container.textContent).not.toContain("synthetic-selected");
    fireEvent.click(dock.getByRole("button", { name: "Reveal" }));
    expect(url.textContent).toBe("https://fixture.invalid/dock/synthetic-selected");
    expect(state.api).not.toHaveBeenCalled();
  });
  it("publishes the real chat draft to Chat, independently from the real bot draft", async () => {
    render(body());
    fireEvent.change(screen.getByLabelText(/Loyalty rank theme/), { target: { value: "zerg" } });
    fireEvent.change(screen.getByLabelText("Bot username"), { target: { value: "mybot" } });
    expect(text(screen.getByTestId("dirty"))).toContain("true:false");
    fireEvent.click(screen.getByRole("button", { name: "Save bot settings" }));
    await waitFor(() => expect(state.success).toHaveBeenCalledOnce());
    expect(text(screen.getByTestId("dirty"))).toContain("true:false");
  });
});

describe("bot Save owner, deadline and draft admission", () => {
  function editAndSave() { fireEvent.change(screen.getByLabelText("Bot username"), { target: { value: "first" } }); fireEvent.click(screen.getByRole("button", { name: "Save bot settings" })); }
  it("retains a newer bot draft while a previous response is held", async () => {
    const response = deferred<typeof BOT>(); state.api.mockReturnValueOnce(response.promise);
    render(body()); editAndSave();
    fireEvent.change(screen.getByLabelText("Bot username"), { target: { value: "newer-draft" } });
    await act(async () => response.resolve({ ...BOT, username: "first" }));
    expect((screen.getByLabelText("Bot username") as HTMLInputElement).value).toBe("newer-draft");
    expect(text(screen.getByTestId("dirty"))).toContain("true:false");
    expect(state.success).not.toHaveBeenCalled();
  });
  it("retires a held JWT through owner A→B→A before any authenticated body is sent", async () => {
    const jwt = deferred<string>(); state.getToken.mockReturnValueOnce(jwt.promise);
    const dispatched = vi.fn(); state.api.mockImplementation(async (getToken, _path, options) => { await getToken(); options.signal.throwIfAborted(); dispatched(); return BOT; });
    const view = render(<ChatBotCard twitchChannel="channel" />); editAndSave();
    state.owner = "owner-b"; view.rerender(<ChatBotCard twitchChannel="channel" />);
    state.owner = "owner-a"; view.rerender(<ChatBotCard twitchChannel="channel" />);
    await act(async () => jwt.resolve("retired-jwt"));
    expect(dispatched).not.toHaveBeenCalled(); expect(state.mutate).not.toHaveBeenCalled(); expect(state.success).not.toHaveBeenCalled(); expect(state.failure).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Bot username") as HTMLInputElement).value).toBe("");
  });
  it("does not cache/toast a body after its selected credential retires or unmounts", async () => {
    const response = deferred<typeof BOT>(); state.api.mockReturnValueOnce(response.promise);
    const view = render(body()); editAndSave(); state.current = false; view.unmount();
    await act(async () => response.resolve({ ...BOT, username: "private-retired" }));
    expect(state.mutate).not.toHaveBeenCalled(); expect(state.success).not.toHaveBeenCalled(); expect(state.failure).not.toHaveBeenCalled();
  });
  it("settles a stalled JWT at 20 seconds and never sends after the deadline", async () => {
    vi.useFakeTimers(); const jwt = deferred<string>(); state.getToken.mockReturnValueOnce(jwt.promise);
    const dispatched = vi.fn(); state.api.mockImplementation(async (getToken, _path, options) => { await getToken(); options.signal.throwIfAborted(); dispatched(); return BOT; });
    render(<ChatBotCard twitchChannel="channel" />); editAndSave();
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(state.failure).toHaveBeenCalledOnce(); expect((screen.getByRole("button", { name: "Save bot settings" }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => jwt.resolve("too-late")); expect(dispatched).not.toHaveBeenCalled(); expect(state.success).not.toHaveBeenCalled();
  });
});
