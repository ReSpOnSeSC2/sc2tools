import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("@/lib/lossAutopsy", () => ({ lossAutopsy: () => [73, 50, 12].map((score) => ({ id: String(score), title: "Leak", detail: "Fixture", severityScore: score, timestamps: [] })) }));
import { LossAutopsyCard } from "../LossAutopsyCard";
afterEach(cleanup);
it("names severity levels and their score accessibly", () => {
  render(<LossAutopsyCard game={{ result: "Defeat" }} />);
  for (const [score, severity] of [[73, "high"], [50, "medium"], [12, "low"]]) {
    expect(screen.getByLabelText(`Severity ${score} out of 100, ${severity}`)).toBeTruthy();
  }
  expect(screen.getByText("High · 73")).toBeTruthy();
});
