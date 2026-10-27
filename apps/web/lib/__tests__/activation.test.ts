import { describe, expect, it } from "vitest";
import { activationProgress, activationRows, validActivation, type ActivationResponse } from "../activation";

const answer = (extra: Partial<ActivationResponse> = {}): ActivationResponse => ({ identity: false, firstGameViewed: false, customBuild: false, checkIn: false, overlayLive: false, chatOn: false, goals: [], levelUpDismissedAt: null, ...extra });

describe("suggested activation steps", () => {
  it.each([
    [["improve"], ["identity", "firstGameViewed", "customBuild", "checkIn"]],
    [["stream"], ["identity", "firstGameViewed", "overlayLive", "chatOn"]],
    [["improve", "stream"], ["identity", "firstGameViewed", "customBuild", "checkIn", "overlayLive", "chatOn"]],
  ])("selects the exact steps for %j", (goals, ids) => expect(activationRows(goals).map(row => row.id)).toEqual(ids));
  it.each([undefined, null, [], ["unknown"], "stream", ["improve", 7], ["improve", "improve", "improve"]])("keeps both goals discoverable for %j", goals => expect(activationRows(goals)).toHaveLength(6));
  it("counts only selected goals and permits saved-state regression", () => {
    const value = answer({ goals: ["improve"], identity: true, firstGameViewed: true, customBuild: true, checkIn: true });
    expect(activationProgress(value)).toMatchObject({ done: 4, total: 4, complete: true });
    expect(activationProgress({ ...value, customBuild: false })).toMatchObject({ done: 3, total: 4, complete: false });
    expect(activationProgress({ ...value, goals: [] })).toMatchObject({ done: 4, total: 6, complete: false });
  });
  it("has real deep links and help for every row, without a placeholder tour", () => {
    const rows = activationRows([]);
    expect(rows.map(row => row.href)).toEqual(["/settings?tab=profile", "/app/replays", "/builds", "/settings?tab=checkin", "/settings?tab=overlay", "/settings?tab=chat#platforms"]);
    expect(rows.every(row => row.help && row.why && row.action)).toBe(true);
  });
  it("admits only the narrow boolean response with valid dismissal metadata", () => {
    expect(validActivation(answer())).toBe(true);
    expect(validActivation(answer({ levelUpDismissedAt: "2026-10-26T12:00:00.000Z" }))).toBe(true);
    for (const value of [null, {}, { ...answer(), identity: "yes" }, { ...answer(), goals: ["unknown"] }, { ...answer(), levelUpDismissedAt: "not-a-date" }, { ...answer(), levelUpDismissedAt: "0" }, { ...answer(), levelUpDismissedAt: "2026-02-30T12:00:00.000Z" }]) expect(validActivation(value)).toBe(false);
  });
});
