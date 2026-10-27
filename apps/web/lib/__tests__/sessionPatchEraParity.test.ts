import { expect, it } from "vitest";
import { sanitizeViewFilters, VIEW_FILTER_KEYS, viewFiltersFromQuery, viewFiltersQuery } from "../analyzerViews";

it.each(["before", "after"] as const)("retains custom patch_era=%s through the shared choices schema and URL round trip", patch_era => {
  const filters = sanitizeViewFilters({ preset: "custom", patch_era, map_pool: "all", exclude_too_short: false });
  expect(filters.patch_era).toBe(patch_era);
  expect(viewFiltersFromQuery(viewFiltersQuery(filters)).filters.patch_era).toBe(patch_era);
  expect(VIEW_FILTER_KEYS.filter(key => key === "patch_era")).toHaveLength(1);
});

it.each(["future", "BEFORE", "after\u0000", ["before"], { $ne: "after" }].map(value => ({ value })))("drops unsupported patch eras instead of persisting them: %j", ({ value }) => {
  expect(sanitizeViewFilters({ preset: "custom", patch_era: value })).not.toHaveProperty("patch_era");
});

it("retires explicit custom patch state when a non-custom date preset is selected", () => {
  expect(sanitizeViewFilters({ preset: "current_season", patch_era: "before" })).not.toHaveProperty("patch_era");
  expect(sanitizeViewFilters({ preset: "patch_5_0_16", patch_era: "after" })).not.toHaveProperty("patch_era");
});
