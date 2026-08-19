import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MapReplaySection } from "../MapReplaySection";

let mockApi: { data: unknown; isLoading: boolean; error: unknown };
vi.mock("@/lib/clientApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/clientApi")>();
  return { ...actual, useApi: () => mockApi };
});

afterEach(() => cleanup());

const PLAYBACK = {
  v: 1,
  mapName: "Alcyone LE",
  gameLength: 700,
  bounds: { minX: 10, minY: 20, maxX: 190, maxY: 160 },
  spawns: [{ owner: "me", x: 30, y: 40 }],
  battles: [],
  buildings: [{ owner: "me", name: "Nexus", t: 0, x: 30, y: 40 }],
  units: [
    { owner: "me", name: "Stalker", born: 120, died: 300, wp: [120, 30, 40] },
  ],
  // Real payloads carry stats rows to the end of the game — keep the
  // fixture's last row near gameLength or sanitize clamps the length.
  stats: {
    me: [
      [0, 0, 12, 12],
      [690, 900, 40, 120],
    ],
    opp: [],
  },
};

describe("MapReplaySection", () => {
  // The full-page host now renders ReplayStage, so the transport is
  // TransportDock's (aria-labelled "Play"/"Pause"/"Playback speed N
  // times…") rather than MapReplayer's own "▶ Play" / "8×" chrome,
  // which ReplayStage hides via ``hideControls``. The canvas, the map
  // name and the scrubber are unchanged.
  it("renders the replayer with controls and HUD for real playback data", () => {
    mockApi = { data: PLAYBACK, isLoading: false, error: null };
    render(<MapReplaySection gameId="g1" />);
    expect(screen.getByTestId("map-replayer")).toBeTruthy();
    expect(screen.getByTestId("replay-transport")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /playback speed/i })).toBeTruthy();
    expect(screen.getByLabelText("Playback position")).toBeTruthy();
    // Scoped to the dock: the HUD also renders an sr-only live-stats
    // sentence ("At 0:00 of 11:40 on Alcyone LE: …"), so an unscoped
    // /11:40/ now matches two nodes.
    expect(
      within(screen.getByTestId("replay-transport")).getByText(/11:40/),
    ).toBeTruthy(); // 700s game length
    expect(screen.getByText("Alcyone LE")).toBeTruthy();
    // Play toggles to Pause.
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
  });

  it("shows the re-sync hint for pre-playback uploads", () => {
    mockApi = { data: null, isLoading: false, error: { status: 404 } };
    render(<MapReplaySection gameId="g1" />);
    expect(screen.getByText(/No playback data for this game/)).toBeTruthy();
  });

  it("compact host hides entirely when absent", () => {
    mockApi = { data: null, isLoading: false, error: { status: 404 } };
    const { container } = render(<MapReplaySection gameId="g1" compact />);
    expect(container.textContent).toBe("");
  });
});
