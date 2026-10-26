import { beforeEach, expect, it } from "vitest";
import { rememberReplayPage, replayBefore, replayPageMemory, replayUntil } from "../replayListNavigation";
beforeEach(() => sessionStorage.clear());
it("validates calendar days and narrows rather than extends the global until", () => {
  expect(replayBefore("2026-02-30")).toBe(""); expect(replayBefore("2026-02-28")).toBe("2026-02-28");
  expect(replayUntil(null, "2026-08-10")).toBe("2026-08-10T23:59:59.999Z");
  expect(replayUntil("2026-08-01", "2026-08-10")).toBe("2026-08-01");
});
it("isolates page chains by owner and exact filter cohort", () => {
  rememberReplayPage("A", "q=old", null, "older"); rememberReplayPage("A", "q=old", "older", "oldest");
  expect(replayPageMemory("A", "q=old", "oldest")).toEqual({ hasPrevious: true, previous: "older", page: 3 });
  expect(replayPageMemory("B", "q=old", "oldest").hasPrevious).toBe(false);
  expect(replayPageMemory("A", "q=new", "oldest").hasPrevious).toBe(false);
  expect(replayPageMemory("A", "q=old", "unknown").page).toBeNull();
});
it("bounds recent cohort/page history while retaining honest page numbers", () => {
  for (let i = 0; i < 70; i++) rememberReplayPage("A", "q=old", i ? `page-${i}` : null, `page-${i + 1}`);
  expect(replayPageMemory("A", "q=old", "page-70").page).toBe(71);
  expect(replayPageMemory("A", "q=old", "page-1").hasPrevious).toBe(false);
  for (let i = 0; i < 20; i++) rememberReplayPage("A", `q=${i}`, null, "older");
  expect(replayPageMemory("A", "q=old", "page-70").page).toBeNull();
});
