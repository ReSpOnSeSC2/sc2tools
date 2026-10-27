import { expect, it } from "vitest";
import { filtersFromViewQuery } from "@/components/AnalyzerProvider";
import { viewFiltersFromQuery } from "../analyzerViews";
import { changeSessionQuery, refreshSessionQuery, sessionCurrentApi, sessionDetailApi, sessionDetailHref, sessionDetailQuery, sessionHistoryHref, sessionListApi, sessionListQuery, sessionScopeIsSynced, sessionScopeQuery, sessionTransportError } from "../sessionHistoryUrls";

const filters = { preset: "custom", since: "2026-10-01T00:00:00.000Z", until: "2026-10-28T00:00:00.000Z", map_pool: "all", game_size: "all", exclude_too_short: false, patch_era: "before", accounts: "1-S2-1-12,2-S2-1-13", regions: "NA,EU", race: "P" } as const;
const queryOf = (href: string) => new URL(href, "https://sc2tools.invalid").searchParams;

it("freezes membership bounds and explicit All/false facets through Frame hydration without using output day as since", () => {
  const href = sessionHistoryHref(filters, { day: "2026-11-01", tz: "America/New_York" });
  const query = queryOf(href);
  expect(query.get("since")).toBe(filters.since);
  expect(query.get("day")).toBe("2026-11-01");
  expect(query.get("preset")).toBe("custom");
  expect(query.get("map_pool")).toBe("all");
  expect(query.get("game_size")).toBe("all");
  expect(query.get("exclude_too_short")).toBe("false");
  const hydrated = filtersFromViewQuery({ map_pool: "ladder", game_size: "1v1", exclude_too_short: true }, viewFiltersFromQuery(query));
  expect(hydrated).toMatchObject(filters);
  expect(sessionScopeIsSynced(hydrated, query)).toBe(true);
});

it("retains relative patch identity while separately freezing its API predicate and dates", () => {
  const query = sessionScopeQuery({ preset: "after_5_0_17", since: filters.since, map_pool: "all", game_size: "all", exclude_too_short: false });
  expect(query.get("preset")).toBe("after_5_0_17");
  expect(query.get("scopePatch")).toBe("after");
  expect(query.get("scopeSince")).toBe(filters.since);
  expect(sessionListApi(query)).toContain("patch_era=");
});

it("preserves opaque list continuation, output window and timezone independently from membership", () => {
  const source = new URLSearchParams({ windowFrom: "2026-10-01T00:00:00.000Z", windowTo: "2026-10-27T00:00:00.000Z", before: "opaque-next-_", tz: "Pacific/Auckland", contextDays: "3" });
  const query = sessionListQuery(filters, source, "UTC");
  const api = queryOf(sessionListApi(query));
  expect(api.get("before")).toBe("opaque-next-_");
  expect(api.get("windowTo")).toBe(source.get("windowTo"));
  expect(api.get("until")).toBe(filters.until);
  expect(api.get("tz")).toBe("Pacific/Auckland");
  expect(api.has("filters")).toBe(false);
  expect(api.has("preset")).toBe(false);
});

it("never sends membership, output, list cursors or UI parameters to current or current detail", () => {
  const query = new URLSearchParams({ ...Object.fromEntries(sessionScopeQuery(filters)), sessionView: "current", day: "2026-10-27", windowFrom: "old", before: "list-cursor", tz: "UTC", contextDays: "2", gamesLimit: "100", gamesBefore: "detail-cursor" });
  expect([...queryOf(sessionCurrentApi(query)).keys()].sort()).toEqual(["contextDays", "tz"]);
  expect([...queryOf(sessionDetailApi("opaque-id", query)).keys()].sort()).toEqual(["contextDays", "gamesBefore", "gamesLimit", "tz"]);
  expect(sessionDetailQuery(filters, query, "UTC").get("sessionView")).toBe("current");
});

it("keeps descriptor IDs opaque, retains source window in links, and strips output-only parameters from natural detail API", () => {
  const query = sessionListQuery(filters, new URLSearchParams({ day: "2026-10-27", before: "page-2", tz: "UTC" }), "UTC");
  const href = sessionDetailHref("opaque:allowed-by-parent", query);
  expect(href.startsWith("/app/sessions/opaque%3Aallowed-by-parent?")).toBe(true);
  expect(queryOf(href).get("before")).toBe("page-2");
  expect(queryOf(href).get("day")).toBe("2026-10-27");
  const api = queryOf(sessionDetailApi("id", query));
  expect(api.has("day")).toBe(false);
  expect(api.has("before")).toBe(false);
  expect(api.get("accounts")).toBe(filters.accounts);
  expect(api.get("since")).toBe(filters.since);
});

it("retains only the explicit game cursor when generating a next-game link", () => {
  const query = new URLSearchParams({ tz: "UTC", gamesBefore: "game-cursor", gamesLimit: "50" });
  expect(queryOf(sessionDetailHref("id", query)).has("gamesBefore")).toBe(false);
  expect(queryOf(sessionDetailHref("id", query, undefined, true)).get("gamesBefore")).toBe("game-cursor");
});

it("retires both cursors on day, timezone, context or window changes", () => {
  const query = new URLSearchParams({ before: "old-list", gamesBefore: "old-games", tz: "UTC", day: "2026-10-27" });
  const next = changeSessionQuery(query, { day: null, windowFrom: "2026-09-01T00:00:00.000Z", windowTo: "2026-10-01T00:00:00.000Z" });
  expect(next.has("before")).toBe(false); expect(next.has("gamesBefore")).toBe(false);
  expect(next.has("day")).toBe(false); expect(query.has("before")).toBe(true);
});

it.each(["2026-02-30", "2026-99-99", "not-a-day"])("rejects invalid day %s without throwing or silently dropping it", day => {
  expect(sessionTransportError(new URLSearchParams({ day, tz: "UTC" }))).toBe("Choose a valid calendar day.");
});

it("rejects duplicate output settings, invalid zones and conflicting day/window selectors", () => {
  expect(sessionTransportError(new URLSearchParams("tz=UTC&tz=Asia%2FTokyo"))).toBeTruthy();
  expect(sessionTransportError(new URLSearchParams({ tz: "invalid/zone" }))).toBeTruthy();
  expect(sessionTransportError(new URLSearchParams({ day: "2026-10-27", windowFrom: "2026-10-01T00:00:00Z" }))).toBeTruthy();
});

it("refreshes frozen rolling continuations into a new latest window while preserving an explicit historical window", () => {
  const rolling = new URLSearchParams({ sessionRolling: "1", windowFrom: "old-from", windowTo: "old-to", before: "old-before", tz: "UTC" });
  const refreshed = refreshSessionQuery(rolling);
  expect(refreshed.has("before")).toBe(false); expect(refreshed.has("windowFrom")).toBe(false); expect(refreshed.has("windowTo")).toBe(false);
  const historical = new URLSearchParams(rolling); historical.delete("sessionRolling");
  expect(refreshSessionQuery(historical).get("windowFrom")).toBe("old-from");
  expect(sessionListApi(rolling)).not.toContain("sessionRolling");
});

it("preserves duplicate output keys until validation instead of selecting an arbitrary first value", () => {
  const query = sessionListQuery(filters, new URLSearchParams("tz=UTC&tz=Asia%2FTokyo"), "UTC");
  expect(query.getAll("tz")).toHaveLength(2);
  expect(sessionTransportError(query)).toBeTruthy();
});

it("keeps a version-only API scope separate from the relative patch preset used in the shared UI", () => {
  const query = sessionScopeQuery({ preset: "patch_5_0_16", map_pool: "all", game_size: "all", exclude_too_short: false });
  expect(query.get("preset")).toBe("patch_5_0_16"); expect(query.get("scopePatch")).toBe("before");
  const api = queryOf(sessionListApi(query));
  expect(api.has("since")).toBe(false); expect(api.has("until")).toBe(false);
  expect(api.get("patch_era")).toBe("before");
  const hydrated = filtersFromViewQuery({ preset: "current_season", since: "2026-09-01T00:00:00.000Z" }, viewFiltersFromQuery(query));
  expect(hydrated.preset).toBe("patch_5_0_16");
  expect(sessionScopeIsSynced(hydrated, query)).toBe(true);
});
