import { afterEach, expect, it, vi } from "vitest";
import { filtersFromViewQuery } from "@/components/AnalyzerProvider";
import { viewFiltersFromQuery } from "../analyzerViews";
import { changeSessionQuery, refreshSessionQuery, sessionDetailApi, sessionDetailHref,
  sessionDetailQuery, sessionHistoryHref, sessionListApi, sessionListQuery, sessionScopeQuery,
  sessionTransportError, sessionViewIsAutomaticSameCohort } from "../sessionHistoryUrls";
import type { AnalyzerFilters } from "../filterContext";
import type { LogicalSeason } from "../useSeasons";

const since = "2026-07-19T00:00:00.000Z", until = "2026-10-27T23:59:59.999Z";
const automatic: AnalyzerFilters = { preset: "current_season", since, until, race: "P",
  accounts: "1-S2-1-12345", map_pool: "all", game_size: "all", exclude_too_short: false };
const seasons: LogicalSeason[] = [{ number: 68, battlenetId: 68, year: 2026, numberInYear: 3,
  start: since, end: until, isCurrent: true }];
const params = (href: string) => new URL(href, "https://sc2tools.invalid").searchParams;
afterEach(() => vi.useRealTimers());

it("retains semantic Auto in generated history links while separately freezing versioned membership", () => {
  vi.useFakeTimers(); vi.setSystemTime("2026-10-27T12:00:00.000Z");
  const query = params(sessionHistoryHref(automatic, { tz: "America/New_York" }));
  expect(query.get("preset")).toBe("current_season");
  expect(query.get("sessionScope")).toBe("1");
  expect(query.get("scopeSince")).toBe(since); expect(query.get("scopeUntil")).toBe(until);
  expect(query.has("since")).toBe(false); expect(query.has("until")).toBe(false);
  expect(query.get("map_pool")).toBe("all"); expect(query.get("game_size")).toBe("all");
  expect(query.get("exclude_too_short")).toBe("false");
  const hydrated = filtersFromViewQuery({}, viewFiltersFromQuery(query), seasons);
  expect(hydrated).toMatchObject({ ...automatic, until: "2026-10-27T12:00:00.000Z" });
});

it("maps frozen membership to the existing API and strips every semantic/transport-only field", () => {
  const query = sessionScopeQuery(automatic); query.set("tz", "UTC");
  const api = params(sessionListApi(query));
  expect(api.get("since")).toBe(since); expect(api.get("until")).toBe(until);
  expect(api.get("accounts")).toBe("1-S2-1-12345");
  for (const key of ["preset", "filters", "sessionScope", "scopeSince", "scopeUntil", "scopePatch"]) {
    expect(api.has(key)).toBe(false);
  }
});

it("preserves frozen Auto membership through a fixed continuation and an opaque report link", () => {
  const query = sessionScopeQuery(automatic);
  query.set("before", "opaque-list-page"); query.set("tz", "UTC");
  query.set("windowFrom", "2026-10-01T00:00:00.000Z");
  query.set("windowTo", "2026-10-28T00:00:00.000Z"); query.set("sessionRolling", "1");
  const newerFilters = { ...automatic, since: "2026-10-28T00:00:00.000Z", until: undefined };
  const next = sessionListQuery(newerFilters, query, "UTC");
  expect(next.get("preset")).toBe("current_season");
  expect(next.get("scopeSince")).toBe(since); expect(next.get("scopeUntil")).toBe(until);
  const href = sessionDetailHref("opaque:session-id", next);
  expect(href).toContain("opaque%3Asession-id");
  const detail = sessionDetailQuery(newerFilters, params(href), "UTC");
  const api = params(sessionDetailApi("opaque:session-id", detail));
  expect(api.get("since")).toBe(since); expect(api.get("until")).toBe(until);
  expect(detail.get("preset")).toBe("current_season");
  expect(api.has("windowFrom")).toBe(false); expect(api.has("before")).toBe(false);
});

it("keeps output day independent of global dates and retires only continuation cursors", () => {
  const query = sessionScopeQuery(automatic); query.set("before", "old"); query.set("gamesBefore", "old-games");
  const changed = changeSessionQuery(query, { day: "2026-10-20", tz: "Pacific/Auckland" });
  expect(changed.get("preset")).toBe("current_season"); expect(changed.get("scopeSince")).toBe(since);
  expect(changed.get("day")).toBe("2026-10-20"); expect(changed.has("before")).toBe(false);
  expect(changed.has("gamesBefore")).toBe(false);
});

it("retains patch identity with frozen dates instead of promoting the whole analyzer to custom", () => {
  const query = sessionScopeQuery({ ...automatic, preset: "after_5_0_17", since: "2026-09-30T04:00:00.000Z" });
  expect(query.get("preset")).toBe("after_5_0_17"); expect(query.get("scopePatch")).toBe("after");
  const api = params(sessionListApi(query));
  expect(api.get("patch_era")).toBe("after"); expect(api.has("scopePatch")).toBe(false);
});

it("preserves genuine custom and pinned-season semantic intent rather than resetting to Auto", () => {
  const custom = { ...automatic, preset: "custom" as const };
  const customQuery = sessionScopeQuery(custom);
  expect(customQuery.get("preset")).toBe("custom");
  expect(filtersFromViewQuery({}, viewFiltersFromQuery(customQuery), seasons)).toMatchObject(custom);
  expect(sessionScopeQuery({ ...automatic, preset: "season:68" }).get("preset")).toBe("season:68");
});

it("refreshes rolling output by dropping stale frozen bounds so the current preset can recapture", () => {
  const query = sessionScopeQuery(automatic); query.set("sessionRolling", "1");
  query.set("windowFrom", since); query.set("windowTo", until); query.set("before", "old");
  const refreshed = refreshSessionQuery(query);
  expect(refreshed.get("preset")).toBe("current_season");
  expect(refreshed.get("sessionScope")).toBe("1");
  for (const key of ["scopeSince", "scopeUntil", "scopePatch", "before", "windowFrom", "windowTo"]) {
    expect(refreshed.has(key)).toBe(false);
  }
});

it.each([
  "sessionScope=2&scopeSince=2026-07-19T00%3A00%3A00.000Z",
  "sessionScope=1&sessionScope=1",
  "sessionScope=1&scopeSince=not-a-date",
  "sessionScope=1&scopeSince=2026-07-19T00%3A00%3A00.000Z&scopeSince=2026-07-20T00%3A00%3A00.000Z",
  "sessionScope=1&scopePatch=unknown",
  "scopeSince=2026-07-19T00%3A00%3A00.000Z",
  "sessionScope=1&scopeUnknown=1",
  "sessionScope=1&scopeRefresh=2",
  "sessionScope=1&scopeRefresh=1&scopeRefresh=1",
  "sessionScope=1&scopeSince=2026-10-28T00%3A00%3A00.000Z&scopeUntil=2026-07-19T00%3A00%3A00.000Z",
])("rejects malformed versioned scope transport without broadening membership: %s", search => {
  expect(sessionTransportError(new URLSearchParams(search))).toBeTruthy();
});

it("limits automatic same-cohort admission to actual Sessions paths", () => {
  const query = sessionScopeQuery(automatic);
  expect(sessionViewIsAutomaticSameCohort("/app/sessions", query, automatic)).toBe(true);
  expect(sessionViewIsAutomaticSameCohort("/app/sessions/opaque", query, automatic)).toBe(true);
  expect(sessionViewIsAutomaticSameCohort("/app", query, automatic)).toBe(false);
  expect(sessionViewIsAutomaticSameCohort("/app/maps", query, automatic)).toBe(false);
});

it("recaptures a bare latest list on season rollover while keeping the semantic Auto choice", () => {
  const source = sessionScopeQuery(automatic);
  const newer = { ...automatic, since: "2026-10-28T00:00:00.000Z", until: undefined };
  const next = sessionListQuery(newer, source, "UTC");
  expect(next.get("preset")).toBe("current_season");
  expect(next.get("scopeSince")).toBe(newer.since); expect(next.has("scopeUntil")).toBe(false);
  expect(params(sessionListApi(next)).get("since")).toBe(newer.since);
});

it("does not invent bounds for a valid frozen unbounded scope", () => {
  const current = { ...automatic, preset: "custom" as const };
  const source = sessionScopeQuery(current);
  source.delete("scopeSince"); source.delete("scopeUntil"); source.set("before", "page-two");
  const api = params(sessionListApi(sessionListQuery(current, source, "UTC")));
  expect(api.has("since")).toBe(false); expect(api.has("until")).toBe(false);
  expect(api.get("before")).toBe("page-two");
});

it("recaptures an explicit output window only after the explicit Refresh signal", () => {
  const source = sessionScopeQuery(automatic);
  source.set("windowFrom", since); source.set("windowTo", until);
  const newer = { ...automatic, since: "2026-10-28T00:00:00.000Z", until: undefined };
  const next = sessionListQuery(newer, refreshSessionQuery(source), "UTC");
  expect(next.get("scopeSince")).toBe(newer.since); expect(next.has("scopeRefresh")).toBe(false);
  expect(next.get("windowFrom")).toBe(since); expect(next.get("windowTo")).toBe(until);
});
