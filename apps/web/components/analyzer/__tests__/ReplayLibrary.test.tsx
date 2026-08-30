import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
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
import { ReplayLibrary } from "../replays/ReplayLibrary";

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
  useAuth: () => ({ getToken: mocks.getToken }),
}));

vi.mock("@/components/dashboard/AnalyzerFrame", () => ({
  useDashboardMe: () => ({ userId: "fallback-user" }),
}));

vi.mock("@/lib/filterContext", () => ({
  useFilters: () => ({
    filters: {
      since: "2026-08-01",
      regions: "NA",
      map_pool: "ladder",
      game_size: "1v1",
    },
    dbRev: 9,
  }),
  filtersToQuery: () =>
    "?since=2026-08-01&regions=NA&map_pool=ladder&game_size=1v1",
}));

vi.mock("@/lib/clientApi", () => ({
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
  replayState = "ready";
  sharingState = { enabled: false, handle: null };
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.getToken.mockResolvedValue("test-token");
  mocks.clipboardWrite.mockResolvedValue(undefined);
  mocks.sharingMutate.mockImplementation(async (next: ReplaySharingResponse) => {
    sharingState = next;
    return next;
  });
  mocks.apiCall.mockResolvedValue({ enabled: true, handle: SHARE_HANDLE });
  mocks.useApi.mockImplementation((path: string) => {
    if (path === "/v1/me/replay-sharing") {
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
  vi.unstubAllGlobals();
});

describe("ReplayLibrary", () => {
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
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by result" }), {
      target: { value: "win" },
    });
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
    fireEvent.click(screen.getByRole("button", { name: "Share replay page" }));

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
        mocks.getToken,
        "/v1/me/replay-sharing",
        { method: "PUT", body: JSON.stringify({ enabled: true }) },
      );
      expect(mocks.sharingMutate).toHaveBeenCalledWith(
        { enabled: true, handle: SHARE_HANDLE },
        { revalidate: false },
      );
      expect(mocks.clipboardWrite).toHaveBeenCalledWith(
        `${window.location.origin}/players/${SHARE_HANDLE}/replays`,
      );
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Public replay page is live");
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Replay page link copied");
    expect(screen.getByRole("link", { name: /Preview public page/i }).getAttribute("href")).toBe(
      `/players/${SHARE_HANDLE}/replays`,
    );
  });
});
