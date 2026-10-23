import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { BuildRule } from "@/lib/build-rules";
import { RulesSummary } from "./RulesSummary";

afterEach(cleanup);

/** A group's rows as plain text, in display order. */
function rowsOf(title: string): string[] {
  const section = screen.getByRole("heading", { name: title }).closest("section");
  if (!section) throw new Error(`no section for ${title}`);
  return within(section)
    .getAllByRole("listitem")
    .map((li) => (li.textContent ?? "").replace(/\s+/g, " ").trim());
}

const RULES: BuildRule[] = [
  { type: "count_min", name: "BuildVoidRay", count: 4, time_lt: 600 },
  { type: "not_before", name: "BuildRoboticsFacility", time_lt: 240 },
  { type: "before", name: "BuildStargate", time_lt: 210 },
  { type: "count_max", name: "BuildTwilightCouncil", count: 0, time_lt: 260 },
  { type: "count_max", name: "BuildStargate", count: 2, time_lt: 480 },
  { type: "count_exact", name: "BuildNexus", count: 2, time_lt: 300 },
  { type: "before", name: "BuildGateway", time_lt: 105, proxy: true },
];

describe("RulesSummary", () => {
  it("lists Must have, Must not have and Limits in the legend's words, by deadline", () => {
    render(<RulesSummary rules={RULES} />);
    expect(screen.getByRole("heading", { name: "Build order" })).toBeTruthy();
    expect(screen.getByText("7 rules")).toBeTruthy();
    expect(rowsOf("Must have")).toEqual([
      "At least 1 Gateway before 1:45Proxy",
      "At least 1 Stargate before 3:30",
      "Exactly 2 Nexuses before 5:00",
      "At least 4 Void Rays before 10:00",
    ]);
    expect(rowsOf("Must not have")).toEqual([
      "No Robotics Facility before 4:00",
      "No Twilight Council before 4:20",
    ]);
    expect(rowsOf("Limits")).toEqual(["At most 2 Stargates before 8:00"]);
  });

  it("never shows At most 0 as something to build", () => {
    render(
      <RulesSummary
        rules={[{ type: "count_max", name: "BuildRoboticsFacility", count: 0, time_lt: 260 }]}
      />,
    );
    expect(rowsOf("Must not have")).toEqual(["No Robotics Facility before 4:20"]);
    expect(screen.queryByRole("heading", { name: "Must have" })).toBeNull();
    expect(screen.queryByText(/×1/)).toBeNull();
  });

  it("keeps not_before rules (the old timeline dropped them)", () => {
    render(<RulesSummary rules={[{ type: "not_before", name: "BuildStargate", time_lt: 300 }]} />);
    expect(rowsOf("Must not have")).toEqual(["No Stargate before 5:00"]);
  });

  it("shows deadlines as 'before m:ss' in mono and a Proxy badge only on proxy rules", () => {
    render(<RulesSummary rules={RULES} />);
    const time = screen.getByText("1:45");
    expect(time.className).toContain("font-mono");
    expect(time.parentElement?.textContent).toBe("before 1:45");
    expect(screen.getAllByText("Proxy")).toHaveLength(1);
  });

  it("has a 'How rules count' legend that links to the help article", () => {
    render(<RulesSummary rules={RULES} />);
    expect(screen.getByText("How rules count")).toBeTruthy();
    expect(screen.getByText("At least 2")).toBeTruthy();
    const help = screen.getByRole("link", { name: "How build rules are counted" });
    expect(help.getAttribute("href")).toBe("/help/rules-explained");
  });

  it("renders nothing without rules", () => {
    const { container } = render(<RulesSummary rules={[]} />);
    expect(container.innerHTML).toBe("");
  });
});
