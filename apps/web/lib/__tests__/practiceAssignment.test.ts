import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePracticeTarget } from "../practiceAssignment";
import { replayOrderTarget, ruleCheckpointTarget } from "../practiceTarget";

const h = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("../clientApi", () => ({ apiCall: (...args: unknown[]) => h.call(...args) }));
const target = { v: 1, name: "Reference", steps: [{ supply: null, t: 40, name: "Gateway" }], sourceGameId: "ref" };
const input = { build: { name: "Blink", slug: "blink", race: "Protoss", vsRace: "Terran", sourceGameId: "source", rules: [{ type: "before", name: "Gateway", time_lt: 60 }] }, privateBuild: true };
const signal = () => new AbortController().signal;
afterEach(() => vi.resetAllMocks());
describe("honest practice source selection", () => {
  it("prefers the exact build reference, limits250 steps to80 and preserves source id", async () => {
    h.call.mockResolvedValue({ references: { other: { buildKey: "different", matchup: "PvT", side: "you", target: { ...target, name: "Wrong" } }, right: { buildKey: "blink", matchup: "PvT", side: "you", target: { ...target, steps: Array(250).fill(target.steps[0]) } } } });
    const result = await resolvePracticeTarget(input, "PvT", async () => "token", signal());
    expect(result.target.steps).toHaveLength(80); expect(result.target.sourceGameId).toBe("ref"); expect(result.source).toMatch(/reference/); expect(h.call).toHaveBeenCalledTimes(1);
  });
  it("then reads the private source replay using the build's perspective", async () => {
    h.call.mockResolvedValueOnce({ references: {} }).mockResolvedValueOnce({ events: [{ time: 10, name: "Wrong" }], opp_events: [{ time: 12, name: "SCV" }, { time: 40, name: "Barracks" }] });
    const result = await resolvePracticeTarget({ ...input, build: { ...input.build, perspective: "opponent" } }, "TvP", async () => "token", signal());
    expect(result.target.steps).toEqual([{ supply: null, t: 40, name: "Barracks" }]); expect(result.target.sourceGameId).toBe("source");
    expect(h.call.mock.calls[1][1]).toBe("/v1/games/source/build-order");
  });
  it("uses positive rule deadlines as labelled checkpoints when source replay is unavailable", async () => {
    h.call.mockResolvedValueOnce({ references: {} }).mockRejectedValueOnce({ status: 404 });
    const result = await resolvePracticeTarget(input, "PvT", async () => "token", signal());
    expect(result.source).toMatch(/not recorded/); expect(result.target.name).toMatch(/checkpoints/); expect(result.target.steps[0].t).toBe(60);
  });
  it("does not let a public snapshot fetch a named private replay", async () => {
    h.call.mockResolvedValue({ references: {} });
    const result = await resolvePracticeTarget({ ...input, privateBuild: false }, "PvT", async () => "token", signal());
    expect(result.source).toMatch(/Rule deadlines/); expect(h.call).not.toHaveBeenCalled();
  });
  it("surfaces failed higher-priority reads instead of silently claiming a lower-priority target", async () => {
    h.call.mockRejectedValue({ status: 503 });
    await expect(resolvePracticeTarget(input, "PvT", async () => "token", signal())).rejects.toEqual({ status: 503 });
  });
  it("never fabricates produced steps from negative, max-count or proxy conditions", () => {
    expect(ruleCheckpointTarget("No build", [{ type: "not_before", name: "Gateway", time_lt: 30 }, { type: "count_max", name: "Pylon", time_lt: 40, count: 2 }, { type: "before", name: "BuildGateway", time_lt: 60, proxy: true }, { type: "before", name: "Gateway" }])).toBeNull();
  });
  it("strips rule verbs and merges cumulative counts without inventing duplicate production", () => {
    expect(ruleCheckpointTarget("Gates", [{ type: "before", name: "BuildGateway", time_lt: 60 }, { type: "count_min", name: "BuildGateway", time_lt: 120, count: 3 }])?.steps).toEqual([{ supply: null, t: 60, name: "Gateway" }, { supply: null, t: 120, name: "Gateway" }, { supply: null, t: 120, name: "Gateway" }]);
  });
  it("uses recorded upgrade completion while retaining building starts and dropping workers", () => {
    expect(replayOrderTarget("Blink", [{ time: 15, name: "Probe" }, { time: 40, name: "Gateway" }, { time: 100, complete_time: 200, category: "upgrade", name: "BlinkTech" }])?.steps).toEqual([{ supply: null, t: 40, name: "Gateway" }, { supply: null, t: 200, name: "BlinkTech" }]);
  });
});
