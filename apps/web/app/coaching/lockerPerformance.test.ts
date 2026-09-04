import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const templatePath = resolve(process.cwd(), "../../coaching/locker_app_template.html");
const generatedPath = resolve(process.cwd(), "public/coaching/locker-site.html");
const template = readFileSync(templatePath, "utf8");

const performanceStart = template.indexOf(
  "/* ----- selected-student performance (live, read-only, never persisted) ----- */",
);
const performanceEnd = template.indexOf("function adminModal()", performanceStart);
const performanceBlock = template.slice(performanceStart, performanceEnd);

type PerformanceHarness = {
  PERF_SCOPE: { preset: string; cA: string; cB: string };
  PERF_SEASON_CATALOG: {
    status: string;
    items: Array<{
      number: number;
      battlenetId: number;
      start: string | null;
      end: string | null;
      isCurrent: boolean;
      approx: boolean;
    }>;
  };
  perfRollUpSeasons: (
    rows: Array<{
      battlenetId: number;
      start: string | null;
      end: string | null;
    }>,
  ) => PerformanceHarness["PERF_SEASON_CATALOG"]["items"];
  performancePresets: () => Array<{ id: string; l: string }>;
  perfScopeConfig: () => { since: Date | null; until: Date | null; tz: string };
  perfMmrMark: (value: unknown) => number | null;
};

function makeHarness(): PerformanceHarness {
  return new Function(`
    const CUR_SEASON=68,SITE=null;
    function seasonRangeJS(number){return ["2026-01-01","2026-03-31"]}
    function presetRange(){return [null,null]}
    function siteApi(){return Promise.reject(new Error("not used"))}
    function render(){}
    function toast(){}
    function byId(){return null}
    function esc(value){return String(value??"")}
    function $(id){return null}
    const document={addEventListener(){},body:{style:{overflow:""}}};
    let tab="focus",curStudent=null;
    ${performanceBlock}
    return {PERF_SCOPE,PERF_SEASON_CATALOG,perfRollUpSeasons,performancePresets,perfScopeConfig,perfMmrMark};
  `)() as PerformanceHarness;
}

describe("Coaching Locker student performance", () => {
  it("uses the roster student id, full ISO instants, timezone, and ephemeral request state", () => {
    expect(performanceBlock).toContain(
      '"/coaching/students/"+encodeURIComponent(st.id)+"/performance?"',
    );
    expect(performanceBlock).not.toContain(
      'encodeURIComponent(st.userId)+"/performance?"',
    );
    expect(performanceBlock).toContain('q.set("since",scope.since.toISOString())');
    expect(performanceBlock).toContain('q.set("until",scope.until.toISOString())');
    expect(performanceBlock).toContain('q.set("tz",scope.tz)');
    expect(performanceBlock).toContain("const PERF_CACHE=new Map()");
    expect(performanceBlock).toContain("current.requestId!==requestId");
    expect(performanceBlock).not.toMatch(/\bS\.|\bpersist\(/);
  });

  it("awaits the authoritative live season catalog before building its first request", () => {
    const ensureStart = performanceBlock.indexOf("async function ensurePerformance(st,force)");
    const ensureEnd = performanceBlock.indexOf("function perfRetry", ensureStart);
    const ensureBlock = performanceBlock.slice(ensureStart, ensureEnd);

    expect(performanceBlock).toContain('siteApi("/seasons")');
    expect(performanceBlock).toContain("row&&row.battlenetId");
    expect(ensureBlock.indexOf("await ensurePerformanceSeasons()"))
      .toBeLessThan(ensureBlock.indexOf("perfRequestFor(st)"));
    expect(performanceBlock).toContain('PERF_SEASON_CATALOG.status="fallback"');
  });

  it("rolls regional rows into newest-first global seasons with authoritative bounds", () => {
    const h = makeHarness();
    const seasons = h.perfRollUpSeasons([
      {
        battlenetId: 70,
        start: "2026-07-02T00:00:00.000Z",
        end: "2026-10-01T00:00:00.000Z",
      },
      {
        battlenetId: 69,
        start: "2026-04-01T00:00:00.000Z",
        end: "2026-07-01T23:59:59.999Z",
      },
      {
        battlenetId: 70,
        start: "2026-07-01T05:00:00.000Z",
        end: "2026-10-02T04:59:59.999Z",
      },
    ]);

    expect(seasons.map((season) => season.number)).toEqual([70, 69]);
    expect(seasons[0]).toMatchObject({
      battlenetId: 70,
      start: "2026-07-01T05:00:00.000Z",
      end: "2026-10-02T04:59:59.999Z",
      isCurrent: true,
    });
    expect(seasons[1].isCurrent).toBe(false);
  });

  it("clamps the current season to now and exposes seven recent seasons", () => {
    const h = makeHarness();
    h.PERF_SEASON_CATALOG.status = "ready";
    h.PERF_SEASON_CATALOG.items = Array.from({ length: 10 }, (_, index) => ({
      number: 80 - index,
      battlenetId: 80 - index,
      start: `202${6 - Math.floor(index / 4)}-01-01T00:00:00.000Z`,
      end: index === 0 ? "2099-12-31T23:59:59.999Z" : "2026-01-01T00:00:00.000Z",
      isCurrent: index === 0,
      approx: false,
    }));

    const before = Date.now();
    const scope = h.perfScopeConfig();
    const after = Date.now();
    const seasonPresets = h.performancePresets().filter((preset) =>
      preset.id === "current_season" || preset.id.startsWith("season:"),
    );

    expect(scope.since?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(scope.until?.getTime()).toBeGreaterThanOrEqual(before);
    expect(scope.until?.getTime()).toBeLessThanOrEqual(after);
    expect(seasonPresets).toHaveLength(8);
    expect(seasonPresets[0].l).toBe("Season 80 · current");
  });

  it("turns custom through-dates into the user's local end of day", () => {
    const h = makeHarness();
    h.PERF_SCOPE.preset = "custom";
    h.PERF_SCOPE.cA = "2026-08-01";
    h.PERF_SCOPE.cB = "2026-08-24";

    const scope = h.perfScopeConfig();
    expect(scope.since?.getHours()).toBe(0);
    expect(scope.since?.getMinutes()).toBe(0);
    expect(scope.until?.getHours()).toBe(23);
    expect(scope.until?.getMinutes()).toBe(59);
    expect(scope.until?.getSeconds()).toBe(59);
    expect(scope.until?.getMilliseconds()).toBe(999);
  });

  it("renders all nine matchup cells and never turns missing MMR into zero", () => {
    const canonical = ["PvP", "PvT", "PvZ", "ZvP", "ZvT", "ZvZ", "TvP", "TvT", "TvZ"];
    const match = performanceBlock.match(/const PERFORMANCE_MATCHUPS=([^;]+);/);

    expect(match).not.toBeNull();
    expect(JSON.parse(match?.[1] ?? "[]")).toEqual(canonical);
    expect(performanceBlock).toContain("measured!==null&&measured>0?perfNum(row.netMmr):null");
    expect(performanceBlock).toContain('net===null?"Not measured"');
    expect(performanceBlock).toContain("it does not mean the player gained zero MMR");
  });

  it("explains unmatched race records and a capped MMR-series response", () => {
    expect(performanceBlock).toContain("summary.unclassifiedGames");
    expect(performanceBlock).toContain("excluded from matchup cells");
    expect(performanceBlock).toContain("mmr.seriesMeta");
    expect(performanceBlock).toContain("verified ladder series in this window");
  });

  it("reads object-shaped MMR marks returned by the API", () => {
    const h = makeHarness();
    expect(h.perfMmrMark({ bucket: "2026-08-24", mmr: 5123.4 })).toBe(5123);
    expect(h.perfMmrMark(4900)).toBe(4900);
    expect(h.perfMmrMark(null)).toBeNull();
  });

  it("keeps the student disclosure visible and explicit about shared evidence", () => {
    const disclosureStart = template.indexOf("function studentPerformanceDisclosure(st)");
    const disclosureEnd = template.indexOf("function studentHTML", disclosureStart);
    const disclosure = template.slice(disclosureStart, disclosureEnd);

    expect(disclosure).toContain("coachName(st.coachId)");
    expect(disclosure).toContain("synced ranked 1v1 win/loss record");
    expect(disclosure).toContain("verified replay MMR history");
    expect(disclosure).toContain("matchup trends");
    expect(disclosure).toContain("each qualifying ladder or custom 1v1 game");
    expect(disclosure).toContain("download its archived original replay");
    expect(disclosure).toContain("Only games played after an assignment is created can count");
    expect(disclosure).toContain("This access ends immediately if you revoke practice sharing");
  });

  it("keeps the generated production Locker in sync with the reviewed source block", () => {
    const generated = readFileSync(generatedPath, "utf8");
    const generatedStart = generated.indexOf(
      "/* ----- selected-student performance (live, read-only, never persisted) ----- */",
    );
    const generatedEnd = generated.indexOf("function adminModal()", generatedStart);
    const generatedBlock = generated.slice(generatedStart, generatedEnd);

    expect(generatedStart).toBeGreaterThanOrEqual(0);
    expect(generatedBlock.replace(/\r\n/g, "\n")).toBe(
      performanceBlock.replace(/\r\n/g, "\n"),
    );
    expect(generated).not.toMatch(/__[A-Z][A-Z0-9_]*__/);
  });

  it("ships a desktop popover and a mobile bottom sheet", () => {
    expect(template).toContain(".perf-date-panel{position:absolute");
    expect(template).toContain("@media(max-width:540px)");
    expect(template).toContain(".perf-date-panel{position:fixed");
    expect(template).toContain(".perf-date-scrim{display:block;position:fixed");
  });
});
