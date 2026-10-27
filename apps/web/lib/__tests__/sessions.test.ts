import { describe, expect, it } from "vitest";
import fixtures from "../../../../shared/fixtures/sessions.json";
import { instant, ordered, sessionize } from "../sessions";

describe("shared API/web session fixtures", () => {
  it.each(fixtures)("$name", fixture => {
    const before = structuredClone(fixture.games);
    const groups = sessionize<(typeof fixture.games)[number]>(fixture.games, fixture);
    expect(groups.map(group => group.games.map(game => game.fixture))).toEqual(fixture.groups);
    expect(fixture.games).toEqual(before);
    for (const group of groups) for (const game of group.games) expect(fixture.games).toContain(game);
  });
  it.each([15, 90, 240, 480])("keeps exact gap%d connected", gapMinutes => {
    for (const delta of [-1, 0, 1]) expect(sessionize([{ date: 0 }, { date: gapMinutes * 60000 + delta }], { gapMinutes })).toHaveLength(delta > 0 ? 2 : 1);
  });
  it("keeps the typed missing/null/bool/number distinctions and epoch/date range", () => {
    const rows = [{ date: 0, myMmr: 0 }, { date: 0, myMmr: null }, { date: 0 }, { date: 0, myMmr: false }];
    expect(ordered(rows).map(row => row.game)).toEqual([rows[2], rows[1], rows[3], rows[0]]);
    expect(instant(new Date(0))).toBe(0); expect(instant(8640000000000000)).toBe(8640000000000000);
    for (const value of [null, true, "", "2026-10-26", Infinity, 8640000000000001]) expect(instant(value)).toBeNull();
  });
});
