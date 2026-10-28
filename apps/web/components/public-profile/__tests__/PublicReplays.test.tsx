import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  PublicReplayDetailResponse,
  ReplayLibraryResponse,
} from "@/components/analyzer/replays/types";
import { PublicReplayLibrary } from "../PublicReplayLibrary";

const mocks = vi.hoisted(() => ({
  ownerDownload: vi.fn(),
  publicDownload: vi.fn(),
  getJsonWithStatus: vi.fn(),
  apiFetch: vi.fn(),
  redirect: vi.fn(),
  toastSuccess: vi.fn(),
  timeline: vi.fn(),
  mechanics: vi.fn(),
  buildOrders: vi.fn(),
}));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: false }) }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => "/players/coach/replays",
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    const error = new Error("NEXT_NOT_FOUND");
    (error as Error & { digest: string }).digest = "NEXT_NOT_FOUND";
    throw error;
  },
  redirect: (href: string) => {
    mocks.redirect(href);
    const error = new Error("NEXT_REDIRECT");
    (error as Error & { digest: string }).digest = "NEXT_REDIRECT";
    throw error;
  },
  permanentRedirect: (href: string) => { mocks.redirect(href); throw new Error("NEXT_REDIRECT"); },
}));

vi.mock("@/lib/serverApi", () => ({
  getJsonWithStatus: (...args: unknown[]) => mocks.getJsonWithStatus(...args),
}));

vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));

vi.mock("@/lib/clientApi", () => ({
  API_BASE: "https://api.sc2tools.test",
}));

vi.mock("@/components/analyzer/ReplayDownloadButton", () => ({
  ReplayDownloadButton: (props: { gameId?: string | null }) => {
    mocks.ownerDownload(props);
    return <button type="button" aria-label="Download owner replay">Download owner replay</button>;
  },
}));

vi.mock("@/components/public-profile/PublicReplayDownloadButton", () => ({
  PublicReplayDownloadButton: (props: {
    handle: string;
    gameId: string;
    available?: boolean;
    sizeBytes?: number | null;
    mobile?: boolean;
    showLabel?: boolean;
  }) => {
    mocks.publicDownload(props);
    return (
      <button
        type="button"
        aria-label="Download shared replay"
        disabled={!props.available}
      >
        Download shared replay
      </button>
    );
  },
}));

vi.mock("@/components/analyzer/macro/MacroBreakdownPanel", () => ({
  MacroBreakdownPanel: () => <div role="dialog">Macro breakdown</div>,
}));

vi.mock("@/components/maps/MapArtwork", () => ({
  MapArtwork: ({ mapName }: { mapName?: string | null }) => (
    <div data-testid="map-artwork">{mapName}</div>
  ),
  MapLabel: ({ name }: { name: string }) => <span>{name}</span>,
}));

vi.mock("@/components/ui/Icon", () => ({
  Icon: ({ name }: { name: string }) => <span data-icon={name} aria-hidden />,
}));

vi.mock("@/components/analyzer/game/InteractiveTimeline", () => ({
  InteractiveTimeline: (props: Record<string, unknown>) => {
    mocks.timeline(props);
    return <div data-testid="replay-timeline">Timeline</div>;
  },
}));

vi.mock("@/components/analyzer/game/MechanicsPanel", () => ({
  MechanicsPanel: (props: Record<string, unknown>) => {
    mocks.mechanics(props);
    return <div data-testid="mechanics-panel">Mechanics</div>;
  },
}));

vi.mock("@/components/analyzer/game/BuildOrderColumns", () => ({
  BuildOrderColumns: (props: Record<string, unknown>) => {
    mocks.buildOrders(props);
    return <div data-testid="build-orders">Build orders</div>;
  },
}));

vi.mock("@/components/ui/Toast", () => ({
  useToast: () => ({ toast: { success: mocks.toastSuccess } }),
  useToastOptional: () => null,
}));

import PlayerReplaysPage, {
  generateMetadata as generateListMetadata,
} from "@/app/players/[player]/replays/page";
import SharedReplayAnalysisPage, {
  generateMetadata as generateDetailMetadata,
} from "@/app/players/[player]/replays/[gameId]/page";
import LegacyPublicReplaysPage from "@/app/p/[handle]/replays/page";

const PLAYER_SLUG = "reaver-7a6b5c4d3e";
const originalNavigatorShare = Object.getOwnPropertyDescriptor(
  navigator,
  "share",
);

const PUBLIC_LIST: ReplayLibraryResponse = {
  profile: { handle: PLAYER_SLUG, displayName: "Reaver" },
  items: [
    {
      gameId: "game/42",
      date: "2026-08-28T21:04:00.000Z",
      result: "Victory",
      map: "Crimson Court LE",
      durationSec: 845,
      myRace: "Protoss",
      myBuild: "Oracle into Blink",
      myMmr: 4321,
      macroScore: 79,
      opponent: {
        displayName: "Rival",
        race: "Terran",
        mmr: 4400,
        strategy: "3 Rax pressure",
      },
      streams: [
        {
          platform: "twitch",
          perspective: "opponent",
          playerName: "Rival",
          url: "https://www.twitch.tv/videos/123456",
          offsetSec: 91,
        },
      ],
      // Public rows may expose availability/size for the share-scoped
      // download control, but must never use an owner-only stored filename.
      replayAvailable: true,
      replayFilename: "must-stay-private.SC2Replay",
      replaySizeBytes: 123_456,
    },
  ],
  page: { hasMore: true, nextCursor: "older+/cursor" },
  total: 37,
};

const PUBLIC_DETAIL: PublicReplayDetailResponse = {
  profile: PUBLIC_LIST.profile,
  game: {
    ...PUBLIC_LIST.items[0],
    replayAvailable: true,
    replayFilename: "must-stay-private.SC2Replay",
    replaySizeBytes: 123_456,
  },
  macroBreakdown: null,
  buildOrder: null,
  streams: PUBLIC_LIST.items[0].streams,
};

afterEach(() => {
  cleanup();
  mocks.ownerDownload.mockReset();
  mocks.publicDownload.mockReset();
  mocks.getJsonWithStatus.mockReset();
  mocks.apiFetch.mockReset();
  mocks.redirect.mockReset();
  mocks.toastSuccess.mockReset();
  mocks.timeline.mockReset();
  mocks.mechanics.mockReset();
  mocks.buildOrders.mockReset();
  if (originalNavigatorShare) {
    Object.defineProperty(navigator, "share", originalNavigatorShare);
  } else {
    Reflect.deleteProperty(navigator, "share");
  }
});

describe("PublicReplayLibrary", () => {
  it("explains expired pages once and leaves the notice out of subsequent pager URLs", () => {
    render(<PublicReplayLibrary data={PUBLIC_LIST} query={{ notice: "page-expired", sort: "date_asc", result: "win" }} />);
    expect(screen.getByRole("status").textContent).toContain("That page link expired. Showing the oldest replays.");
    for (const name of ["Dismiss", /Newer replays/i]) {
      const href = screen.getByRole("link", { name }).getAttribute("href")!;
      const params = new URL(href, "https://sc2tools.test").searchParams;
      expect(params.has("notice")).toBe(false); expect(params.get("result")).toBe("win");
    }
  });
  it("renders share-safe replay rows and preserves filters across cursor links", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: share,
    });
    render(
      <PublicReplayLibrary
        data={PUBLIC_LIST}
        query={{
          search: "cannon rush",
          result: "win",
          matchup: "PvT",
          sort: "date_asc",
          cursor: "current/cursor",
        }}
      />,
    );

    expect(screen.getByRole("heading", { name: "Reaver's replays" })).toBeTruthy();
    expect(screen.getAllByText("Rival")).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: /Watch Rival POV on Twitch/i })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Download shared replay" })).toHaveLength(2);
    expect(mocks.ownerDownload).not.toHaveBeenCalled();
    expect(mocks.publicDownload).toHaveBeenCalledWith(expect.objectContaining({
      handle: PLAYER_SLUG,
      gameId: "game/42",
      available: true,
      sizeBytes: 123_456,
    }));

    const detailHref = `/players/${PLAYER_SLUG}/replays/game%2F42?from=${encodeURIComponent("search=cannon+rush&result=win&matchup=PvT&sort=date_asc&cursor=current%2Fcursor")}`;
    const analysisLinks = screen.getAllByRole("link", {
      name: "Timeline, macro breakdown and both build orders. Sign in free to open.",
    });
    expect(analysisLinks).toHaveLength(2);
    expect(analysisLinks.map((link) => link.getAttribute("href"))).toEqual(
      Array(2).fill(detailHref),
    );
    const macroLinks = screen.queryAllByRole("link", {
      name: /Sign in to open macro breakdown/i,
    });
    expect(macroLinks).toHaveLength(0);
    expect(screen.getByRole("button", {
      name: "Share Reaver's replay page",
    })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", {
      name: "Share Reaver's replay page",
    }));
    await waitFor(() => expect(share).toHaveBeenCalledWith(expect.objectContaining({
      url: `${window.location.origin}/players/${PLAYER_SLUG}/replays?search=cannon+rush&result=win&matchup=PvT&sort=date_asc&cursor=current%2Fcursor`,
    })));
    expect(screen.getByText(/Download any replay without an account · Sign in free for the full analysis/i)).toBeTruthy();

    const older = new URL(
      screen.getByRole("link", { name: /Newer replays/i }).getAttribute("href")!,
      "https://sc2tools.test",
    );
    expect(Object.fromEntries(older.searchParams)).toEqual({
      search: "cannon rush",
      result: "win",
      matchup: "PvT",
      sort: "date_asc",
      cursor: "older+/cursor",
    });
    const newest = new URL(
      screen.getByRole("link", { name: /Back to oldest/i }).getAttribute("href")!,
      "https://sc2tools.test",
    );
    expect(newest.searchParams.has("cursor")).toBe(false);
    expect(newest.searchParams.get("search")).toBe("cannon rush");
    expect(screen.getByText(/Downloads are the original .SC2Replay file, which includes the in-game names and chat StarCraft II records./i)).toBeTruthy();
  });
});

describe("public replay list route", () => {
  it.each(["7d", "30d"])("forwards rolling %s dates, map and build while keeping date keywords in the URL", async (range) => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
    try {
      mocks.getJsonWithStatus.mockResolvedValue({ data: PUBLIC_LIST, status: 200 });
      const ui = await PlayerReplaysPage({ params: Promise.resolve({ player: PLAYER_SLUG }), searchParams: Promise.resolve({ range, map: "Alcyone LE", build: "Blink", cursor: "old", page: "3" }) });
      const url = new URL(mocks.getJsonWithStatus.mock.calls[0][0], "https://example.test");
      expect(url.searchParams.get("map")).toBe("Alcyone LE"); expect(url.searchParams.get("build")).toBe("Blink"); expect(url.searchParams.get("until")).toBe("2026-10-23T12:00:00.000Z");
      expect(url.searchParams.get("since")).toBe(range === "7d" ? "2026-10-16T12:00:00.000Z" : "2026-09-23T12:00:00.000Z"); expect(url.searchParams.has("page")).toBe(false);
      render(ui); expect(screen.getByRole("link", { name: `Remove filter: ${range === "7d" ? "Last 7 days" : "Last 30 days"}` }).getAttribute("href")).not.toContain("since");
    } finally { vi.useRealTimers(); }
  });
  it("resolves this season through the shared preset and preserves that keyword", async () => {
    mocks.getJsonWithStatus.mockResolvedValue({ data: PUBLIC_LIST, status: 200 });
    render(await PlayerReplaysPage({ params: Promise.resolve({ player: PLAYER_SLUG }), searchParams: Promise.resolve({ range: "season", result: "win" }) }));
    const url = new URL(mocks.getJsonWithStatus.mock.calls[0][0], "https://example.test"); expect(Number.isFinite(Date.parse(url.searchParams.get("since")!))).toBe(true); expect(Number.isFinite(Date.parse(url.searchParams.get("until")!))).toBe(true);
    expect(screen.getByRole("link", { name: "Remove filter: Wins" }).getAttribute("href")).toBe(`/players/${PLAYER_SLUG}/replays?range=season`);
  });
  it("recovers an expired cursor to the canonical first page while retaining filters", async () => {
    mocks.getJsonWithStatus.mockResolvedValueOnce({ data: null, status: 400 }).mockResolvedValueOnce({ data: PUBLIC_LIST, status: 200 });
    await expect(PlayerReplaysPage({ params: Promise.resolve({ player: "legacy-opaque-id" }), searchParams: Promise.resolve({ cursor: "expired", result: "win", sort: "date_asc", notice: "ignored" }) })).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.redirect).toHaveBeenCalledWith(`/players/${PLAYER_SLUG}/replays?result=win&sort=date_asc&notice=page-expired`);
    expect(mocks.getJsonWithStatus).toHaveBeenLastCalledWith("/v1/public/replays/legacy-opaque-id?limit=1&fields=profile");
  });
  it("does not redirect a bad request without a cursor", async () => {
    mocks.getJsonWithStatus.mockResolvedValue({ data: null, status: 400 });
    render(await PlayerReplaysPage({ params: Promise.resolve({ player: "coach" }), searchParams: Promise.resolve({ search: "filter" }) }));
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Back to first page" }).getAttribute("href")).toBe("/players/coach/replays");
  });
  it("renders the busy variant and countdown for rate-limited archives", async () => {
    mocks.getJsonWithStatus.mockResolvedValue({ data: null, status: 429 });
    render(await PlayerReplaysPage({ params: Promise.resolve({ player: "coach" }), searchParams: Promise.resolve({}) }));
    expect(screen.getByRole("heading", { name: "Lots of visitors right now" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Retrying in 10…");
  });
  it("renders a 200 response and serializes only validated query parameters", async () => {
    mocks.getJsonWithStatus.mockResolvedValue({ data: PUBLIC_LIST, status: 200 });
    const ui = await PlayerReplaysPage({
      params: Promise.resolve({ player: PLAYER_SLUG }),
      searchParams: Promise.resolve({
        search: "  cannon rush  ",
        result: "win",
        matchup: "PvT",
        sort: "date_asc",
        cursor: "next/page",
        ignored: "secret",
      }),
    });
    render(ui);

    expect(screen.getByRole("heading", { name: "Reaver's replays" })).toBeTruthy();
    expect(mocks.getJsonWithStatus).toHaveBeenCalledWith(
      `/v1/public/replays/${PLAYER_SLUG}?limit=25&sort=date_asc&search=cannon+rush&result=win&matchup=PvT&cursor=next%2Fpage`,
    );
    expect(screen.getAllByRole("button", { name: "Download shared replay" })).toHaveLength(2);
  });

  it("throws a real not-found sentinel for a private or missing archive", async () => {
    mocks.getJsonWithStatus.mockResolvedValue({ data: null, status: 404 });
    await expect(PlayerReplaysPage({
      params: Promise.resolve({ player: "private" }),
      searchParams: Promise.resolve({}),
    })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("renders transient unavailability instead of a soft deletion during an outage", async () => {
    mocks.getJsonWithStatus.mockResolvedValue({ data: null, status: null });
    const ui = await PlayerReplaysPage({
      params: Promise.resolve({ player: "coach" }),
      searchParams: Promise.resolve({}),
    });
    render(ui);
    expect(screen.getByRole("heading", { level: 1, name: /Replay archive temporarily unavailable/i })).toBeTruthy();
  });

  it("does not turn an upstream service error into a false not-found", async () => {
    mocks.getJsonWithStatus.mockResolvedValue({ data: null, status: 503 });
    const ui = await PlayerReplaysPage({
      params: Promise.resolve({ player: "coach" }),
      searchParams: Promise.resolve({}),
    });
    render(ui);
    expect(screen.getByRole("heading", { level: 1, name: /Replay archive temporarily unavailable/i })).toBeTruthy();
  });

  it("normalizes a legacy handle to the canonical player slug", async () => {
    mocks.getJsonWithStatus.mockResolvedValue({ data: PUBLIC_LIST, status: 200 });
    await expect(PlayerReplaysPage({
      params: Promise.resolve({ player: "legacy-opaque-id" }),
      searchParams: Promise.resolve({ result: "win" }),
    })).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.redirect).toHaveBeenCalledWith(
      `/players/${PLAYER_SLUG}/replays?result=win`,
    );
  });

  it("redirects old /p replay links without dropping filters", async () => {
    mocks.getJsonWithStatus.mockResolvedValue({ data: PUBLIC_LIST, status: 200 });
    await expect(LegacyPublicReplaysPage({
      params: Promise.resolve({ handle: "legacy token" }),
      searchParams: Promise.resolve({ matchup: "PvT", result: ["win", "loss"] }),
    })).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.redirect).toHaveBeenCalledWith(
      `/players/${PLAYER_SLUG}/replays?matchup=PvT&result=win&result=loss`,
    );
  });
});

describe("public replay list metadata", () => {
  it("uses public player identity and an encoded canonical on 200", async () => {
    mocks.getJsonWithStatus.mockResolvedValue({ data: PUBLIC_LIST, status: 200 });
    const metadata = await generateListMetadata({
      searchParams: Promise.resolve({}),
      params: Promise.resolve({ player: PLAYER_SLUG }),
    });
    expect(String(metadata.title)).toContain("Reaver's StarCraft II replays");
    expect(metadata.alternates?.canonical).toBe(`/players/${PLAYER_SLUG}/replays`);
    expect(metadata.robots).toMatchObject({ index: false, follow: false });
  });

  it("throws notFound before streaming metadata for a confirmed 404", async () => {
    mocks.getJsonWithStatus.mockResolvedValue({ data: null, status: 404 });
    await expect(generateListMetadata({
      searchParams: Promise.resolve({}),
      params: Promise.resolve({ player: "missing" }),
    })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("returns neutral noindex metadata when the API is unreachable", async () => {
    mocks.getJsonWithStatus.mockResolvedValue({ data: null, status: null });
    const metadata = await generateListMetadata({
      searchParams: Promise.resolve({}),
      params: Promise.resolve({ player: PLAYER_SLUG }),
    });
    expect(String(metadata.description)).toMatch(/temporarily unavailable/i);
    expect(metadata.robots).toMatchObject({ index: false, follow: false });
    expect(metadata.alternates?.canonical).toBe(`/players/${PLAYER_SLUG}/replays`);
  });
});

describe("authenticated shared replay detail route", () => {
  it("forwards only validated archive filters and keeps the return context", async () => {
    mocks.apiFetch.mockResolvedValue({ ok: true, data: PUBLIC_DETAIL, status: 200 });
    render(await SharedReplayAnalysisPage({ params: Promise.resolve({ player: PLAYER_SLUG, gameId: "game/42" }), searchParams: Promise.resolve({ from: "matchup=PvZ&result=loss&map=Alcyone&build=Blink&search=rival&cursor=old&page=3&ignored=secret" }) }));
    const url = new URL(mocks.apiFetch.mock.calls[0][0], "https://example.test"); expect(Object.fromEntries(url.searchParams)).toEqual({ search: "rival", result: "loss", matchup: "PvZ", map: "Alcyone", build: "Blink" });
    const back = await screen.findByRole("link", { name: /Back to PvZ · Losses/ }); expect(back.getAttribute("href")).toContain("cursor=old&page=3"); expect(back.getAttribute("href")).not.toContain("ignored");
  });
  it("uses the same busy recovery for a rate-limited shared analysis", async () => {
    mocks.apiFetch.mockResolvedValue({ ok: false, status: 429, error: "busy" });
    render(await SharedReplayAnalysisPage({ params: Promise.resolve({ player: PLAYER_SLUG, gameId: "game/42" }) }));
    expect(screen.getByRole("heading", { name: "Lots of visitors right now" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
  it("loads share-scoped analysis with the signed-in server API client", async () => {
    mocks.apiFetch.mockResolvedValue({
      ok: true,
      data: PUBLIC_DETAIL,
      status: 200,
    });
    const ui = await SharedReplayAnalysisPage({
      params: Promise.resolve({ player: PLAYER_SLUG, gameId: "game/42" }),
    });
    render(ui);

    expect(mocks.apiFetch).toHaveBeenCalledWith(
      `/v1/public/replays/${PLAYER_SLUG}/game%2F42`,
    );
    expect(await screen.findByRole("heading", { name: "Reaver vs Rival" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Back to Reaver's replays/i }).getAttribute("href")).toBe(
      `/players/${PLAYER_SLUG}/replays`,
    );
    expect(screen.getByRole("button", { name: "Download shared replay" })).toBeTruthy();
    expect(mocks.ownerDownload).not.toHaveBeenCalled();
    expect(mocks.publicDownload).toHaveBeenCalledWith(expect.objectContaining({
      handle: PLAYER_SLUG,
      gameId: "game/42",
      available: true,
      showLabel: true,
    }));
    expect(mocks.mechanics).toHaveBeenCalledWith(
      expect.objectContaining({
        emptyDescription: "Detailed macro mechanics were not captured for this replay.",
      }),
    );
    expect(mocks.buildOrders).toHaveBeenCalledWith(
      expect.objectContaining({ opponentHeadingLabel: "Opponent" }),
    );
  });

  it("labels a team replay and its single modeled rival without implying 1v1", async () => {
    mocks.apiFetch.mockResolvedValue({
      ok: true,
      data: {
        ...PUBLIC_DETAIL,
        macroBreakdown: {
          stats_events: [{ time: 0 }],
        } as PublicReplayDetailResponse["macroBreakdown"],
        game: {
          ...PUBLIC_DETAIL.game,
          matchFormat: "team",
          playerCount: 4,
        },
      },
      status: 200,
    });
    const ui = await SharedReplayAnalysisPage({
      params: Promise.resolve({ player: PLAYER_SLUG, gameId: "game/42" }),
    });
    render(ui);

    expect(
      await screen.findByRole("heading", { name: "Reaver's team replay · 4 players" }),
    ).toBeTruthy();
    expect(screen.getByText("Primary opponent: Rival")).toBeTruthy();
    expect(mocks.timeline).toHaveBeenCalledWith(
      expect.objectContaining({ perspectiveLabel: "Reaver" }),
    );
    expect(mocks.buildOrders).toHaveBeenCalledWith(
      expect.objectContaining({ opponentHeadingLabel: "Primary opponent" }),
    );
  });

  it("returns not-found when sharing or the replay is missing", async () => {
    mocks.apiFetch.mockResolvedValue({
      ok: false,
      status: 404,
      error: "not_found",
    });
    await expect(SharedReplayAnalysisPage({
      params: Promise.resolve({ player: PLAYER_SLUG, gameId: "missing" }),
    })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("keeps an authenticated transient failure distinct from a missing replay", async () => {
    mocks.apiFetch.mockResolvedValue({
      ok: false,
      status: 503,
      error: "service_unavailable",
    });
    const ui = await SharedReplayAnalysisPage({
      params: Promise.resolve({ player: PLAYER_SLUG, gameId: "game-42" }),
    });
    render(ui);
    expect(screen.getByRole("heading", {
      name: "Replay analysis temporarily unavailable",
    })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("normalizes a legacy detail handle to the canonical player slug", async () => {
    mocks.apiFetch.mockResolvedValue({
      ok: true,
      data: PUBLIC_DETAIL,
      status: 200,
    });
    await expect(SharedReplayAnalysisPage({
      params: Promise.resolve({ player: "legacy-opaque-id", gameId: "game/42" }),
    })).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.redirect).toHaveBeenCalledWith(
      `/players/${PLAYER_SLUG}/replays/game%2F42`,
    );
  });
});

describe("protected replay detail metadata", () => {
  it("uses the authenticated analysis loader before emitting noindex metadata", async () => {
    mocks.apiFetch.mockResolvedValue({ ok: true, status: 200, data: PUBLIC_DETAIL });
    const metadata = await generateDetailMetadata({
      params: Promise.resolve({ player: PLAYER_SLUG, gameId: "game/42" }),
    });
    expect(String(metadata.title)).toContain("Shared replay analysis");
    expect(String(metadata.description)).toMatch(/Sign in/i);
    expect(metadata.alternates?.canonical).toBe(
      `/players/${PLAYER_SLUG}/replays/game%2F42`,
    );
    expect(metadata.robots).toMatchObject({ index: false, follow: false });
    expect(mocks.getJsonWithStatus).not.toHaveBeenCalled();
    expect(mocks.apiFetch).toHaveBeenCalledWith(`/v1/public/replays/${PLAYER_SLUG}/game%2F42`);
  });
  it("raises notFound before streaming when the shared analysis is absent", async () => {
    mocks.apiFetch.mockResolvedValue({ ok: false, status: 404, error: "missing" });
    await expect(generateDetailMetadata({ params: Promise.resolve({ player: PLAYER_SLUG, gameId: "missing" }) })).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
