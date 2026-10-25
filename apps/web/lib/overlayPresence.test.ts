import { describe, expect, it } from "vitest";
import { normalizePresence, widgetPresence, presenceCount } from "./overlayPresence";
import rules from "./overlayPresenceRules.json";
import { STREAM_BACKGROUND_IDS } from "./streamBackgrounds";
import { VALID_SCENES } from "@/components/overlay/scenes/sceneVariants";
const snapshot = () => normalizePresence({ surfaces: { "all-in-one": { count: 1 }, unknown: { count: 1 } }, widgets: { scouting: { count: 1 }, "ghost-build": { count: 1 } }, scenes: {}, totalSources: 4, agent: { online: true }, sampledAt: new Date().toISOString() })!;
describe("honest overlay source status", () => {
  it("counts enabled all-in-one cards and warns only for multiple audio-capable sources", () => {
    expect(widgetPresence(snapshot(), "scouting", true)).toEqual({ count: 2, audio: true, unknown: false });
    expect(widgetPresence(snapshot(), "scouting", false)).toEqual({ count: 1, audio: false, unknown: false });
    expect(widgetPresence(snapshot(), "session", true)).toEqual({ count: 1, audio: false, unknown: false });
    expect(widgetPresence(snapshot(), "ghost-build", true).count).toBe(1);
  });
  it("keeps unknown legacy connections distinct from not added", () => {
    expect(widgetPresence(snapshot(), "rank", false).unknown).toBe(true);
    const value = snapshot(); value.surfaces.unknown.count = 0;
    expect(widgetPresence(value, "rank", false)).toEqual({ count: 0, audio: false, unknown: false });
  });
  it("bounds malformed data and refuses unrecognized old response shapes", () => {
    expect(normalizePresence({})).toBeNull(); expect(normalizePresence(null)).toBeNull();
    expect(normalizePresence({ sampledAt: "bad", surfaces: {} })).toBeNull();
    for (const bad of [-1, 1.5, Infinity, "2", null, 100001]) expect(presenceCount(bad)).toBe(0);
  });
  it("shares exactly the approved scene route IDs with the API and static catalog", () => {
    expect([...VALID_SCENES].sort()).toEqual([...rules.scenes].sort());
    expect(rules.scenes.filter(id => !["between-games", "starting-soon", "brb", "intermission", "manual"].includes(id)).sort()).toEqual([...STREAM_BACKGROUND_IDS].sort());
  });
});
