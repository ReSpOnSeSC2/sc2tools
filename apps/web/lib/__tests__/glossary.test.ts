import { describe, expect, it } from "vitest";
import { GLOSSARY, glossaryHelpPath, glossaryTerm } from "../glossary";
import { getArticle, helpArticleAnchors } from "../help";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

function sourceTerms(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceTerms(file);
    if (!file.endsWith(".tsx") || /\.(test|spec)\.tsx$/.test(file)) return [];
    return [...readFileSync(file, "utf8").matchAll(/<(?:Term\b[^>]*\bid|InfoTip\b[^>]*\btermId)="([^"]+)"/g)].map(match => match[1]);
  });
}

describe("glossary", () => {
  it("keeps every literal Term/InfoTip consumer ID valid and publishes known glossary anchors", () => {
    const ids = sourceTerms(path.resolve(__dirname, "../../components"));
    expect(ids).toContain("group-same-player");
    for (const id of ids) expect(glossaryTerm(id), id).toBeDefined();
    const article = getArticle("glossary"); expect(article).toBeDefined();
    expect(helpArticleAnchors(article!)).toEqual(GLOSSARY.map(term => term.id));
  });
  it("seeds the opponent and MMR terms the info tips will use", () => {
    expect(GLOSSARY).toHaveLength(41);
    expect(GLOSSARY.map((term) => term.id)).toEqual(
      expect.arrayContaining(["pulse-id", "toon", "net-mmr", "verified-pairs", "mmr-impact", "group-same-player", "barcode"]),
    );
    expect(glossaryTerm("net-mmr")?.term).toBe("Net MMR");
    expect(glossaryTerm("nope")).toBeUndefined();
  });

  it("publishes all four KPI and six opponent-header definitions without replacing the original IDs", () => {
    for (const id of ["spending-quotient", "supply-blocked", "float-spikes", "apm", "pulse-id", "last-mmr", "net-mmr", "mmr-won", "mmr-lost", "opponent-win-rate"]) {
      expect(glossaryTerm(id), id).toBeDefined();
    }
    for (const term of GLOSSARY) if (term.formula !== undefined) {
      expect(typeof term.formula, term.id).toBe("string");
      expect(term.formula.trim(), term.id).not.toBe("");
    }
    expect(getArticle("reading-your-stats")).toBeDefined();
    expect(helpArticleAnchors(getArticle("reading-your-stats")!)).toEqual(["today", "opponents", "macro", "builds"]);
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

it("publishes the selected session definition at its real Help anchor", () => {
  const term = glossaryTerm("session");
  expect(term?.term).toBe("Session"); expect(term?.long).toContain("240 minutes"); expect(term?.long).toContain("90 minutes");
  expect(term?.help).toEqual({ slug: "sessions", anchor: "definition" });
  expect(glossaryHelpPath(term!)).toBe("/help/sessions#definition");
  expect(helpArticleAnchors(getArticle("sessions")!)).toContain("definition");
});
