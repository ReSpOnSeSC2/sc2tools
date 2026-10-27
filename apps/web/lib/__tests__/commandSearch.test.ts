import { describe, expect, it } from "vitest";
import {
  COMMAND_QUERY_MAX_CHARS, COMMAND_RESULTS_MAX, COMMAND_RESULTS_PER_GROUP, COMMAND_SEARCH_GROUPS,
  commandQueryMatchup, isCommandSearchHref, normalizeCommandQuery, searchCommands,
  type CommandSearchGroupId, type CommandSearchItem,
} from "../commandSearch";

function item(id: string, label: string, extra: Partial<CommandSearchItem> = {}): CommandSearchItem {
  return { id, label, group: "navigation", href: "/app", ...extra };
}

function resultIds(items: readonly CommandSearchItem[], query: string): string[] {
  return searchCommands(items, query).flatMap(group => group.items.map(result => result.id));
}

describe("bounded command query normalization", () => {
  it.each([
    [" Protoss  vs Zerg ", "pvz", "PvZ"], ["Zerg versus Protoss", "zvp", "ZvP"],
    ["P v T", "pvt", "PvT"], ["beat 12 pool PvZ", "beat 12 pool pvz", "PvZ"],
    ["Café\nChrono", "cafe chrono", null],
  ])("normalizes %s without reversing the viewer's matchup", (query, normalized, matchup) => {
    expect(normalizeCommandQuery(query)).toBe(normalized);
    expect(commandQueryMatchup(query)).toBe(matchup);
  });

  it("bounds Unicode code points before scoring and drops the excess suffix", () => {
    const query = "😀".repeat(COMMAND_QUERY_MAX_CHARS) + " private suffix";
    expect(Array.from(normalizeCommandQuery(query))).toHaveLength(COMMAND_QUERY_MAX_CHARS);
    expect(normalizeCommandQuery(query)).not.toContain("private");
    expect(Array.from(normalizeCommandQuery("ﬃ".repeat(80)))).toHaveLength(COMMAND_QUERY_MAX_CHARS);
  });
});

describe("deterministic local command scoring", () => {
  it("ranks exact labels, exact aliases and prefixes ahead of description-only matches", () => {
    const candidates = [
      item("description", "Other", { description: "Open Devices" }),
      item("prefix", "Devices and pairing"), item("exact", "Devices"),
      item("alias", "Linked PCs", { terms: ["devices"] }),
    ];
    expect(resultIds(candidates, "devices")).toEqual(["exact", "alias", "prefix", "description"]);
  });

  it("uses stable label and ID ties regardless of candidate input order", () => {
    const candidates = [item("z", "Alpha"), item("b", "Beta"), item("a", "Alpha")];
    expect(resultIds(candidates, "")).toEqual(["a", "z", "b"]);
    expect(resultIds([...candidates].reverse(), "")).toEqual(["a", "z", "b"]);
    expect(candidates.map(candidate => candidate.id)).toEqual(["z", "b", "a"]);
  });

  it("requires every retained query token and preserves single-digit build distinctions", () => {
    const candidates = [item("eight", "8 Pool"), item("twelve", "12 Pool"), item("robo", "Robo opener")];
    expect(resultIds(candidates, "8pool")).toEqual(["eight"]);
    expect(resultIds(candidates, "12 pool")).toEqual(["twelve"]);
    expect(resultIds(candidates, "12 pool robo")).toEqual([]);
    expect(resultIds(candidates, ".*+[x]")).toEqual([]);
  });

  it("matches spacing aliases while retaining disabled results for an unavailable guide", () => {
    const candidate = item("counter", "12 Pool", {
      group: "guide-counters", matchup: "PvZ", terms: ["PvZ", "how to beat"],
      href: undefined, disabled: true, description: "Not enough games yet",
    });
    const groups = searchCommands([candidate], "how to beat12pool pvz");
    expect(groups).toEqual([{ id: "guide-counters", label: "How to beat", items: [candidate] }]);
    expect(groups[0].items[0].href).toBeUndefined();
  });

  it("filters explicit guide matchup scope without excluding unrelated static matches", () => {
    const candidates = [
      item("pvz", "Pool", { group: "guide-counters", matchup: "PvZ", terms: ["PvZ"] }),
      item("zvp", "PvZ opponent build", { group: "guide-counters", matchup: "ZvP", terms: ["ZvP"] }),
      item("definition", "PvZ definition", { group: "definitions" }),
    ];
    expect(resultIds(candidates, "protoss vs zerg")).toEqual(["definition", "pvz"]);
    expect(resultIds(candidates, "zvp")).toEqual(["zvp"]);
  });
});

describe("bounded command grouping", () => {
  it("deduplicates stable IDs, keeps Recent empty-query only, and honors requested groups", () => {
    const candidates = [item("same", "Devices"), item("same", "Duplicate"),
      item("recent", "Devices", { group: "recent" }), item("help", "Devices", { group: "help" })];
    expect(resultIds(candidates, "devices")).toEqual(["same", "help"]);
    expect(resultIds(candidates, "")).toEqual(["recent", "same", "help"]);
    expect(searchCommands(candidates, "devices", ["help"]).map(group => group.id)).toEqual(["help"]);
  });

  it("caps every group and the total independently", () => {
    const candidates = COMMAND_SEARCH_GROUPS.flatMap(group => Array.from({ length: 12 }, (_, index) =>
      item(`${group.id}:${index}`, `Entry ${index}`, { group: group.id })));
    const groups = searchCommands(candidates, "");
    expect(groups.flatMap(group => group.items)).toHaveLength(COMMAND_RESULTS_MAX);
    for (const group of groups) expect(group.items.length).toBeLessThanOrEqual(COMMAND_RESULTS_PER_GROUP);
    expect(searchCommands(candidates, "", ["guide-maps"]).flatMap(group => group.items)).toHaveLength(8);
  });

  it("uses the finite group order even when a caller reverses its scope list", () => {
    const candidates = [item("help", "Test", { group: "help" }), item("nav", "Test")];
    const scope: CommandSearchGroupId[] = ["help", "navigation"];
    expect(searchCommands(candidates, "test", scope).map(group => group.id)).toEqual(["navigation", "help"]);
  });
});

describe("fixed internal command destinations", () => {
  it.each(["https://foreign.test", "//foreign.test", "javascript:alert(1)", "/\\foreign", "/bad\npath"])(
    "rejects %s before returning a result", href => {
      expect(isCommandSearchHref(href)).toBe(false);
      expect(searchCommands([item("unsafe", "Unsafe", { href })], "")).toEqual([]);
    },
  );

  it.each(["/app", "/settings?tab=chat#tts", "/definitions#pvp-1-gate-expand"])(
    "retains admitted destination %s", href => expect(isCommandSearchHref(href)).toBe(true),
  );
});
