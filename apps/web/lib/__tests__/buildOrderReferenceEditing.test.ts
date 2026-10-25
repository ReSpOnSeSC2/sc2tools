import { describe, expect, it } from "vitest";
import { collapseReferenceArmy, parseReferenceClock, referenceFromGame } from "../buildOrderReferenceEditing";
import { referenceBuildToMarkdown, referenceBuildToText } from "../gameExport";
import { referenceOrderPracticeTarget } from "../practiceTarget";
import { sanitiseDraft, type BuildEditorDraft } from "../build-rules";

const meta = { title: "Reference", matchup: "PvT", sourceUrl: "/builds/reference" };
describe("reference editing, export and practice", () => {
  it("folds worker rows while preserving recorded exact/approximate supply and ordered clocks", () => {
    expect(referenceFromGame([{ time: 28, name: "Gateway", is_building: true, supply: 15, supplyApprox: true }, { time: 5, name: "Probe", supply: 13 }, { time: 18, name: "Pylon", is_building: true, supply: 14 }], "private"))
      .toEqual({ v: 1, source: "game", sourceGameId: "private", steps: [{ t: 18, supply: 14, action: "BuildPylon" }, { t: 28, supply: 15, action: "BuildGateway", supplyApprox: true }] });
  });
  it("collapses only adjacent repeated army rows and states the count/last time", () => {
    const rows = [10, 20, 30].map(t => ({ t, supply: null, action: "TrainMarine" }));
    expect(collapseReferenceArmy([...rows, { t: 40, supply: null, action: "BuildBarracks" }, rows[0]]))
      .toEqual([{ ...rows[0], note: "Repeated 3 times; last at 0:30." }, { t: 40, supply: null, action: "BuildBarracks" }, rows[0]]);
    expect(collapseReferenceArmy([{ ...rows[0], note: "Keep this instruction" }, rows[1]])).toHaveLength(2);
  });
  it("exports authored order, unknown clocks, approximate supply and escaped Markdown notes", () => {
    const steps = [{ t: 90, supply: 20, supplyApprox: true, action: "BuildGateway", note: "A | B" }, { t: null, supply: 14, action: "Unknown action" }];
    const text = referenceBuildToText(steps, meta), md = referenceBuildToMarkdown(steps, meta);
    expect(text).toContain("[1:30] ≈20 BuildGateway — A | B\n[—] 14 Unknown action");
    expect(md).toContain("| — | 14 | Unknown action |  |"); expect(md).toContain("A \\| B");
    expect(text).not.toContain("0:00");
  });
  it("practices only supplied known timed steps and never claims approximate supply as exact", () => {
    expect(referenceOrderPracticeTarget("Practice", { v: 1, source: "paste", steps: [
      { t: null, supply: 14, action: "BuildPylon" }, { t: 30, supply: 20, supplyApprox: true, action: "BuildGateway" },
      { t: 40, supply: null, action: "Unknown action" }, { t: 50, supply: 21, action: "TrainStalker" },
    ] })?.steps).toEqual([{ t: 30, supply: null, name: "Gateway" }, { t: 50, supply: 21, name: "Stalker" }]);
    expect(referenceOrderPracticeTarget("Untimed", { v: 1, source: "paste", steps: [{ t: null, supply: 14, action: "BuildPylon" }] })).toBeNull();
    expect(referenceOrderPracticeTarget("Wrong race", { v: 1, source: "paste", steps: [{ t: 30, supply: 14, action: "BuildBarracks" }] }, "P")).toBeNull();
  });
  it("accepts reference-only drafts with unknown actions, while invalid times prevent save", () => {
    const draft: BuildEditorDraft = { name: "Reference", description: "", notes: "", race: "Protoss", vsRace: "Any", skillLevel: null, shareWithCommunity: false, winConditions: [], losesTo: [], transitionsInto: [], rules: [],
      buildOrder: { v: 1, source: "paste", steps: [{ t: null, supply: 14, action: "Unknown future action" }] } };
    expect(sanitiseDraft(draft).ok).toBe(true); expect(sanitiseDraft(draft).payload.rules).toEqual([]);
    expect(sanitiseDraft({ ...draft, buildOrder: { ...draft.buildOrder!, steps: [{ t: -1, supply: null, action: "BuildPylon" }] } }).errors.buildOrder).toBeTruthy();
    expect(parseReferenceClock("7:99")).toBe(-1); expect(parseReferenceClock("")).toBeNull(); expect(parseReferenceClock("0:00")).toBe(0);
  });
});
