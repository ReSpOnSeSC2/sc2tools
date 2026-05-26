import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AutoCandidateRulesPreview } from "../AutoCandidateRulesPreview";
import type { AutoCandidateRule } from "../types";

afterEach(cleanup);

const RULES: AutoCandidateRule[] = [
  { type: "before", name: "BuildStargate", time_lt: 210 },
  { type: "not_before", name: "BuildRoboticsFacility", time_lt: 240 },
  { type: "count_max", name: "TrainPhoenix", time_lt: 300, count: 2 },
];

describe("AutoCandidateRulesPreview", () => {
  it("renders the empty-state when no rules are supplied", () => {
    render(<AutoCandidateRulesPreview rules={[]} />);
    expect(
      screen.getByText(/No rules captured for this candidate/i),
    ).toBeTruthy();
  });

  it("renders one row per rule with humanised entity + connector + time", () => {
    render(<AutoCandidateRulesPreview rules={RULES} />);
    expect(screen.getByText("Stargate")).toBeTruthy();
    expect(screen.getByText("Robotics Facility")).toBeTruthy();
    expect(screen.getByText("Phoenix")).toBeTruthy();
    expect(screen.getAllByText("before").length).toBe(2);
    expect(screen.getByText("by")).toBeTruthy();
    expect(screen.getByText("3:30")).toBeTruthy();
    expect(screen.getByText("4:00")).toBeTruthy();
    expect(screen.getByText("5:00")).toBeTruthy();
  });

  it("applies the danger tint to the 'no' prefix on not_before", () => {
    render(<AutoCandidateRulesPreview rules={RULES} />);
    const noPrefix = screen.getByText(/^no\s*$/);
    expect(noPrefix.className).toMatch(/text-danger/);
  });
});
