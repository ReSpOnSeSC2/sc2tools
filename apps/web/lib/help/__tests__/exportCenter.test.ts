// @vitest-environment node
import { describe, expect, it } from "vitest";
import { getArticle, helpArticleAnchors } from "../index";
import { searchHelp } from "../search";

describe("export center help contracts", () => {
  it("registers the export anchor and replay-pack guide with distinct account/detail/snapshot and recorded-result facts", () => {
    const account = getArticle("backups-and-export")!, packs = getArticle("replay-packs")!;
    expect(helpArticleAnchors(account)).toContain("export"); expect(helpArticleAnchors(packs)).toEqual(expect.arrayContaining(["select", "filenames", "results", "cancel", "access"]));
    const archiveText = JSON.stringify(account.body), packText = JSON.stringify(packs.body);
    for (const text of ["NDJSON", "Include game details", "24 hours", "128 MiB", "local time", "three admitted requests", "explicit retry", "transactionally frozen"]) expect(archiveText).toContain(text);
    for (const text of ["100", "up to four", "manifest.csv", "recorded", "download status", "128 MiB", "5 MiB", "not anonymized", "one-minute expiry", "browser GET"]) expect(packText).toContain(text);
    expect(packText).not.toMatch(/https:\/\/.*signature|Bearer /u); expect(getArticle("replays")?.related).toContain("replay-packs");
  });
  it("finds the guide by filename/manifest/batch terminology", () => {
    expect(searchHelp("replay pack").some(result => result.article.slug === "replay-packs")).toBe(true);
    expect(searchHelp("manifest").some(result => result.article.slug === "replay-packs")).toBe(true);
  });
});
