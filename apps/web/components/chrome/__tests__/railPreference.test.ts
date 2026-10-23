import vm from "node:vm";
import { expect, it } from "vitest";
import { RAIL_BOOTSTRAP } from "../railPreference";
it.each([
  [null, true, false, "pinned"], [null, false, true, "pinned"], [null, false, false, "collapsed"],
  ["collapsed", true, true, "collapsed"], ["pinned", false, false, "pinned"],
])("sets the pre-paint rail attribute for saved=%s wide=%s touch=%s", (saved, wide, touch, expected) => {
  const attributes: Record<string, string> = {};
  vm.runInNewContext(RAIL_BOOTSTRAP, { document: { documentElement: { setAttribute: (key: string, value: string) => { attributes[key] = value; } } }, localStorage: { getItem: () => saved }, matchMedia: (query: string) => ({ matches: query.includes("1536") ? wide : touch }) });
  expect(attributes["data-rail"]).toBe(expected);
});
it("uses the touch default when reading storage throws before paint", () => {
  const attributes: Record<string, string> = {};
  vm.runInNewContext(RAIL_BOOTSTRAP, { document: { documentElement: { setAttribute: (key: string, value: string) => { attributes[key] = value; } } }, localStorage: { getItem: () => { throw new Error("private"); } }, matchMedia: () => ({ matches: true }) });
  expect(attributes["data-rail"]).toBe("pinned");
});
