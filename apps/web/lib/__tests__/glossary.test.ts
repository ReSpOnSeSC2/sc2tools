import { describe, expect, it } from "vitest";
import { GLOSSARY, glossaryHelpPath, glossaryTerm } from "../glossary";
import { getArticle, helpArticleAnchors } from "../help";

describe("glossary", () => {
  it("seeds the opponent and MMR terms the info tips will use", () => {
    expect(GLOSSARY.map((term) => term.id)).toEqual(
      expect.arrayContaining(["pulse-id", "toon", "net-mmr", "verified-pairs", "mmr-impact", "group-same-player", "barcode"]),
    );
    expect(glossaryTerm("net-mmr")?.term).toBe("Net MMR");
    expect(glossaryTerm("nope")).toBeUndefined();
  });

  it("has unique, well-formed ids and related terms that exist", () => {
    const ids = GLOSSARY.map((term) => term.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const term of GLOSSARY) {
      expect(term.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(term.short.trim(), term.id).not.toBe("");
      for (const related of term.related) {
        expect(related, term.id).not.toBe(term.id);
        expect(glossaryTerm(related), `${term.id} → ${related}`).toBeDefined();
      }
    }
  });

  it("links every term to a real help article section", () => {
    for (const term of GLOSSARY) {
      const article = getArticle(term.help.slug);
      expect(article, term.id).toBeDefined();
      if (term.help.anchor) expect(helpArticleAnchors(article!), term.id).toContain(term.help.anchor);
    }
  });

  it("builds the help URL with the section anchor", () => {
    expect(glossaryHelpPath(glossaryTerm("net-mmr")!)).toBe("/help/opponents#net-mmr");
    expect(glossaryHelpPath({ ...glossaryTerm("barcode")!, help: { slug: "opponent-dossier" } })).toBe("/help/opponent-dossier");
  });
});
