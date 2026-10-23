import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CommunityGamePlan, planItems } from "../CommunityGamePlan";

afterEach(cleanup);

describe("CommunityGamePlan", () => {
  it("shows the author's lists and leaves out empty ones", () => {
    render(
      <CommunityGamePlan
        winConditions={["Kill the third with Oracles", "  "]}
        losesTo={[]}
        transitionsInto={["Blink Stalkers"]}
      />,
    );
    expect(screen.getByRole("heading", { name: "Game plan" })).toBeTruthy();
    const win = screen.getByRole("heading", { name: "Win conditions" }).closest("section")!;
    expect(within(win).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Kill the third with Oracles",
    ]);
    expect(screen.getByText("Blink Stalkers")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Loses to" })).toBeNull();
  });

  it("is hidden when every list is empty or missing", () => {
    const { container } = render(
      <CommunityGamePlan winConditions={undefined} losesTo={["", "   "]} transitionsInto={null} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("keeps only non-empty strings, trimmed and capped", () => {
    expect(planItems(["  a ", 3, null, "", "b"])).toEqual(["a", "b"]);
    expect(planItems("not a list")).toEqual([]);
    expect(planItems(Array.from({ length: 30 }, (_, i) => `item ${i}`))).toHaveLength(20);
    expect(planItems(["x".repeat(400)])[0]).toHaveLength(280);
  });
});
