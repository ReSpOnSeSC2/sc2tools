import { describe, expect, it } from "vitest";
import { dailyPulseHref } from "../dailyPulseNavigation";
import type { PulseCard } from "../dailyPulse";
const card = (extra: Partial<PulseCard>): PulseCard => ({ id: "test", category: "build", tone: "neutral", kicker: "Insight", title: "Recorded insight", body: "From your replays", ...extra });

describe("Daily Pulse contextual navigation", () => {
  it("preserves a full global snapshot while giving builds their section search", () => {
    const href = dailyPulseHref(card({ targetTab: "builds", targetQuery: { q: "Forge + fast expand" } }), "filters=1&race=P&map=Existing+global+map&accounts=1-S2-1-42");
    const url = new URL(href!, "http://fixture.invalid");
    expect(url.pathname).toBe("/app/builds");
    expect(url.searchParams.get("q")).toBe("Forge + fast expand");
    expect(url.searchParams.get("map")).toBe("Existing global map");
    expect(url.searchParams.get("accounts")).toBe("1-S2-1-42");
    expect(url.searchParams.get("filters")).toBe("1");
  });
  it("uses focus for the map without changing the global map cohort", () => {
    const url = new URL(dailyPulseHref(card({ targetTab: "battlefield", targetQuery: { focus: "Sanctuary III LE" } }), "map=Existing+scope")!, "http://fixture.invalid");
    expect(url.pathname).toBe("/app/maps");
    expect(url.searchParams.get("focus")).toBe("Sanctuary III LE");
    expect(url.searchParams.get("map")).toBe("Existing scope");
  });
  it("opens a known opponent directly with the same filters, including legacy card data", () => {
    expect(dailyPulseHref(card({ targetTab: "opponents", targetQuery: { pulseId: "1-S2-1-42" } }), "filters=1&opp_race=Z")).toBe("/app/opponents/1-S2-1-42?filters=1&opp_race=Z");
    expect(dailyPulseHref(card({ targetTab: "opponents", targetOpponentId: "42/escape" }))).toBe("/app/opponents/42%2Fescape");
    expect(dailyPulseHref(card({ targetTab: "trends" })) ).toBe("/app/trends");
    expect(dailyPulseHref(card({}))).toBeNull();
  });
});
