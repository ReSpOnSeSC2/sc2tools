import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import { useState } from "react";
import { DEFAULT_BUILD_PROFILE, DEFAULT_STUDIO_STATE, type StudioState } from "@/lib/multichat/useStudioState";
import { SettingsBuildProfile } from "@/components/analyzer/settings/SettingsBuildProfile";
import { DockClient } from "../DockClient";

const sockets = vi.hoisted(() => [] as Array<{ receive?: (raw: unknown) => void; on: ReturnType<typeof vi.fn>; off: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }>);
vi.mock("socket.io-client", () => ({ io: () => {
  const socket = { receive: undefined as ((raw: unknown) => void) | undefined, on: vi.fn(), off: vi.fn(), disconnect: vi.fn() };
  socket.on.mockImplementation((_event, callback) => { socket.receive = callback; });
  sockets.push(socket);
  return socket;
} }));
vi.mock("@/lib/multichat/useMultiChat", () => ({ useMultiChat: () => ({ messages: [], events: [], statuses: {}, active: false }) }));
vi.mock("@/lib/multichat/useEngagementReporter", () => ({ useEngagementReporter: () => undefined }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: async () => "test-session", isLoaded: true, isSignedIn: true, userId: "live-sync-test-user" }) }));

const RATINGS = { aggressiveness: 1, defensiveness: 2, executionDifficulty: 3, popularity: 4, micro: 5 };
function snapshot(title: string, minute: number, visible = false): StudioState {
  return { ...DEFAULT_STUDIO_STATE, buildProfile: { ...DEFAULT_BUILD_PROFILE, title, ratings: { ...RATINGS }, visible }, updatedAt: `2026-10-14T12:${String(minute).padStart(2, "0")}:00.000Z` };
}
const INITIAL = snapshot("Initial test profile", 0);
const fetchMock = vi.fn();
beforeEach(() => {
  sockets.length = 0;
  fetchMock.mockReset().mockImplementation(async (url: string) => ({ ok: true, json: async () => url.includes("/config") ? { config: {} } : url.includes("/studio") ? INITIAL : {} }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function renderBoth() {
  return render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
    <div data-testid="dock-surface"><DockClient token="test-token" /></div>
    <div data-testid="settings-surface"><SettingsBuildProfile token="test-token" /></div>
  </SWRConfig>);
}
function renderSettings(token = "test-token") {
  return render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}><SettingsBuildProfile token={token} /></SWRConfig>);
}
async function drain() { await act(async () => { for (let i = 0; i < 14; i++) await Promise.resolve(); }); }
async function broadcast(state: StudioState) { await act(async () => { for (const socket of sockets) socket.receive?.(state); }); }

function SettingsWithRerender() {
  const [tick, setTick] = useState(0);
  return <><button type="button" onClick={() => setTick(tick + 1)}>Rerender {tick}</button><SettingsBuildProfile token="test-token" /></>;
}

function TokenSwitcher() {
  const [token, setToken] = useState("old-token");
  return <><button type="button" onClick={() => setToken("new-token")}>Change token</button><SettingsBuildProfile token={token} /></>;
}

describe("Build-profile live control synchronization", () => {
  it("updates both control surfaces immediately from a saved external socket event", async () => {
    const partial = { ...INITIAL, buildProfile: { ...INITIAL.buildProfile, ratings: { ...DEFAULT_BUILD_PROFILE.ratings, aggressiveness: 1 } } };
    fetchMock.mockImplementation(async (url: string) => ({ ok: true, json: async () => url.includes("/config") ? { config: {} } : url.includes("/studio") ? partial : {} }));
    renderBoth();
    const dock = within(screen.getByTestId("dock-surface")), settings = within(screen.getByTestId("settings-surface"));
    await waitFor(() => expect((settings.getByRole("textbox", { name: "Build title" }) as HTMLInputElement).value).toBe("Initial test profile"));
    expect((dock.getByRole("button", { name: "Show widget" }) as HTMLButtonElement).disabled).toBe(true);
    const latest = snapshot("Complete saved test profile", 1);
    latest.buildProfile.labels = { ...latest.buildProfile.labels, micro: "Unit control" };
    await broadcast(latest);
    for (const surface of [dock, settings]) {
      expect((surface.getByRole("textbox", { name: "Build title" }) as HTMLInputElement).value).toBe("Complete saved test profile");
      expect((surface.getByRole("textbox", { name: "Micro required label" }) as HTMLInputElement).value).toBe("Unit control");
      expect((surface.getByRole("combobox", { name: "Micro required" }) as HTMLSelectElement).value).toBe("5");
      expect((surface.getByRole("button", { name: "Show widget" }) as HTMLButtonElement).disabled).toBe(false);
    }
  });

  it("preserves dirty drafts on both surfaces while adopting saved visibility", async () => {
    renderBoth();
    const dock = within(screen.getByTestId("dock-surface")), settings = within(screen.getByTestId("settings-surface"));
    await waitFor(() => expect((settings.getByRole("textbox", { name: "Build title" }) as HTMLInputElement).value).toBe("Initial test profile"));
    fireEvent.change(dock.getByRole("textbox", { name: "Build title" }), { target: { value: "Unsaved Dock draft" } });
    fireEvent.change(settings.getByRole("textbox", { name: "Micro required label" }), { target: { value: "Unsaved wording" } });
    await broadcast(snapshot("A newer saved test profile", 2, true));
    expect((dock.getByRole("textbox", { name: "Build title" }) as HTMLInputElement).value).toBe("Unsaved Dock draft");
    expect((settings.getByRole("textbox", { name: "Micro required label" }) as HTMLInputElement).value).toBe("Unsaved wording");
    for (const surface of [dock, settings]) {
      expect((surface.getByRole("button", { name: "Hide widget" }) as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(surface.getByRole("button", { name: "Discard edits" }));
      expect((surface.getByRole("textbox", { name: "Build title" }) as HTMLInputElement).value).toBe("A newer saved test profile");
    }
  });

  it("does not let an in-flight Dock GET undo a newer socket Hide state", async () => {
    vi.useFakeTimers();
    let studioGets = 0;
    let finishOldGet: ((response: unknown) => void) | undefined;
    const visible = snapshot("Initial test profile", 0, true);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/studio")) {
        if (++studioGets === 1) return { ok: true, json: async () => visible };
        return new Promise((resolve) => { finishOldGet = resolve; });
      }
      return { ok: true, json: async () => url.includes("/config") ? { config: {} } : {} };
    });
    render(<DockClient token="test-token" />);
    await drain();
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(studioGets).toBe(2);
    await broadcast(snapshot("Hidden saved test profile", 1, false));
    await act(async () => { finishOldGet?.({ ok: true, json: async () => visible }); });
    await drain();
    expect((screen.getByRole("button", { name: "Hide widget" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Show widget" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("textbox", { name: "Build title" }) as HTMLInputElement).value).toBe("Hidden saved test profile");
  });

  it("buffers the Settings POST echo and newer external event without cancelling its save", async () => {
    let finishPost: ((response: unknown) => void) | undefined;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") return new Promise((resolve) => { finishPost = resolve; });
      return { ok: true, json: async () => INITIAL };
    });
    renderSettings();
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Build title" }) as HTMLInputElement).value).toBe("Initial test profile"));
    fireEvent.change(screen.getByRole("textbox", { name: "Build title" }), { target: { value: "My saved test edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save ratings" }));
    await waitFor(() => expect(finishPost).toBeTypeOf("function"));
    await broadcast(snapshot("My saved test edit", 1));
    await broadcast(snapshot("A newer external test edit", 2, true));
    await act(async () => { finishPost?.({ ok: true, json: async () => snapshot("My saved test edit", 1) }); });
    expect((await screen.findByRole("status")).textContent).toBe("Ratings saved.");
    expect((screen.getByRole("textbox", { name: "Build title" }) as HTMLInputElement).value).toBe("A newer external test edit");
    expect((screen.getByRole("button", { name: "Hide widget" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Save ratings" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps a live Dock Hide when an older pending Show response has the same timestamp", async () => {
    let finishPost: ((response: unknown) => void) | undefined;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return new Promise((resolve) => { finishPost = resolve; });
      return { ok: true, json: async () => url.includes("/config") ? { config: {} } : url.includes("/studio") ? INITIAL : {} };
    });
    render(<DockClient token="test-token" />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Show widget" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Show widget" }));
    await waitFor(() => expect(finishPost).toBeTypeOf("function"));
    await broadcast(snapshot("A live hidden test profile", 1, false));
    await act(async () => { finishPost?.({ ok: true, json: async () => snapshot("Initial test profile", 1, true) }); });
    expect((await screen.findByRole("status")).textContent).toBe("Widget hidden.");
    expect((screen.getByRole("button", { name: "Hide widget" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Show widget" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("textbox", { name: "Build title" }) as HTMLInputElement).value).toBe("A live hidden test profile");
  });

  it("keeps a buffered Settings Hide over an older Show response sharing its timestamp", async () => {
    let finishPost: ((response: unknown) => void) | undefined;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") return new Promise((resolve) => { finishPost = resolve; });
      return { ok: true, json: async () => INITIAL };
    });
    renderSettings();
    await waitFor(() => expect((screen.getByRole("button", { name: "Show widget" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Show widget" }));
    await waitFor(() => expect(finishPost).toBeTypeOf("function"));
    await broadcast(snapshot("A live hidden test profile", 1, false));
    await act(async () => { finishPost?.({ ok: true, json: async () => snapshot("Initial test profile", 1, true) }); });
    expect((await screen.findByRole("status")).textContent).toBe("Widget hidden.");
    expect((screen.getByRole("button", { name: "Hide widget" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("textbox", { name: "Build title" }) as HTMLInputElement).value).toBe("A live hidden test profile");
  });

  it("retains a same-timestamp live state across a cache re-render while Settings is posting", async () => {
    let finishPost: ((response: unknown) => void) | undefined;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") return new Promise((resolve) => { finishPost = resolve; });
      return { ok: true, json: async () => INITIAL };
    });
    render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}><SettingsWithRerender /></SWRConfig>);
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Build title" }) as HTMLInputElement).value).toBe("Initial test profile"));
    fireEvent.change(screen.getByRole("textbox", { name: "Build title" }), { target: { value: "My pending test edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save ratings" }));
    await waitFor(() => expect(finishPost).toBeTypeOf("function"));
    await broadcast(snapshot("Same-time external saved edit", 0, true));
    fireEvent.click(screen.getByRole("button", { name: "Rerender 0" }));
    expect(screen.getByText("Shown")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Build title" }) as HTMLInputElement).value).toBe("My pending test edit");
    await act(async () => { finishPost?.({ ok: true, json: async () => snapshot("My pending test edit", 0, false) }); });
    expect((await screen.findByRole("status")).textContent).toBe("Ratings saved.");
    expect((screen.getByRole("textbox", { name: "Build title" }) as HTMLInputElement).value).toBe("Same-time external saved edit");
    expect((screen.getByRole("button", { name: "Hide widget" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("flushes external state after a failed Settings POST while keeping its dirty draft", async () => {
    let finishPost: ((response: unknown) => void) | undefined;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") return new Promise((resolve) => { finishPost = resolve; });
      return { ok: true, json: async () => INITIAL };
    });
    renderSettings();
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Build title" }) as HTMLInputElement).value).toBe("Initial test profile"));
    fireEvent.change(screen.getByRole("textbox", { name: "Build title" }), { target: { value: "Unsaved failed test edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save ratings" }));
    await waitFor(() => expect(finishPost).toBeTypeOf("function"));
    await broadcast(snapshot("External saved test edit", 2, true));
    await act(async () => { finishPost?.({ ok: false, status: 503, text: async () => "Unavailable" }); });
    expect((await screen.findByRole("alert")).textContent).toContain("Save failed");
    expect((screen.getByRole("textbox", { name: "Build title" }) as HTMLInputElement).value).toBe("Unsaved failed test edit");
    expect((screen.getByRole("button", { name: "Hide widget" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Discard edits" }));
    expect((screen.getByRole("textbox", { name: "Build title" }) as HTMLInputElement).value).toBe("External saved test edit");
  });

  it("recovers from a failed initial Settings GET using an authoritative socket snapshot", async () => {
    fetchMock.mockImplementation(async () => ({ ok: false, status: 503, text: async () => "Unavailable" }));
    renderSettings();
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't load saved ratings");
    await broadcast(snapshot("Socket recovery test profile", 1));
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("textbox", { name: "Build title" }) as HTMLInputElement).value).toBe("Socket recovery test profile");
    expect((screen.getByRole("button", { name: "Show widget" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("ignores old-token socket events and a pending POST response after Settings changes tokens", async () => {
    let finishOldPost: ((response: unknown) => void) | undefined;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return new Promise((resolve) => { finishOldPost = resolve; });
      return { ok: true, json: async () => url.includes("new-token") ? snapshot("New token test profile", 3) : INITIAL };
    });
    render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}><TokenSwitcher /></SWRConfig>);
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Build title" }) as HTMLInputElement).value).toBe("Initial test profile"));
    fireEvent.change(screen.getByRole("textbox", { name: "Build title" }), { target: { value: "Old token pending draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save ratings" }));
    await waitFor(() => expect(finishOldPost).toBeTypeOf("function"));
    const oldReceive = sockets[0].receive;
    fireEvent.click(screen.getByRole("button", { name: "Change token" }));
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Build title" }) as HTMLInputElement).value).toBe("New token test profile"));
    await act(async () => { oldReceive?.(snapshot("Old token late socket", 9, true)); finishOldPost?.({ ok: true, json: async () => snapshot("Old token late response", 9, true) }); });
    await drain();
    expect((screen.getByRole("textbox", { name: "Build title" }) as HTMLInputElement).value).toBe("New token test profile");
    expect((screen.getByRole("button", { name: "Show widget" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
