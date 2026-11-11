import { expect, test } from "vitest";
import { filterStudioReplays, shelfReplayContext, studioReplays, studioReplayTitle } from "./lockerStudioReplays";

test("authoring searches private owner rows and persists a minimal Classic-compatible replay context", () => {
  const rows = studioReplays([{ gameId: "private-id", date: "2026-11-04T14:00:00Z", map: "Map One", myBuild: "Safe opener", result: "Victory", myRace: "Zerg", opponent: { displayName: "Private Opponent", race: "Terran" } },
    { date: "2026-12-32", map: "Malformed", myRace: "Zerg" }], "mine");
  expect(filterStudioReplays(rows, { search: "private opponent", matchup: "ZvT", since: "2026-11-04", until: "2026-11-04" })).toEqual(rows);
  expect(rows).toHaveLength(1);
  const snapshot = shelfReplayContext(rows[0]);
  expect(snapshot).toEqual({ d: "2026-11-04", m: "Map One", o: "", b: "Safe opener", res: "W" });
  expect(JSON.stringify({ snapshot, title: studioReplayTitle(rows[0]) })).not.toMatch(/private-id|Private Opponent/);
});

test("student picks use the consent route's slim shape and leave opponent names out of the UI", () => {
  const rows = studioReplays([{ d: "2026-11-05", m: "Map Two", b: "PvZ opener", res: "L", o: "Student opponent" }], "student");
  expect(rows).toEqual([expect.objectContaining({ matchup: "PvZ", result: "L", opponent: "" })]);
  expect(filterStudioReplays(rows, { search: "student opponent", matchup: "", since: "", until: "" })).toEqual([]);
});
