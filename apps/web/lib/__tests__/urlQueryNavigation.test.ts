import { describe, expect, it } from "vitest";
import { queryLocation, UrlQueryNavigation } from "../urlQueryNavigation";
const patch = (values: Record<string, string | null>) => (params: URLSearchParams) => {
  for (const [key, value] of Object.entries(values)) if (value === null) params.delete(key); else params.set(key, value);
  return params;
};
describe("shared URL query navigation", () => {
  it("composes section and global changes while router acknowledgements are held", () => {
    const nav = new UrlQueryNavigation(), initial = queryLocation("/app/replays", "filters=1&race=P&cursor=older"); nav.observe(initial);
    const first = nav.prepare(patch({ q: "3 gate", cursor: null }), initial)!;
    const second = nav.prepare(patch({ race: "Z" }), initial)!;
    expect(new URL(second, "https://fixture.test").searchParams.get("q")).toBe("3 gate");
    expect(second).not.toContain("cursor");
    nav.observe(queryLocation("/app/replays", first.split("?")[1]));
    const third = nav.prepare(patch({ result: "loss" }), queryLocation("/app/replays", first.split("?")[1]))!;
    expect(new URL(third, "https://fixture.test").searchParams.get("race")).toBe("Z");
    expect(new URL(third, "https://fixture.test").searchParams.get("q")).toBe("3 gate");
  });
  it("fences a queued search across Back, including A→B→A URLs", () => {
    const nav = new UrlQueryNavigation(), a = queryLocation("/app/opponents", "q=A"), b = queryLocation("/app/opponents", "q=B");
    nav.observe(a); const guard = nav.guard(a); nav.prepare(patch({ q: "typed later" }), a);
    nav.reset(b); nav.reset(a);
    expect(nav.prepare(patch({ q: "stale timer" }), a, guard)).toBeNull();
    expect(nav.params.get("q")).toBe("A");
  });
  it("checks the browser boundary before a delayed router notification", () => {
    const nav = new UrlQueryNavigation(), initial = queryLocation("/app/builds", "q=old"); nav.observe(initial); const guard = nav.guard(initial);
    const incoming = queryLocation("/app/builds", "q=shared");
    expect(nav.prepare(patch({ q: "old draft" }), incoming, guard)).toBeNull();
    expect(nav.prepare(patch({ sort: "total:desc" }), incoming)).toContain("q=shared");
  });
  it("bounds pending addresses and preserves unrelated keys", () => {
    const nav = new UrlQueryNavigation(), initial = queryLocation("/app/strategies", "accounts=1-S2-1-2&filters=1"); nav.observe(initial);
    for (let i = 0; i < 30; i++) nav.prepare(patch({ drill: `strategy:${i}` }), initial);
    expect(nav.pending.size).toBeLessThanOrEqual(16); expect(nav.params.get("accounts")).toBe("1-S2-1-2");
    expect(nav.prepare(patch({ drill: nav.params.get("drill") }), initial)).toBeNull();
  });
});
