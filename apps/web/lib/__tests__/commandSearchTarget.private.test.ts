import { describe, expect, it } from "vitest";
import { commandPrivateHref } from "../commandSearchActivation";
import { privateCommandHref, type PrivateCommandTarget } from "../privateCommandSearch";

describe("deferred private activation matches the typed transport constructor", () => {
  it.each<PrivateCommandTarget>([
    { kind: "opponent", pulseId: "1-S2-1-own" }, { kind: "opponent", pulseId: "own/id?#%😀" },
    { kind: "customBuild", slug: "My build/é" }, { kind: "map", map: "Map & 😀 LE" },
    { kind: "map", map: "😀".repeat(100) }, { kind: "game", gameId: "2026-10-01|Rival|Alcyone LE|612" },
    { kind: "game", gameId: "g".repeat(200) },
  ])("derives exactly the same safe destination %#", target => {
    expect(commandPrivateHref(target)).toBe(privateCommandHref(target));
  });
  it.each([
    null, [], { kind: "opponent", pulseId: ".." }, { kind: "customBuild", slug: "." },
    { kind: "opponent", pulseId: "a".repeat(65) }, { kind: "customBuild", slug: "a".repeat(121) },
    { kind: "map", map: "a".repeat(201) }, { kind: "map", map: "a\u0085b" }, { kind: "map", map: "a\ud800b" },
    { kind: "href", href: "/settings" }, { kind: "opponent", pulseId: "safe", href: "/settings" },
    { kind: "game", gameId: ".." }, { kind: "game", gameId: "g".repeat(201) }, { kind: "game", gameId: "a\u0000b" },
    { kind: "game", pulseId: "1-S2-1-own" }, { kind: "toString", map: "Map" }, { kind: "__proto__", map: "Map" },
  ])("fails closed on an unknown/extra/malformed target %#", target => {
    expect(commandPrivateHref(target)).toBeNull();
  });
  it("does not invoke a target accessor or coerce a foreign prototype", () => {
    const read = { called: false }, value = { kind: "map" };
    Object.defineProperty(value, "map", { enumerable: true, get() { read.called = true; return "Map"; } });
    expect(commandPrivateHref(value)).toBeNull(); expect(read.called).toBe(false);
    expect(commandPrivateHref(Object.assign(Object.create({}), { kind: "map", map: "Map" }))).toBeNull();
  });
});
