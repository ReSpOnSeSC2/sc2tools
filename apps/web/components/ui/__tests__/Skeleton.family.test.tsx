import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { SkeletonChart, SkeletonKpi } from "../Skeleton";

afterEach(cleanup);
it("announces each pending region once without fake values or interactive placeholders", () => {
  render(<><SkeletonChart label="Loading session chart" /><SkeletonKpi label="Loading win rate" /></>);
  expect(screen.getAllByRole("status").map(region => region.textContent)).toEqual(["Loading session chart", "Loading win rate"]);
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.queryByText(/0%|100%|—/)).toBeNull();
  for (const region of screen.getAllByRole("status")) expect(region.getAttribute("aria-busy")).toBe("true");
});
