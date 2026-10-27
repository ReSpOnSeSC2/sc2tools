import { describe, expect, it } from "vitest";
import {
  decodePrivateCommandSearch, privateCommandChoices, privateCommandHref, privateCommandQuery,
  PRIVATE_COMMAND_SEARCH_REASONS, type PrivateCommandTarget,
} from "../privateCommandSearch";

// Verification is parent-owned; the drafting agent does not run this suite.
const AT = "2026-10-27T12:00:00.000Z";
function wire() {
  return { version: 2, groups: {
    opponents: { status: "ready", hasMore: false, items: [
      { pulseId: "own-pulse", displayNameSample: "Literal Rival", race: null as string | null, lastSeen: AT as string | null },
    ] },
    customBuilds: { status: "ready", hasMore: false, items: [
      { slug: "private-build", name: "My build", race: "Protoss" as string | null, vsRace: null as string | null,
        perspective: null as string | null, updatedAt: null as string | null },
    ] },
    maps: { status: "ready", hasMore: false, items: [{ map: "Synthetic LE" }] },
  } };
}

describe("private command input remains literal", () => {
  it("only trims outer whitespace and counts Unicode code points", () => {
    expect(privateCommandQuery("  É  [a].*  ")).toBe("É  [a].*");
    expect(privateCommandQuery("e\u0301")).toBe("e\u0301");
    expect(privateCommandQuery("😀😀")).toBe("😀😀");
    expect(privateCommandQuery("😀")).toBeNull();
    expect(privateCommandQuery("😀".repeat(80))).toBe("😀".repeat(80));
    expect(privateCommandQuery(`${" ".repeat(200)}ab${" ".repeat(200)}`)).toBe("ab");
    expect(privateCommandQuery("a".repeat(81))).toBeNull();
  });
  it.each([null, {}, "", " ", "a", "ab\n", "\tab", "a\u007fb", "a\u0085b", "a\u009fb", "a\ud800b", "a\udfffb"])(
    "rejects invalid/control/unpaired input before trimming %#", value => {
      expect(privateCommandQuery(value)).toBeNull();
    },
  );
});

describe("strict private response v2", () => {
  it("keeps the exact three groups, null recency and server row order", () => {
    const raw = wire();
    raw.groups.opponents.items.push({ pulseId: "older", displayNameSample: "Older", race: "legacy-value", lastSeen: null });
    const result = decodePrivateCommandSearch(raw);
    expect(result).toEqual(raw);
    expect(result.groups.customBuilds.items[0]?.updatedAt).toBeNull();
    expect(Object.isFrozen(result.groups.opponents.items)).toBe(true);
    expect(privateCommandChoices(result).map(choice => choice.label)).toEqual(["Literal Rival", "Older", "My build", "Synthetic LE"]);
  });
  it.each(PRIVATE_COMMAND_SEARCH_REASONS)("retains unavailable/%s without claiming no matches or hasMore", reason => {
    const raw = wire();
    const result = decodePrivateCommandSearch({ ...raw, groups: { ...raw.groups,
      maps: { status: "unavailable", items: [], hasMore: null, reason } } });
    expect(result.groups.maps).toEqual({ status: "unavailable", items: [], hasMore: null, reason });
    expect(privateCommandChoices(result).map(choice => choice.group)).toEqual(["opponents", "customBuilds"]);
  });
  it("accepts hasMore only with eight visible rows, without clipping or inventing a ninth", () => {
    const raw = wire(); raw.groups.opponents.hasMore = true;
    raw.groups.opponents.items = Array.from({ length: 8 }, (_, index) => ({
      pulseId: `pulse-${index}`, displayNameSample: `Rival ${index}`, race: null, lastSeen: AT,
    }));
    expect(decodePrivateCommandSearch(raw).groups.opponents.items).toHaveLength(8);
    raw.groups.opponents.items.pop(); expect(() => decodePrivateCommandSearch(raw)).toThrow();
    raw.groups.opponents.hasMore = false;
    raw.groups.opponents.items = Array.from({ length: 9 }, (_, index) => ({
      pulseId: `pulse-${index}`, displayNameSample: `Rival ${index}`, race: null, lastSeen: AT,
    }));
    expect(() => decodePrivateCommandSearch(raw)).toThrow();
  });
  it("rejects unknown root/group/row fields rather than discarding private payloads", () => {
    const raw = wire();
    for (const value of [
      { ...raw, version: 1 }, { ...raw, q: "private query" }, { ...raw, groups: { ...raw.groups, other: {} } },
      { ...raw, groups: { ...raw.groups, maps: { ...raw.groups.maps, total: 5 } } },
      { ...raw, groups: { ...raw.groups, opponents: { ...raw.groups.opponents,
        items: [{ ...raw.groups.opponents.items[0], href: "https://foreign.test" }] } } },
    ]) expect(() => decodePrivateCommandSearch(value)).toThrow();
  });
  it.each([
    { status: "unavailable", reason: "unknown", items: [], hasMore: null },
    { status: "unavailable", reason: "deadline", items: [], hasMore: false },
    { status: "unavailable", reason: "deadline", items: [{ map: "partial" }], hasMore: null },
    { status: "ready", items: [], hasMore: null },
  ])("rejects malformed group status %#", maps => {
    const raw = wire(); expect(() => decodePrivateCommandSearch({ ...raw, groups: { ...raw.groups, maps } })).toThrow();
  });
  it.each(["a\u0000b", "a\u0085b", "a\u009fb", "a\ud800b", "a\udfffb", "a".repeat(201)])(
    "rejects controls, unpaired surrogates and UTF-16 label overflow %#", label => {
      const raw = wire(); raw.groups.opponents.items[0].displayNameSample = label;
      expect(() => decodePrivateCommandSearch(raw)).toThrow();
    },
  );
  it("accepts complete astral labels within UTF-16 limits and rejects identifier overflow/dot segments", () => {
    const raw = wire(); raw.groups.opponents.items[0].displayNameSample = "😀".repeat(100);
    expect(decodePrivateCommandSearch(raw).groups.opponents.items[0]?.displayNameSample).toHaveLength(200);
    for (const pulseId of [".", "..", "a".repeat(65), "a\u0085b"]) {
      raw.groups.opponents.items[0].pulseId = pulseId;
      expect(() => decodePrivateCommandSearch(raw)).toThrow();
    }
  });
  it.each(["2026-10-27", "2026-10-27T12:00:00Z", "not a date", "+999999-01-01T00:00:00.000Z"])(
    "requires canonical nullable wire dates, not malformed source recency %s", date => {
      const raw = wire(); raw.groups.opponents.items[0].lastSeen = date;
      expect(() => decodePrivateCommandSearch(raw)).toThrow();
    },
  );
  it("rejects missing nullable fields, duplicate IDs, null-before-dated and reversed stable ties", () => {
    const raw = wire(), first = raw.groups.opponents.items[0];
    const missing = { pulseId: first.pulseId, displayNameSample: first.displayNameSample, race: null };
    expect(() => decodePrivateCommandSearch({ ...raw, groups: { ...raw.groups,
      opponents: { ...raw.groups.opponents, items: [missing] } } })).toThrow();
    for (const items of [[first, first], [{ ...first, lastSeen: null }, { ...first, pulseId: "z" }],
      [{ ...first, pulseId: "z" }, { ...first, pulseId: "a" }]]) {
      expect(() => decodePrivateCommandSearch({ ...raw, groups: { ...raw.groups,
        opponents: { ...raw.groups.opponents, items } } })).toThrow();
    }
  });
  it("uses UTF-8/simple-collation tie admission without reranking astral names", () => {
    const raw = wire(); raw.groups.maps.items = [{ map: "\ue000" }, { map: "😀" }];
    expect(decodePrivateCommandSearch(raw).groups.maps.items).toEqual(raw.groups.maps.items);
    raw.groups.maps.items.reverse(); expect(() => decodePrivateCommandSearch(raw)).toThrow();
  });
  it("rejects sparse arrays, symbols, prototype instances and accessors without invoking them", () => {
    const raw = wire(), getter = { read: false };
    const accessor = Object.defineProperty({}, "version", { enumerable: true, get() { getter.read = true; return 2; } });
    Object.defineProperty(accessor, "groups", { enumerable: true, value: raw.groups });
    const symbolic = { ...raw, [Symbol("unexpected")]: true };
    const sparse = Array(1);
    for (const value of [accessor, symbolic, Object.assign(Object.create({}), raw),
      { ...raw, groups: { ...raw.groups, maps: { status: "ready", hasMore: false, items: sparse } } }]) {
      expect(() => decodePrivateCommandSearch(value)).toThrow();
    }
    expect(getter.read).toBe(false);
  });
});

describe("private destinations are typed data, never server hrefs", () => {
  it("encodes complete identifiers and exact map focus into only the three admitted destinations", () => {
    expect(privateCommandHref({ kind: "opponent", pulseId: "own/id?#%" })).toBe("/app/opponents/own%2Fid%3F%23%25");
    expect(privateCommandHref({ kind: "customBuild", slug: "My build/é" })).toBe("/builds/My%20build%2F%C3%A9");
    expect(privateCommandHref({ kind: "map", map: "Map & 😀 LE" })).toBe("/app/maps?focus=Map%20%26%20%F0%9F%98%80%20LE");
  });
  it.each([
    { kind: "opponent", pulseId: ".." }, { kind: "customBuild", slug: "." },
    { kind: "opponent", pulseId: "safe", href: "/settings" }, { kind: "href", href: "https://foreign.test" },
    { kind: "map", map: "bad\u0085name" },
  ])("rejects unknown destinations and extra navigation fields %#", value => {
    expect(() => privateCommandHref(value as PrivateCommandTarget)).toThrow();
  });
});
