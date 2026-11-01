import { describe, expect, it } from "vitest";
import { commandActivationPolicy } from "../commandSearchActivation";
import { isPublicSearchHref, parsePublicSearchQuery, publicSearchHref } from "../publicSearchQuery";

describe("public /search query", () => {
  it("trims only outer whitespace and keeps 1-80 code points", () => {
    expect(parsePublicSearchQuery("  12 pool ")).toEqual({ kind: "ok", query: "12 pool" });
    expect(parsePublicSearchQuery("z")).toEqual({ kind: "ok", query: "z" });
    expect(parsePublicSearchQuery("😀".repeat(80))).toEqual({ kind: "ok", query: "😀".repeat(80) });
    expect(parsePublicSearchQuery("😀".repeat(81))).toEqual({ kind: "too_long", prefill: "😀".repeat(80) });
    expect(parsePublicSearchQuery("a".repeat(5_000))).toEqual({ kind: "too_long", prefill: "a".repeat(80) });
  });
  it.each([[undefined], [["a", "b"]], [""], ["   "]])("reads a missing, repeated or blank q as empty %#", raw => {
    expect(parsePublicSearchQuery(raw)).toEqual({ kind: "empty" });
  });
  it.each([["\u0301\u0301"], [" \u0300 "]])("reads a query that folds to nothing as empty, with no page link %#", raw => {
    expect(parsePublicSearchQuery(raw)).toEqual({ kind: "empty" });
    expect(publicSearchHref(raw)).toBeNull();
  });
  it.each([["a\u0000b"], ["tab\tquery"], ["a\ud800b"], [`${"a".repeat(100)}\n`]])("refuses controls and lone surrogates %#", raw => {
    expect(parsePublicSearchQuery(raw)).toEqual({ kind: "invalid" });
  });
  it("builds and re-derives exactly one fixed destination", () => {
    const href = publicSearchHref(" PvZ stargate & 12 pool ");
    expect(href).toBe("/search?q=PvZ%20stargate%20%26%2012%20pool");
    expect(isPublicSearchHref(href)).toBe(true);
    for (const forged of ["/search?q=a&q=b", "/search?q=a#x", "/search?q=a+b", "/search?q=a&next=/admin", "/search/x?q=a",
      "/searchq=a", "/search?q=", "/search?q=%00", `/search?q=${"a".repeat(81)}`, "//evil.test/search?q=a"]) {
      expect(isPublicSearchHref(forged)).toBe(false);
    }
    expect(publicSearchHref("")).toBeNull();
  });
  it("is the only query-derived row the activation policy admits", () => {
    const row = (href: string) => ({ id: "search:all", group: "actions" as const, label: "See all guide results", href });
    expect(commandActivationPolicy.admitsItem(row("/search?q=12%20pool"), null, null)).toBe(true);
    expect(commandActivationPolicy.admitsItem(row("/search?q=12+pool"), null, null)).toBe(false);
    expect(commandActivationPolicy.admitsItem(row("/settings"), null, "user")).toBe(false);
  });
});
