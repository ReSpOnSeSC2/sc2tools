import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach } from "vitest";
import { CohortPicker } from "../CohortPicker";

afterEach(() => cleanup());

describe("CohortPicker", () => {
  it("renders all six controls", () => {
    render(
      <CohortPicker
        value={{ scope: "community" }}
        onChange={() => {}}
        availableBuilds={[]}
      />,
    );
    // Exact-match the field labels so we don't accidentally match
    // option text ("All builds") or the cohort badge.
    expect(screen.getByText("Build", { selector: "span" })).toBeTruthy();
    expect(screen.getByText("Matchup", { selector: "span" })).toBeTruthy();
    expect(screen.getByText("Opponent opening", { selector: "span" })).toBeTruthy();
    expect(screen.getByText("MMR bucket", { selector: "span" })).toBeTruthy();
    expect(screen.getByText("Scope", { selector: "span" })).toBeTruthy();
  });

  it("emits onChange when matchup is picked", () => {
    const onChange = vi.fn();
    render(
      <CohortPicker
        value={{ scope: "community" }}
        onChange={onChange}
        availableBuilds={[]}
      />,
    );
    const label = screen.getByText("Matchup", { selector: "span" });
    const matchupSelect = label.parentElement?.querySelector("select");
    if (!matchupSelect) throw new Error("matchup select not found");
    fireEvent.change(matchupSelect, { target: { value: "PvZ" } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ matchup: "PvZ", scope: "community" }),
    );
  });

  it("renders the tier badge when cohortTier is provided", () => {
    render(
      <CohortPicker
        value={{ scope: "community", matchup: "PvZ" }}
        onChange={() => {}}
        cohortTier={1}
        sampleSize={42}
      />,
    );
    expect(screen.getByText(/Tier 1/)).toBeTruthy();
    expect(screen.getByText(/42 games/)).toBeTruthy();
  });

  it("toggles scope buttons accessibly", () => {
    const onChange = vi.fn();
    render(
      <CohortPicker
        value={{ scope: "community" }}
        onChange={onChange}
        availableBuilds={[]}
      />,
    );
    const mineButton = screen.getByText("mine", { selector: "button" });
    fireEvent.click(mineButton);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "mine" }),
    );
  });
});
