import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { measuredPlanHeldRate, PlanHeldBadge } from "./PlanHeldBadge";
afterEach(cleanup);
it("keeps a measured zero visible and suppresses unknown or invalid small-sample summaries", () => {
  const view = render(<PlanHeldBadge rate={0} />); expect(screen.getByText("Held 0%")).toBeTruthy();
  view.rerender(<PlanHeldBadge rate={.62} />); expect(screen.getByText("Held 62%")).toBeTruthy();
  for (const rate of [null, undefined, NaN, Infinity, -1, 1.1]) { view.rerender(<PlanHeldBadge rate={rate} />); expect(screen.queryByText(/Held/)).toBeNull(); }
  expect(measuredPlanHeldRate(0)).toBe(true); expect(measuredPlanHeldRate(".5")).toBe(false);
});
