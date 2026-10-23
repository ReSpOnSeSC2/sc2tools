import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MapRaceMatrix } from "../map/MapRaceMatrix";
import { MapGuide } from "../map/MapGuide";
import { FIXTURE_MAP } from "@/lib/guides/__fixtures__";
import { GUIDE_CELL_MIN_GAMES, GUIDE_CELL_MIN_USERS } from "@/lib/guides/guideCopy";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
afterEach(cleanup);
describe("MapRaceMatrix", () => {
  it.each([
    [GUIDE_CELL_MIN_GAMES - 1, GUIDE_CELL_MIN_USERS],
    [GUIDE_CELL_MIN_GAMES, GUIDE_CELL_MIN_USERS - 1],
  ])("suppresses a cell with %i games and %i players", (games, users) => {
    const row = { ...FIXTURE_MAP.matchups[0], games, users };
    render(<MapRaceMatrix rows={[row]} />);
    const protoss = screen.getByRole("rowheader", { name: "Protoss" }).closest("tr")!;
    const cell = within(protoss).getAllByRole("cell")[2];
    expect(cell.textContent).toBe("Not enough games");
    expect(cell.textContent).not.toContain("%");
  });
  it("leaves a personal panel directly below the matrix without changing navigation", () => {
    const { container } = render(<MapGuide payload={FIXTURE_MAP} personalSlot={<section data-testid="personal-map">Your map results</section>} />);
    const matrix = container.querySelector("#matchups")!;
    expect(matrix.nextElementSibling?.getAttribute("data-testid")).toBe("personal-map");
    expect(screen.getByRole("table")).toBeTruthy();
  });
});
