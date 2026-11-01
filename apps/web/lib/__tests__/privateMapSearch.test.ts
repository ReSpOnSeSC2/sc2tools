import { describe, expect, it } from "vitest";
import { commandPrivateHref } from "../commandSearchActivation";
import {
  PRIVATE_MAP_CATALOG_ROWS, decodePrivateMapCatalog, privateMapChoices, privateMapSearchGroup, type PrivateMapCatalog,
} from "../privateMapSearch";

const row = (name: unknown, total: unknown = 3) => ({ name, wins: 1, losses: 2, total, winRate: 0.33 });
function ready(rows: Array<[string, number]>): PrivateMapCatalog {
  return decodePrivateMapCatalog(rows.map(([name, total]) => row(name, total)));
}
const names = (catalog: PrivateMapCatalog, query: string) => {
  const group = privateMapSearchGroup(catalog, query);
  return group.status === "ready" ? group.items.map(item => item.map) : group.reason;
};

describe("personal map list from GET /v1/maps", () => {
  it("keeps names and game counts only, skipping unnamed rows", () => {
    expect(decodePrivateMapCatalog([row("Alcyone LE", 9), row("Unknown", 40), row(""), row(null), row("Alcyone LE", 4)]))
      .toEqual({ status: "ready", partial: false, rows: [{ map: "Alcyone LE", total: 9 }] });
  });
  it("marks a malformed name or count partial instead of failing", () => {
    const decoded = decodePrivateMapCatalog([row("Alcyone LE", 9), row("Bad\u0007Map"), row("Ruby Rock LE", -1),
      row("Ruby Rock LE", 1.5), row("a".repeat(201)), "not a row"]);
    expect(decoded).toEqual({ status: "ready", partial: true, rows: [{ map: "Alcyone LE", total: 9 }] });
  });
  it("admits at most 2,000 rows and nothing that is not a list", () => {
    expect(decodePrivateMapCatalog(Array.from({ length: PRIVATE_MAP_CATALOG_ROWS + 1 }, (_, index) => row(`Map ${index}`))))
      .toEqual({ status: "unavailable", reason: "source_budget_exceeded" });
    expect(decodePrivateMapCatalog({ group_by_race_played: [] })).toEqual({ status: "unavailable", reason: "invalid_data" });
  });
  it("never runs an accessor", () => {
    const value = { total: 3 }; let read = false;
    Object.defineProperty(value, "name", { enumerable: true, get() { read = true; return "Alcyone LE"; } });
    expect(decodePrivateMapCatalog([value])).toEqual({ status: "ready", partial: false, rows: [] });
    expect(read).toBe(false);
  });
});

describe("personal map search in the browser", () => {
  const catalog = ready([["Alcyone LE", 9], ["2000 Atmospheres LE", 30], ["Amphion LE", 9], ["Abyssal Reef LE", 2],
    ["Éphémère LE", 5], ["[a].* Arena", 1]]);
  it("matches a literal prefix of the whole name, ignoring case", () => {
    expect(names(catalog, "alc")).toEqual(["Alcyone LE"]);
    expect(names(catalog, "ALCYONE LE")).toEqual(["Alcyone LE"]);
    expect(names(catalog, "LE")).toEqual([]);
    expect(names(catalog, "Atmospheres")).toEqual([]);
    expect(names(catalog, "éph")).toEqual(["Éphémère LE"]);
    expect(names(catalog, "eph")).toEqual([]);
    expect(names(catalog, "[a].*")).toEqual(["[a].* Arena"]);
  });
  it("lists most games first, then byte order, at most eight", () => {
    expect(names(catalog, "a")).toEqual(["Alcyone LE", "Amphion LE", "Abyssal Reef LE"]);
    const many = ready(Array.from({ length: 10 }, (_, index) => [`Map ${index}`, index] as [string, number]));
    const group = privateMapSearchGroup(many, "map");
    expect(group).toMatchObject({ status: "ready", hasMore: true });
    expect(group.items.map(item => item.map)).toEqual(["Map 9", "Map 8", "Map 7", "Map 6", "Map 5", "Map 4", "Map 3", "Map 2"]);
  });
  it("passes an unavailable list through and links rows to the focused Maps page", () => {
    expect(names(decodePrivateMapCatalog("x"), "alc")).toBe("invalid_data");
    const [choice] = privateMapChoices(privateMapSearchGroup(catalog, "alc"));
    expect(choice).toEqual({ group: "maps", label: "Alcyone LE", target: { kind: "map", map: "Alcyone LE" },
      href: "/app/maps?focus=Alcyone%20LE" });
    expect(commandPrivateHref(choice.target)).toBe(choice.href);
  });
});
