import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/clientApi", () => ({
  useApi: (path: string | null) => ({
    data: path?.endsWith("/macro-breakdown")
      ? {
          macro_score: 60,
          race: "Protoss",
          raw: {},
          game_length_sec: 640,
          stats_events: [{ time: 0, food_used: 12 }],
        }
      : undefined,
    error: null,
    isLoading: false,
    mutate: vi.fn(),
    request: vi.fn(),
  }),
}));
vi.mock("@/components/analyzer/game/MapReplaySection", () => ({
  MapReplaySection: ({ patchEra }: { patchEra: string }) => (
    <div aria-label="Map playback era">{patchEra}</div>
  ),
}));
vi.mock("../MacroChartSection", () => ({
  MacroChartSection: ({ patchEra }: { patchEra: string }) => (
    <div aria-label="Chart era">{patchEra}</div>
  ),
}));

import { MacroBreakdownPanel } from "../MacroBreakdownPanel";
import type { PanelHeaderMeta } from "../MacroBreakdownPanel.types";

afterEach(cleanup);

function eras(headerMeta: PanelHeaderMeta) {
  render(<MacroBreakdownPanel open gameId="g1" onClose={vi.fn()} headerMeta={headerMeta} />);
  return [
    screen.getByLabelText("Chart era").textContent,
    screen.getByLabelText("Map playback era").textContent,
  ];
}

// 2026-10-01 sits inside the date rule's 8-worker window (5.0.16 release
// onwards while 5.0.17 has no live date), so the date alone reads "before".
const DATE = "2026-10-01T20:00:00Z";

describe("MacroBreakdownPanel patch era", () => {
  it("prices a 5.0.17 game as 12-worker from the row's version, not its date", () => {
    expect(eras({ gameVersion: "5.0.17.98100", dateIso: DATE })).toEqual(["after", "after"]);
  });

  it("uses the numeric build when the row has no release string", () => {
    expect(eras({ gameBuild: 96_883, dateIso: DATE })).toEqual(["after", "after"]);
  });

  it("falls back to the date rule for a row without version metadata", () => {
    expect(eras({ dateIso: DATE })).toEqual(["before", "before"]);
    cleanup();
    expect(eras({ gameVersion: null, gameBuild: null, dateIso: DATE })).toEqual(["before", "before"]);
  });

  it("keeps an 8-worker 5.0.16 game in the 8-worker era", () => {
    expect(eras({ gameVersion: "5.0.16.97425", dateIso: DATE })).toEqual(["before", "before"]);
  });
});
