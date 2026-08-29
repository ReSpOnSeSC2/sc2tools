import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReplayLibraryItem } from "../replays/types";
import { ReplayList } from "../replays/ReplayList";

const { downloadMock, macroPanelMock, publicDownloadMock } = vi.hoisted(() => ({
  downloadMock: vi.fn(),
  macroPanelMock: vi.fn(),
  publicDownloadMock: vi.fn(),
}));

vi.mock("@/components/analyzer/ReplayDownloadButton", () => ({
  ReplayDownloadButton: (props: {
    gameId?: string | null;
    available?: boolean;
    filename?: string | null;
    sizeBytes?: number | null;
    mobile?: boolean;
  }) => {
    downloadMock(props);
    return (
      <button
        type="button"
        aria-label="Download replay"
        data-mobile={props.mobile ? "true" : "false"}
      >
        Download replay
      </button>
    );
  },
}));

vi.mock("@/components/public-profile/PublicReplayDownloadButton", () => ({
  PublicReplayDownloadButton: (props: {
    handle: string;
    gameId: string;
    available?: boolean;
    sizeBytes?: number | null;
    mobile?: boolean;
  }) => {
    publicDownloadMock(props);
    return (
      <button
        type="button"
        aria-label="Download shared replay"
        data-mobile={props.mobile ? "true" : "false"}
      >
        Download shared replay
      </button>
    );
  },
}));

vi.mock("@/components/analyzer/macro/MacroBreakdownPanel", () => ({
  MacroBreakdownPanel: (props: {
    gameId: string;
    initialScore?: number | null;
    headerMeta?: { playerName?: string; opponentName?: string | null };
    onClose: () => void;
  }) => {
    macroPanelMock(props);
    return (
      <div role="dialog" aria-label="Macro breakdown" data-game-id={props.gameId}>
        Macro breakdown for {props.headerMeta?.opponentName}
        <button type="button" onClick={props.onClose}>Close macro</button>
      </div>
    );
  },
}));

vi.mock("@/components/maps/MapArtwork", () => ({
  MapLabel: ({ name }: { name: string }) => <span data-testid="map-label">{name}</span>,
}));

vi.mock("@/components/ui/Icon", () => ({
  Icon: ({ name }: { name: string }) => <span data-icon={name} aria-hidden />,
}));

const REPLAY: ReplayLibraryItem = {
  gameId: "game/42",
  date: "2026-08-28T21:04:00.000Z",
  result: "Victory",
  map: "Crimson Court LE",
  durationSec: 845,
  myRace: "Protoss",
  myBuild: "Oracle into Blink",
  myMmr: 4321,
  macroScore: 78.6,
  opponent: {
    displayName: "Rival",
    race: "Terran",
    mmr: 4400,
    strategy: "3 Rax pressure",
  },
  streams: [
    {
      platform: "youtube",
      perspective: "me",
      playerName: "Reaver",
      url: "https://www.youtube.com/watch?v=abc123",
      offsetSec: 37,
    },
  ],
  replayAvailable: true,
  replayFilename: "Crimson Court.SC2Replay",
  replaySizeBytes: 1_572_864,
};

afterEach(() => {
  cleanup();
  downloadMock.mockClear();
  macroPanelMock.mockClear();
  publicDownloadMock.mockClear();
});

describe("ReplayList", () => {
  it("maps a replay-library row into owner review, macro, download, and VOD actions", () => {
    const { container } = render(
      <ReplayList items={[REPLAY]} owner playerName="Reaver" />,
    );

    expect(screen.getByText("Replay history for Reaver")).toBeTruthy();
    expect(screen.getAllByText("Win")).toHaveLength(2);
    expect(screen.getAllByText("Rival")).toHaveLength(2);
    expect(screen.getAllByText("Oracle into Blink")).toHaveLength(2);
    expect(screen.getAllByText("3 Rax pressure")).toHaveLength(2);
    expect(screen.getAllByText("Crimson Court LE")).toHaveLength(2);
    expect(container.querySelectorAll('time[datetime="2026-08-28T21:04:00.000Z"]')).toHaveLength(2);

    expect(
      container.querySelectorAll<HTMLAnchorElement>('a[href="/app/game/game%2F42"]'),
    ).toHaveLength(3);

    const streamLinks = screen.getAllByRole("link", {
      name: /Watch You POV on YouTube at 0:37 - Reaver/i,
    });
    expect(streamLinks).toHaveLength(2);
    expect(new URL(streamLinks[0].getAttribute("href")!).searchParams.get("t")).toBe("37s");

    expect(screen.getAllByRole("button", { name: "Download replay" })).toHaveLength(2);
    expect(downloadMock).toHaveBeenCalledWith(expect.objectContaining({
      gameId: "game/42",
      available: true,
      filename: "Crimson Court.SC2Replay",
      sizeBytes: 1_572_864,
    }));

    fireEvent.click(
      screen.getByRole("button", { name: "Open macro breakdown for Rival" }),
    );
    expect(screen.getByRole("dialog", { name: "Macro breakdown" }).getAttribute("data-game-id")).toBe("game/42");
    expect(macroPanelMock).toHaveBeenLastCalledWith(expect.objectContaining({
      gameId: "game/42",
      initialScore: 78.6,
      headerMeta: expect.objectContaining({
        playerName: "Reaver",
        opponentName: "Rival",
      }),
    }));
  });

  it("uses public analysis URLs and delegates downloads to the share-scoped control", () => {
    const { container } = render(
      <ReplayList
        items={[REPLAY]}
        owner={false}
        playerName="Reaver"
        publicHandle="coach name"
      />,
    );

    const detailHref = "/p/coach%20name/replays/game%2F42";
    expect(container.querySelectorAll(`a[href="${detailHref}"]`)).toHaveLength(3);
    expect(container.querySelectorAll(`a[href="${detailHref}#macro-breakdown"]`)).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Download shared replay" })).toHaveLength(2);
    expect(downloadMock).not.toHaveBeenCalled();
    expect(publicDownloadMock).toHaveBeenCalledWith(expect.objectContaining({
      handle: "coach name",
      gameId: "game/42",
      available: true,
      sizeBytes: 1_572_864,
    }));
    expect(publicDownloadMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ filename: expect.anything() }),
    );
    expect(screen.queryByRole("button", { name: /open macro breakdown/i })).toBeNull();
  });

  it("normalizes result casing without mislabeling missing outcomes as draws", () => {
    render(
      <ReplayList
        items={[
          { ...REPLAY, gameId: "lower-win", result: "victory" },
          { ...REPLAY, gameId: "unknown", result: null },
        ]}
        owner
        playerName="Reaver"
      />,
    );
    expect(screen.getAllByText("Win")).toHaveLength(2);
    expect(screen.getAllByText("Unknown")).toHaveLength(2);
    expect(screen.queryByText("Draw")).toBeNull();
  });

  it("identifies races accessibly and does not present team games as 1v1", () => {
    render(
      <ReplayList
        items={[{ ...REPLAY, matchFormat: "team", playerCount: 4 }]}
        owner={false}
        playerName="Reaver"
        publicHandle="shared"
      />,
    );

    expect(screen.getAllByLabelText("Reaver, Protoss")).toHaveLength(2);
    expect(
      screen.getAllByLabelText("Primary opponent: Rival, Terran"),
    ).toHaveLength(2);
    expect(screen.getAllByText("Team game · 4 players")).toHaveLength(2);
  });

  it("renders an accessible empty state for an exhausted query", () => {
    render(<ReplayList items={[]} owner playerName="Reaver" />);
    expect(screen.getByText("No replays match these filters")).toBeTruthy();
    expect(screen.getByText(/Try a wider date range or clear the replay search filters/i)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
