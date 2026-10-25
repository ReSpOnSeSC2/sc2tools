import { describe, expect, it } from "vitest";
import { accountFilter, accountHandles, accountLabel, gameAccounts } from "../accountFilter";
import { filtersToQuery, describeActiveFilters } from "../filterContext";
import { sanitizeAnalyzerViews, sanitizeViewFilters, viewFiltersFromQuery, viewFiltersQuery, replaceViewQuery } from "../analyzerViews";
import { gameSourceFilters } from "../gameSourceFilters";

const cohort = Array.from({ length: 20 }, (_, n) => `2-S2-1-${10000000000000000000n + BigInt(n)}`).join(",");
describe("literal account cohorts", () => {
  it("canonicalizes exact handles and retains all20 beyond the old256-character filter bound", () => {
    expect(accountHandles(" 2-s2-1-20,1-S2-1-10,2-S2-1-20 ")).toEqual(["1-S2-1-10", "2-S2-1-20"]);
    expect(cohort.length).toBeGreaterThan(256);
    const query = new URLSearchParams(filtersToQuery({ accounts: cohort }));
    expect(accountHandles(query.get("accounts"))).toHaveLength(20);
    expect(viewFiltersFromQuery(viewFiltersQuery({ accounts: cohort })).filters.accounts).toBe(accountFilter(cohort));
    expect(accountHandles(new URLSearchParams(gameSourceFilters(`accounts=${cohort}`)).get("accounts"))).toHaveLength(20);
  });
  it.each([".*", "1-S2-1-1,", "1-S2-1-1,anything", ["1-S2-1-1", null], [], Array(21).fill("1-S2-1-1"), "1-S2-1-" + "1".repeat(21), "1-S2-1-1\n2-S2-1-2"])("rejects a whole malformed selection without broadening: %j", raw => {
    expect(() => accountHandles(raw)).toThrow();
    expect(() => sanitizeViewFilters({ accounts: raw })).toThrow();
    if (typeof raw === "string") expect(() => accountHandles(new URLSearchParams(gameSourceFilters(new URLSearchParams({ accounts: raw }).toString())).get("accounts"))).toThrow();
  });
  it("round-trips full snapshot/partial/default view account scope and an explicit clear", () => {
    const filters = { preset: "all" as const, accounts: "2-s2-1-2,1-S2-1-1", race: "P" };
    const query = viewFiltersQuery(filters);
    expect(viewFiltersFromQuery(query)).toMatchObject({ snapshot: true, filters: { accounts: "1-S2-1-1,2-S2-1-2" } });
    expect(viewFiltersFromQuery(new URLSearchParams("accounts="))).toMatchObject({ present: true, keys: ["accounts"], filters: {} });
    expect(new URLSearchParams(replaceViewQuery("accounts=1-S2-1-1&q=Rival", { preset: "all" })).has("accounts")).toBe(false);
    expect(sanitizeAnalyzerViews({ views: [{ id: "mine", name: "Main", filters }], defaultViewId: "mine" })).toMatchObject({ defaultViewId: "mine", views: [{ filters: { accounts: "1-S2-1-1,2-S2-1-2" } }] });
    expect(viewFiltersFromQuery(new URLSearchParams("accounts=not-a-toon")).error).toContain("account handles");
    expect(viewFiltersFromQuery(new URLSearchParams("accounts=1-S2-1-1&accounts=2-S2-1-2")).error).toBeTruthy();
    expect(() => accountHandles(new URLSearchParams(gameSourceFilters("accounts=1-S2-1-1&accounts=2-S2-1-2")).get("accounts"))).toThrow();
    expect(sanitizeAnalyzerViews({ views: [{ id: "bad", name: "Bad", filters: { accounts: ".*" } }], defaultViewId: "bad" })).toEqual({ views: [], defaultViewId: null });
  });
  it("retains a clearable literal Accounts chip and labels stay best effort", () => {
    expect(describeActiveFilters({ accounts: "1-S2-1-1" })).toContainEqual(expect.objectContaining({ key: "accounts", value: "1-S2-1-1", clearPatch: { accounts: undefined } }));
    const rows = gameAccounts([{ handle: "2-s2-1-2", label: "Main", region: "EU", leagueId: 5, mmr: 4800 }, { handle: "1-S2-1-1", label: "\n", leagueId: 99 }, { handle: ".*", label: "invalid" }]);
    expect(rows).toHaveLength(2); expect(accountLabel(rows[0])).toBe("Main · EU · Master");
    expect(accountLabel(rows[1])).toBe("1-S2-1-1"); expect(accountFilter(undefined)).toBeUndefined();
  });
});
