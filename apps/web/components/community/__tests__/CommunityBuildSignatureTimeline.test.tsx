import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CommunityBuildSignatureTimeline } from "../CommunityBuildSignatureTimeline";

afterEach(cleanup);

function rowTexts(): string[] {
  return screen
    .getAllByRole("listitem")
    .map((li) => (li.textContent ?? "").replace(/\s+/g, " ").trim());
}

describe("CommunityBuildSignatureTimeline", () => {
  it("keeps each row's count with its own unit when a signature has a blank unit", () => {
    render(
      <CommunityBuildSignatureTimeline
        signature={[
          { unit: "", count: 9, beforeSec: 30 },
          { unit: "Stargate", count: 2, beforeSec: 300 },
          { unit: "VoidRay", count: 1, beforeSec: 400 },
        ]}
      />,
    );
    const rows = rowTexts();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("Stargate×2");
    expect(rows[1]).toContain("Void Ray");
    expect(rows[1]).not.toContain("×");
    expect(screen.queryByText("×9")).toBeNull();
    expect(screen.getByText("2 steps")).toBeTruthy();
  });

  it("reads times as deadlines and marks proxy steps", () => {
    render(
      <CommunityBuildSignatureTimeline
        signature={[
          { unit: "Gateway", count: 2, beforeSec: 105, proxy: true },
          { unit: "Pylon", count: 1, beforeSec: 30 },
        ]}
      />,
    );
    const [gateway, pylon] = rowTexts();
    expect(gateway).toMatch(/^before 1:45/);
    expect(gateway).toContain("Proxy");
    expect(pylon).toMatch(/^before 0:30/);
    expect(pylon).not.toContain("Proxy");
  });
});
