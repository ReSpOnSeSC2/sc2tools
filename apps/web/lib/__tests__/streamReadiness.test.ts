import { describe, expect, it } from "vitest";
import { normalizePresence } from "../overlayPresence";
import { streamReadiness, type ReadinessInputs } from "../streamReadiness";

const now = Date.parse("2026-11-11T10:00:00Z");
const token = { token: "private-token" };
const base: ReadinessInputs = { devices: { data: [] }, tokens: { data: token }, presence: { data: null }, multichat: { data: {} } };
const seen = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

describe("streamReadiness", () => {
  it("distinguishes missing, recently seen and paired devices without a heartbeat", () => {
    expect(streamReadiness(base, now).map(row => row.state)).toEqual(["missing", "missing", "missing", "missing"]);
    const ready = streamReadiness({ ...base, devices: { data: [{ lastSeenAt: seen(2) }, { lastSeenAt: seen(12) }] } }, now);
    expect(ready[0]).toMatchObject({ state: "ok", message: "Seen 2 min ago" });
    const old = streamReadiness({ ...base, devices: { data: [{ lastSeenAt: seen(3 * 1440) }] } }, now);
    expect(old[0]).toMatchObject({ state: "warn", message: "Paired · last seen 3 days ago" });
    expect(streamReadiness({ ...base, devices: { data: [{}] } }, now)[0].state).toBe("warn");
  });

  it("counts dedicated widgets, scenes and all-in-one independently of the Dock and chat", () => {
    const snapshot = normalizePresence({ sampledAt: seen(0), surfaces: { widget: { count: 2 }, scene: { count: 1 }, "all-in-one": { count: 1 }, dock: { count: 1 } } });
    const checks = streamReadiness({ ...base, presence: { data: snapshot }, multichat: { data: { youtube: { enabled: true }, twitch: { enabled: false } } } }, now);
    expect(checks.slice(1).map(row => [row.state, row.message])).toEqual([["ok", "4 connected"], ["ok", "1 platform enabled"], ["ok", "1 connected"]]);
    const prior = streamReadiness({ ...base, tokens: { data: { ...token, lastSeenAt: seen(5) } } }, now);
    expect(prior[1]).toMatchObject({ state: "warn", message: "Last seen 5 min ago" });
  });

  it("keeps unknown network status separate from missing setup", () => {
    const rows = streamReadiness({ ...base, presence: { error: true }, multichat: { loading: true } }, now);
    expect(rows.map(row => row.state)).toEqual(["missing", "error", "loading", "error"]);
    expect(rows[1].message).toBe("Couldn’t check");
  });
});
