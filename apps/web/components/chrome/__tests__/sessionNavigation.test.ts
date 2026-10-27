import { expect, it } from "vitest";
import { MOBILE_TAB_KEYS, NAV_ENTRIES, isAppSurfacePath, isProtectedSurfacePath, matchSurface } from "../appNav";
import { isAnalyzerViewPath } from "@/lib/analyzerViews";

it("adds private Sessions to desktop and More while retaining the original four mobile destinations plus More", () => {
  expect(NAV_ENTRIES.find(row => row.key === "sessions")).toMatchObject({ href: "/app/sessions", label: "Sessions", group: "section" });
  expect(MOBILE_TAB_KEYS).toEqual(["today", "opponents", "trends", "builds"]);
  expect(isAppSurfacePath("/app/sessions")).toBe(true); expect(isProtectedSurfacePath("/app/sessions/opaque-id")).toBe(true);
  expect(matchSurface("/app/sessions/opaque-id")?.entry.key).toBe("sessions");
  expect(matchSurface("/app/sessions/opaque-id")?.backHref).toBe("/app/sessions");
  expect(isAnalyzerViewPath("/app/sessions")).toBe(true); expect(isAnalyzerViewPath("/app/sessions/opaque-id")).toBe(true);
  expect(isAnalyzerViewPath("/app/sessions-other")).toBe(false);
});
