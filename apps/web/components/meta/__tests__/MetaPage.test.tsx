import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { MetaRow } from "@/lib/meta";

const getJsonWithStatusMock = vi.fn();

vi.mock("@/lib/serverApi", () => ({
  getJsonWithStatus: (...args: unknown[]) => getJsonWithStatusMock(...args),
}));

vi.mock("@/components/meta/MetaControls", () => ({
  MetaControls: () => <div data-testid="meta-controls" />,
}));

vi.mock("@/components/meta/LadderMetaReport", () => ({
  LadderMetaReport: ({ row }: { row: MetaRow }) => (
    <div>Rendered meta row with {row.n} games</div>
  ),
}));

import MetaPage from "@/app/meta/page";

const ROW: MetaRow = {
  era: "after",
  bandType: "league",
  band: 4,
  bandLabel: "Diamond",
  leagueBand: 4,
  league: "Diamond",
  matchup: "PvZ",
  n: 67,
  openers: [],
  updatedAt: "2026-07-13T00:00:00.000Z",
  prevUpdatedAt: null,
};

afterEach(() => {
  cleanup();
  getJsonWithStatusMock.mockReset();
});

function renderMetaPage() {
  return MetaPage({
    searchParams: Promise.resolve({
      axis: "league",
      band: "4",
      matchup: "PvZ",
      era: "after",
    }),
  }).then(render);
}

describe("MetaPage API states", () => {
  test("renders a returned meta row and sends every canonical filter", async () => {
    getJsonWithStatusMock.mockResolvedValue({
      data: { row: ROW },
      status: 200,
    });

    await renderMetaPage();

    expect(screen.getByText("Rendered meta row with 67 games")).toBeTruthy();
    expect(getJsonWithStatusMock).toHaveBeenCalledWith(
      "/v1/meta/ladder?axis=league&band=4&matchup=PvZ&era=after",
      { revalidateSec: 3600 },
    );
  });

  test("reserves the not-enough-games state for an API 404", async () => {
    getJsonWithStatusMock.mockResolvedValue({ data: null, status: 404 });

    await renderMetaPage();

    expect(screen.getByText(/Not enough PvZ games vs Diamond opponents yet/i))
      .toBeTruthy();
    expect(screen.queryByText(/temporarily unavailable/i)).toBeNull();
  });

  test.each([null, 200, 400, 429, 500])(
    "renders a temporary-unavailable state for non-data status %s",
    async (status) => {
      getJsonWithStatusMock.mockResolvedValue({ data: null, status });

      await renderMetaPage();

      expect(screen.getByText("Ladder meta temporarily unavailable")).toBeTruthy();
      expect(screen.queryByText(/Not enough PvZ games/i)).toBeNull();
    },
  );
});
