import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  ReplayLibraryResponse,
  ReplaySharingResponse,
} from "../replays/types";
import { navigation, router, visit } from "../replays/__tests__/navigationFixture";
import { replayRowMemoryKey } from "@/lib/replayListNavigation";
import type { AnalyzerFilters } from "@/lib/filterContext";
import { ReplayLibrary } from "../replays/ReplayLibrary";
import { gameSourceFromQuery } from "@/lib/gameNavigation";
import { ownerNeighborPath } from "../game/GameNavigation";

const globalState = vi.hoisted(() => ({ filters: {} as AnalyzerFilters }));
const mocks = vi.hoisted(() => ({
  apiCall: vi.fn(),
  clipboardWrite: vi.fn(),
  download: vi.fn(),
  getToken: vi.fn(async () => "test-token"),
  replayMutate: vi.fn(),
  sharingMutate: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  useApi: vi.fn(),
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: mocks.getToken, userId: "owner", isLoaded: true, isSignedIn: true }),
}));

vi.mock("@/components/dashboard/AnalyzerFrame", () => ({
  useDashboardMe: () => ({ userId: "fallback-user" }),
}));

vi.mock("next/navigation", () => import("../replays/__tests__/navigationFixture"));
vi.mock("@/lib/filterContext", async original => ({
  ...await original<object>(),
  useFilters: () => ({
    filters: globalState.filters,
    dbRev: 9,
    seasons: [],
    setFilters: (filters: AnalyzerFilters) => { globalState.filters = filters; },
  }),
}));

vi.mock("@/lib/clientApi", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/clientApi")>()),
  useApi: (...args: unknown[]) => mocks.useApi(...args),
  apiCall: (...args: unknown[]) => mocks.apiCall(...args),
}));

vi.mock("@/components/ui/Toast", () => ({
  useToast: () => ({
    toast: { success: mocks.toastSuccess, error: mocks.toastError },
  }),
}));

vi.mock("@/components/analyzer/ReplayDownloadButton", () => ({
  ReplayDownloadButton: (props: { gameId?: string | null; mobile?: boolean }) => {
    mocks.download(props);
    return <button type="button" aria-label="Download replay">Download replay</button>;
  },
}));

vi.mock("@/components/analyzer/macro/MacroBreakdownPanel", () => ({
  MacroBreakdownPanel: () => <div role="dialog">Macro breakdown</div>,
}));

vi.mock("@/components/maps/MapArtwork", () => ({
  MapLabel: ({ name }: { name: string }) => <span>{name}</span>,
}));

vi.mock("@/components/ui/Icon", () => ({
  Icon: ({ name }: { name: string }) => <span data-icon={name} aria-hidden />,
}));

const FIRST_PAGE: ReplayLibraryResponse = {
  profile: { handle: "coach name", displayName: "Reaver" },
  items: [
    {
      gameId: "game-1",
      date: "2026-08-28T20:00:00.000Z",
      result: "Victory",
      map: "Crimson Court LE",
      durationSec: 720,
      myRace: "Protoss",
      myBuild: "Blink pressure",
      myMmr: 4300,
      macroScore: 81,
      opponent: {
        displayName: "First Rival",
        race: "Terran",
        strategy: "Bio pressure",
      },
      replayAvailable: true,
    },
  ],
  page: { hasMore: true, nextCursor: "cursor+/2" },
  total: 41,
};

const SECOND_PAGE: ReplayLibraryResponse = {
  profile: FIRST_PAGE.profile,
  items: [
    {
      ...FIRST_PAGE.items[0],
      gameId: "game-2",
      opponent: { ...FIRST_PAGE.items[0].opponent, displayName: "Second Rival" },
    },
  ],
  page: { hasMore: false, nextCursor: null },
  total: 41,
};

let replayState: "ready" | "error" | "loading" | "empty";
let sharingState: ReplaySharingResponse;
let sharingReadSuccess: ((value: ReplaySharingResponse) => void) | undefined;
const SHARE_HANDLE = "share_token_0123456789abcdefghij";

function replayPaths(): string[] {
  return mocks.useApi.mock.calls
    .map(([path]) => String(path))
    .filter((path) => path.startsWith("/v1/replays?"));
}

function latestReplayParams(): URLSearchParams {
  const latest = replayPaths().at(-1);
  if (!latest) throw new Error("Replay request was not made");
  return new URL(latest, "https://sc2tools.test").searchParams;
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  window.sessionStorage.clear(); window.localStorage.clear();
  globalState.filters = { since: "2026-08-01", regions: "NA", map_pool: "ladder", game_size: "1v1" };
  navigation.hold = false; navigation.pending = []; router.replace.mockClear(); router.push.mockClear();
  replayState = "ready";
  sharingState = { enabled: false, handle: null };
  sharingReadSuccess = undefined;
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.getToken.mockResolvedValue("test-token");
  mocks.clipboardWrite.mockResolvedValue(undefined);
  mocks.sharingMutate.mockImplementation(async (next?: ReplaySharingResponse | ((current: ReplaySharingResponse) => ReplaySharingResponse)) => {
    if (next === undefined) { sharingReadSuccess?.(sharingState); return sharingState; }
    sharingState = typeof next === "function" ? next(sharingState) : next;
    return sharingState;
  });
  mocks.apiCall.mockResolvedValue({ enabled: true, handle: SHARE_HANDLE });
  mocks.useApi.mockImplementation((path: string, config?: { onSuccess?: (value: ReplaySharingResponse) => void }) => {
    if (path === "/v1/me/replay-sharing") {
      sharingReadSuccess = config?.onSuccess;
      return {
        data: sharingState,
        isLoading: false,
        isValidating: false,
        error: null,
        mutate: mocks.sharingMutate,
      };
    }
    const cursor = new URL(path, "https://sc2tools.test").searchParams.get("cursor");
    if (replayState === "loading") {
      return { data: undefined, isLoading: true, isValidating: false, error: null, mutate: mocks.replayMutate };
    }
    if (replayState === "error") {
      return {
        data: undefined,
        isLoading: false,
        isValidating: false,
        error: { status: 503, code: "unavailable", message: "Stats service is offline." },
        mutate: mocks.replayMutate,
      };
    }
    const data = replayState === "empty"
      ? { ...FIRST_PAGE, items: [], page: { hasMore: false, nextCursor: null }, total: 0 }
      : cursor === "cursor+/2" ? SECOND_PAGE : FIRST_PAGE;
    return {
      data,
      isLoading: false,
      isValidating: false,
      error: null,
      mutate: mocks.replayMutate,
    };
  });

  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: mocks.clipboardWrite },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ReplayLibrary", () => {
  it("carries real global and local filters into game neighbors and restores them from the durable backlink", async () => {
    window.history.replaceState({ existing: true }, "", "/app/replays?keep=1#archive");
    const view = render(<ReplayLibrary />);
    fireEvent.change(screen.getByRole("textbox", { name: "Search replays" }), { target: { value: "Rival build" } });
    fireEvent.click(screen.getByRole("button", { name: "Losses" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by matchup" }), { target: { value: "PvT" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Sort replays" }), { target: { value: "date_asc" } });
    await waitFor(() => expect(latestReplayParams().get("search")).toBe("Rival build"));
    const link = screen.getAllByRole("link", { name: /Open.*analysis/i })[0];
    const query = new URL(link.getAttribute("href")!, "https://sc2tools.test").searchParams;
    const source = gameSourceFromQuery(Object.fromEntries(query))!;
    expect(source.href).toBe(`${location.pathname}${location.search}${location.hash}`);
    expect(Object.fromEntries(new URL(ownerNeighborPath("game-1", "all", source), "https://sc2tools.test").searchParams)).toEqual({
      scope: "all", since: "2026-08-01", regions: "NA", map_pool: "ladder", game_size: "1v1", q: "Rival build", result: "loss", matchup: "PvT",
    });
    expect(source.filters).not.toMatch(/limit|cursor|sort|keep/);
    view.unmount();
    window.history.replaceState(window.history.state, "", source.href);
    render(<ReplayLibrary />);
    expect((screen.getByRole("textbox", { name: "Search replays" }) as HTMLInputElement).value).toBe("Rival build");
    expect(screen.getByRole("button", { name: "Losses" }).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByRole("combobox", { name: "Filter by matchup" }) as HTMLSelectElement).value).toBe("PvT");
    expect((screen.getByRole("combobox", { name: "Sort replays" }) as HTMLSelectElement).value).toBe("date_asc");
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(location.pathname + location.search + location.hash).toBe("/app/replays?keep=1#archive");
    expect(window.history.state).toEqual({ existing: true });
  });

  it("maps the owner response and composes global filters, local filters, and cursor paging", async () => {
    render(<ReplayLibrary />);

    expect(screen.getAllByText("First Rival")).toHaveLength(2);
    expect(screen.getByText("1 of 41 shown")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Download replay" })).toHaveLength(2);
    expect(mocks.useApi).toHaveBeenCalledWith(
      expect.stringMatching(/^\/v1\/replays\?/),
      { keepPreviousData: true, revalidateOnFocus: false },
    );
    let params = latestReplayParams();
    expect(Object.fromEntries(params)).toMatchObject({
      since: "2026-08-01",
      regions: "NA",
      map_pool: "ladder",
      game_size: "1v1",
      limit: "25",
      sort: "date_desc",
    });

    fireEvent.change(screen.getByRole("textbox", { name: "Search replays" }), {
      target: { value: "Rival build" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Wins" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by matchup" }), {
      target: { value: "PvT" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Sort replays" }), {
      target: { value: "date_asc" },
    });
    await waitFor(() => {
      expect(Object.fromEntries(latestReplayParams())).toMatchObject({
        search: "Rival build",
        result: "win",
        matchup: "PvT",
        sort: "date_asc",
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Older" }));
    await waitFor(() => {
      expect(latestReplayParams().get("cursor")).toBe("cursor+/2");
      expect(screen.getAllByText("Second Rival")).toHaveLength(2);
      expect(screen.getByText("Page 2")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Newer" }));
    await waitFor(() => {
      expect(latestReplayParams().has("cursor")).toBe(false);
      expect(screen.getByText("Page 1")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Older" }));
    await waitFor(() => expect(latestReplayParams().has("cursor")).toBe(true));
    fireEvent.change(screen.getByRole("textbox", { name: "Search replays" }), {
      target: { value: "new cohort" },
    });
    await waitFor(() => {
      const latest = latestReplayParams();
      expect(latest.get("search")).toBe("new cohort");
      expect(latest.has("cursor")).toBe(false);
    });
  });

  it("shows an actionable API error and retries through the request cache", () => {
    replayState = "error";
    render(<ReplayLibrary />);

    expect(screen.getByRole("alert").textContent).toContain("Couldn't load replay history");
    expect(screen.getByRole("alert").textContent).toContain("Stats service is offline.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(mocks.replayMutate).toHaveBeenCalledTimes(1);
  });

  it("passes an empty backend page through to the replay empty state", () => {
    replayState = "empty";
    render(<ReplayLibrary />);

    expect(screen.getByText("0 of 0 shown")).toBeTruthy();
    expect(screen.getByText("No replays match these filters")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Older" })).toBeNull();
  });

  it("requires explicit consent before enabling sharing and copies the canonical public URL", async () => {
    render(<ReplayLibrary />);
    expect(screen.queryByRole("button", { name: "Copy public replay page link" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Share" }));

    expect(screen.getByRole("dialog", { name: "Share your replay archive" })).toBeTruthy();
    expect(screen.getByText(/Exactly what visitors can see/i)).toBeTruthy();
    expect(screen.getByText(/every synced replay in this archive/i)).toBeTruthy();
    expect(screen.getByText(/download archived original replay files/i)).toBeTruthy();
    expect(screen.getByText(/full Macro breakdown require.*sign in/i)).toBeTruthy();
    expect(screen.getByText(/can contain player\/account identifiers, chat, team information/i)).toBeTruthy();
    expect(screen.getByText(/temporary storage URL/i)).toBeTruthy();
    expect(screen.getByText(/player replay address stays assigned to you/i)).toBeTruthy();
    expect(screen.getByText(/personal player replay address is created/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Turn on and copy link" }));
    await waitFor(() => {
      expect(mocks.apiCall).toHaveBeenCalledWith(
        expect.any(Function),
        "/v1/me/replay-sharing",
        expect.objectContaining({ method: "PUT", body: JSON.stringify({ enabled: true }), signal: expect.any(AbortSignal) }),
      );
      expect(mocks.sharingMutate).toHaveBeenCalledWith(
        expect.any(Function),
        { revalidate: false },
      );
      expect(mocks.clipboardWrite).toHaveBeenCalledWith(
        `${window.location.origin}/players/${SHARE_HANDLE}/replays`,
      );
    });
    expect(sharingState).toEqual({ enabled: true, handle: SHARE_HANDLE });
    expect(mocks.getToken).toHaveBeenCalledTimes(1);
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Public replay page is live");
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Replay page link copied");
    expect(screen.getByRole("link", { name: /Preview public page/i }).getAttribute("href")).toBe(
      `/players/${SHARE_HANDLE}/replays`,
    );
  });

  it("puts a persistent copy-link action directly below Sharing on", async () => {
    sharingState = { enabled: true, handle: SHARE_HANDLE };
    render(<ReplayLibrary />);

    const actions = screen.getByRole("group", { name: "Replay sharing actions" });
    const sharingButton = await screen.findByRole("button", { name: "Sharing on" });
    const copyButton = screen.getByRole("button", { name: "Copy public replay page link" });
    expect(sharingButton.parentElement).toBe(actions);
    expect(copyButton.parentElement).toBe(actions);
    expect(sharingButton.nextElementSibling).toBe(copyButton);

    fireEvent.click(copyButton);

    await waitFor(() => expect(mocks.clipboardWrite).toHaveBeenCalledWith(
      `${window.location.origin}/players/${SHARE_HANDLE}/replays`,
    ));
    expect(mocks.apiCall).not.toHaveBeenCalled();
    expect(await screen.findByText("Copied")).toBeTruthy();
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Replay page link copied");
  });

  it("offers the canonical replay URL for manual copy when clipboard access fails", async () => {
    sharingState = { enabled: true, handle: SHARE_HANDLE };
    mocks.clipboardWrite.mockRejectedValue(new Error("clipboard_denied"));
    const prompt = vi.spyOn(window, "prompt").mockReturnValue(null);
    render(<ReplayLibrary />);

    fireEvent.click(await screen.findByRole("button", { name: "Copy public replay page link" }));

    const manual = await screen.findByRole("dialog", { name: "Copy replay page link manually" });
    const input = manual.querySelector("input")!;
    expect(input.value).toBe(`${window.location.origin}/players/${SHARE_HANDLE}/replays`);
    expect(input.readOnly).toBe(true);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, input.value.length]);
    expect(prompt).not.toHaveBeenCalled();
    expect(mocks.apiCall).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalledWith("Replay page link copied");
  });
  it("uses the committed q and cursor together while navigation acknowledgements are held", async () => {
    visit("/app/replays?q=old&cursor=cursor%2B%2F2", true); navigation.hold = true; vi.useFakeTimers();
    render(<ReplayLibrary />);
    const input = screen.getByRole("textbox", { name: "Search replays" });
    fireEvent.change(input, { target: { value: "new draft" } });
    expect(latestReplayParams().get("search")).toBe("old"); expect(latestReplayParams().get("cursor")).toBe("cursor+/2");
    expect((screen.getByRole("button", { name: "Older" }) as HTMLButtonElement).disabled).toBe(true);
    act(() => { vi.advanceTimersByTime(300); });
    expect(router.replace).toHaveBeenCalledTimes(1); expect(router.push).not.toHaveBeenCalled();
    expect(latestReplayParams().get("search")).toBe("old");
    act(() => navigation.acknowledge());
    expect(latestReplayParams().get("search")).toBe("new draft"); expect(latestReplayParams().has("cursor")).toBe(false);
    fireEvent.change(input, { target: { value: "flushed text" } }); fireEvent.click(screen.getByRole("button", { name: "Wins" }));
    expect(router.replace).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Wins" }).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByRole("button", { name: "Older" }) as HTMLButtonElement).disabled).toBe(true);
    expect(latestReplayParams().has("result")).toBe(false);
    act(() => navigation.acknowledge());
    expect(latestReplayParams().get("search")).toBe("flushed text"); expect(latestReplayParams().get("result")).toBe("win");
    act(() => { vi.advanceTimersByTime(400); }); expect(router.replace).toHaveBeenCalledTimes(2); vi.useRealTimers();
  });
  it("recovers session Newer after remount, or Back to newest without page memory", async () => {
    visit("/app/replays", true); const first = render(<ReplayLibrary />); fireEvent.click(screen.getByRole("button", { name: "Older" }));
    await waitFor(() => expect(latestReplayParams().get("cursor")).toBe("cursor+/2")); first.unmount();
    const reloaded = render(<ReplayLibrary />); expect(screen.getByText("Page 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Newer" })); expect(latestReplayParams().has("cursor")).toBe(false);
    reloaded.unmount(); sessionStorage.clear(); visit("/app/replays?cursor=cursor%2B%2F2&q=Rival", true);
    render(<ReplayLibrary />); expect(screen.getByText("Saved page")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to newest" })); expect(latestReplayParams().has("cursor")).toBe(false); expect(latestReplayParams().get("search")).toBe("Rival");
  });
  it("suppresses a stale cursor synchronously on global account changes", () => {
    visit("/app/replays?cursor=cursor%2B%2F2", true); navigation.hold = true;
    const view = render(<ReplayLibrary />); const before = replayPaths().length;
    globalState.filters = { ...globalState.filters, accounts: "2-S2-1-123" }; view.rerender(<ReplayLibrary />);
    for (const path of replayPaths().slice(before)) { const params = new URL(path, "https://fixture.test").searchParams; expect(params.get("accounts")).toBe("2-S2-1-123"); expect(params.has("cursor")).toBe(false); }
    expect(navigation.pending.at(-1)).not.toContain("cursor=");
  });
  it("clamps Jump to date to the earlier global until and clears its cursor", async () => {
    globalState.filters = { ...globalState.filters, until: "2026-08-12T15:00:00.000Z" };
    visit("/app/replays?cursor=cursor%2B%2F2", true); render(<ReplayLibrary />);
    fireEvent.change(screen.getByRole("textbox", { name: "Search replays" }), { target: { value: "Rival" } });
    fireEvent.change(screen.getByLabelText("Jump to date"), { target: { value: "2026-08-20" } });
    expect(latestReplayParams().get("until")).toBe("2026-08-12T15:00:00.000Z"); expect(latestReplayParams().has("cursor")).toBe(false);
    fireEvent.change(screen.getByLabelText("Jump to date"), { target: { value: "2026-08-10" } });
    expect(latestReplayParams().get("until")).toBe("2026-08-10T23:59:59.999Z"); expect(location.search).toContain("before=2026-08-10");
    fireEvent.click(screen.getByRole("button", { name: "Clear replay date" })); expect(latestReplayParams().get("until")).toBe("2026-08-12T15:00:00.000Z");
  });
  it("clears legacy/local empty filters without widening the global cohort and dismisses the tip", () => {
    replayState = "empty"; visit("/app/replays?replaySearch=Rival&replayResult=tie&replayMatchup=PvT&before=2026-08-10", true);
    render(<ReplayLibrary />); expect(screen.getByRole("button", { name: "Ties only ×" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear replay filters" }));
    expect(latestReplayParams().get("since")).toBe("2026-08-01"); expect(latestReplayParams().get("regions")).toBe("NA");
    expect(location.search).not.toMatch(/q=|result=|matchup=|before=|replaySearch|replayResult|replayMatchup/);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss replay tip" })); expect(screen.queryByText(/Personal match tape/)).toBeNull(); expect(localStorage.getItem("replays.introDismissed")).toBe("true");
  });
  it("restores the opened row with reduced motion after returning from analysis", async () => {
    visit("/app/replays", true); Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({ matches: true })) });
    const first = render(<ReplayLibrary />); const link = screen.getAllByRole("link", { name: /Open replay analysis/ })[0];
    link.addEventListener("click", event => event.preventDefault()); fireEvent.click(link);
    expect(JSON.parse(sessionStorage.getItem(replayRowMemoryKey("owner"))!).gameId).toBe("game-1"); first.unmount();
    const scroll = vi.mocked(HTMLElement.prototype.scrollIntoView); scroll.mockClear(); render(<ReplayLibrary />);
    expect(scroll).toHaveBeenCalledWith({ behavior: "auto", block: "center" }); expect(sessionStorage.getItem(replayRowMemoryKey("owner"))).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Older" })); expect(scroll).toHaveBeenCalledWith({ behavior: "auto", block: "start" });
  });

});
