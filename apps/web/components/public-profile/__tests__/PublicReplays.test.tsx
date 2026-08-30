import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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

vi.mock("next/navigation", () => ({
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
}));

import PlayerReplaysPage, {
  generateMetadata as generateListMetadata,
} from "@/app/players/[player]/replays/page";
import SharedReplayAnalysisPage, {
  generateMetadata as generateDetailMetadata,
} from "@/app/players/[player]/replays/[gameId]/page";
import LegacyPublicReplaysPage from "@/app/p/[handle]/replays/page";

const PLAYER_SLUG = "reaver-7a6b5c4d3e";

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
});

describe("PublicReplayLibrary", () => {
  it("renders share-safe replay rows and preserves filters across cursor links", () => {
    const { container } = render(
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

    const detailHref = `/players/${PLAYER_SLUG}/replays/game%2F42`;
    expect(container.querySelectorAll(`a[href="${detailHref}"]`)).toHaveLength(3);
    expect(container.querySelectorAll(`a[href="${detailHref}#macro-breakdown"]`)).toHaveLength(2);
    expect(screen.getByText(/View the list and download replays without an account/i)).toBeTruthy();
    expect(screen.getByText(/Sign in for Macro and Analysis/i)).toBeTruthy();

    const older = new URL(
      screen.getByRole("link", { name: /Older replays/i }).getAttribute("href")!,
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
      screen.getByRole("link", { name: /Back to newest/i }).getAttribute("href")!,
      "https://sc2tools.test",
    );
    expect(newest.searchParams.has("cursor")).toBe(false);
    expect(newest.searchParams.get("search")).toBe("cannon rush");
    expect(screen.getByText(/This list and its replay downloads are public/i)).toBeTruthy();
  });
});

describe("public replay list route", () => {
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
    await expect(LegacyPublicReplaysPage({
      params: Promise.resolve({ handle: "legacy token" }),
      searchParams: Promise.resolve({ matchup: "PvT", result: ["win", "loss"] }),
    })).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.redirect).toHaveBeenCalledWith(
      "/players/legacy%20token/replays?matchup=PvT&result=win&result=loss",
    );
  });
});

describe("public replay list metadata", () => {
  it("uses public player identity and an encoded canonical on 200", async () => {
    mocks.getJsonWithStatus.mockResolvedValue({ data: PUBLIC_LIST, status: 200 });
    const metadata = await generateListMetadata({
      params: Promise.resolve({ player: PLAYER_SLUG }),
    });
    expect(String(metadata.title)).toContain("Reaver's StarCraft II replays");
    expect(metadata.alternates?.canonical).toBe(`/players/${PLAYER_SLUG}/replays`);
    expect(metadata.robots).toMatchObject({ index: false, follow: false });
  });

  it("throws notFound before streaming metadata for a confirmed 404", async () => {
    mocks.getJsonWithStatus.mockResolvedValue({ data: null, status: 404 });
    await expect(generateListMetadata({
      params: Promise.resolve({ player: "missing" }),
    })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("returns neutral noindex metadata when the API is unreachable", async () => {
    mocks.getJsonWithStatus.mockResolvedValue({ data: null, status: null });
    const metadata = await generateListMetadata({
      params: Promise.resolve({ player: PLAYER_SLUG }),
    });
    expect(String(metadata.description)).toMatch(/temporarily unavailable/i);
    expect(metadata.robots).toMatchObject({ index: false, follow: false });
    expect(metadata.alternates?.canonical).toBe(`/players/${PLAYER_SLUG}/replays`);
  });
});

describe("authenticated shared replay detail route", () => {
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
    expect(screen.getByRole("heading", { name: "Reaver vs Rival" })).toBeTruthy();
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
      screen.getByRole("heading", { name: "Reaver's team replay · 4 players" }),
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
  it("is generic, noindex and canonical without anonymously fetching analysis", async () => {
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
  });
});
