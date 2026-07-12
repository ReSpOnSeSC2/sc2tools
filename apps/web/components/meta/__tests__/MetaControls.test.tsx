import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MetaControls } from "../MetaControls";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

afterEach(() => {
  cleanup();
  push.mockReset();
});

describe("MetaControls", () => {
  it("renders the axis control and league bands", () => {
    render(<MetaControls axis="league" band={4} matchup="PvZ" era="after" />);

    expect(screen.getByLabelText("Band axis")).toHaveProperty(
      "value",
      "league",
    );
    expect(screen.getByLabelText("League band")).toHaveProperty("value", "4");
    expect(screen.queryByLabelText("Opponent MMR band")).toBeNull();
    expect(screen.getByLabelText("Game version")).toHaveProperty("value", "after");
  });

  it("switches to MMR at its default canonical URL", () => {
    render(<MetaControls axis="league" band={5} matchup="TvZ" era="after" />);

    fireEvent.change(screen.getByLabelText("Band axis"), {
      target: { value: "mmr" },
    });

    expect(push).toHaveBeenCalledWith(
      "/meta?axis=mmr&band=4000&matchup=TvZ&era=after",
    );
  });

  it("renders every MMR range and preserves the axis on changes", () => {
    render(<MetaControls axis="mmr" band={4500} matchup="PvZ" era="after" />);

    const mmrBand = screen.getByLabelText("Opponent MMR band");
    expect(mmrBand).toHaveProperty("value", "4500");
    expect(screen.getAllByRole("option")).toHaveLength(24);

    fireEvent.change(mmrBand, { target: { value: "5000" } });
    expect(push).toHaveBeenLastCalledWith(
      "/meta?axis=mmr&band=5000&matchup=PvZ&era=after",
    );

    fireEvent.change(screen.getByLabelText("Matchup"), {
      target: { value: "ZvT" },
    });
    expect(push).toHaveBeenLastCalledWith(
      "/meta?axis=mmr&band=4500&matchup=ZvT&era=after",
    );
  });

  it("switches between the 8-worker and 12-worker meta", () => {
    render(<MetaControls axis="league" band={4} matchup="PvZ" era="after" />);
    fireEvent.change(screen.getByLabelText("Game version"), {
      target: { value: "before" },
    });
    expect(push).toHaveBeenCalledWith(
      "/meta?axis=league&band=4&matchup=PvZ&era=before",
    );
  });
});
