import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  compareReportCards, decodeReportCard, decodeReportComparison, encodeReportCard, encodeReportComparison,
  reportCardFromLink, reportCardLink, reportComparisonLink,
} from "../reportCardLink";
import openersV1 from "../reportCardOpeners.v1.json";
import { REPORT_CARD_PATH, REPORT_COMPARE_PATH } from "../reportCardRoute";
import type { ReportCardModel } from "../reportSharing";

const sample: ReportCardModel = {
  totals: { games: 999, wins: 612, losses: 371 },
  matchups: [{ label: "vs Z", wins: 250, losses: 150 }, { label: "vs P", wins: 220, losses: 130 }, { label: "vs T", wins: 142, losses: 91 }],
  opener: { name: "TvT - Proxy Marauder", games: 286, wins: 142, losses: 144 },
  macro: { score: 98, games: 777 },
};

const empty: ReportCardModel = { totals: null, matchups: [], opener: null, macro: null };
const wire = (...bytes: number[]) => Buffer.from(bytes).toString("base64url");

describe("report card links", () => {
  it("round-trips selected sections in display order and stays below 60 characters", () => {
    for (const model of [sample, { ...empty, opener: sample.opener }, { ...empty, matchups: sample.matchups }, { ...empty, macro: sample.macro }]) {
      const fragment = encodeReportCard(model);
      expect(fragment).toMatch(/^[A-Za-z0-9_-]{1,59}$/);
      expect(decodeReportCard(fragment!)).toEqual(model);
    }
    const url = new URL(reportCardLink(sample)!);
    expect(url.pathname).toBe(REPORT_CARD_PATH);
    expect(url.search).toBe("");
    expect(decodeReportCard(url.hash.slice(1))).toEqual(sample);
  });

  it("preserves v1 opener enum indexes across catalog updates", () => {
    expect(createHash("sha256").update(JSON.stringify(openersV1)).digest("hex")).toBe(
      "8bba4f58f64efd3a43a637945c333f5e4389dcf0747e3b04634a884ac0be7ee6",
    );
    expect(decodeReportCard(wire(1, 1, 2, 0, 130, 1, 3, 2, 1))?.opener?.name).toBe("TvT - Proxy Marauder");
  });

  it.each([
    ["empty", ""], ["oversized", "a".repeat(60)], ["non-alphabet", "<Private Name>"],
    ["padding", "AQEBAAEDAQ=="], ["wrong version", wire(2, 1, 1, 0, 1, 1, 0)],
    ["wrong type", wire(1, 2, 1, 0, 1, 1, 0)], ["unknown sections", wire(1, 1, 9, 0, 3, 2, 1)],
    ["no rows", wire(1, 1, 0, 0)], ["unknown race", wire(1, 1, 0, 1, 3, 1, 0)],
    ["duplicate race", wire(1, 1, 0, 2, 0, 1, 0, 0, 0, 1)],
    ["wins and losses exceed games", wire(1, 1, 1, 0, 2, 2, 1)],
    ["matchup wins exceed totals", wire(1, 1, 1, 1, 5, 2, 3, 0, 3, 0)],
    ["out-of-range games", wire(1, 1, 1, 0, 232, 7, 0, 0)],
    ["unknown opener", wire(1, 1, 2, 0, 255, 1, 3, 1, 2)],
    ["under-sampled opener", wire(1, 1, 2, 0, 0, 2, 1, 1)],
    ["macro over 100", wire(1, 1, 4, 0, 101, 2)],
    ["trailing bytes", wire(1, 1, 1, 0, 1, 1, 0, 9)],
    ["truncated", wire(1, 1, 1, 0, 1, 1)],
    ["overlong varint", wire(1, 1, 1, 0, 129, 0, 1, 0)],
    ["noncanonical base64", "AQEBAAEBAB"],
  ])("rejects %s", (_kind, fragment) => {
    expect(decodeReportCard(fragment)).toBeNull();
  });

  it("does not encode unrecognized text, non-integers, or inconsistent totals", () => {
    expect(encodeReportCard(empty)).toBeNull();
    expect(encodeReportCard({ ...sample, opener: { ...sample.opener!, name: "Private opponent" } })).toBeNull();
    expect(encodeReportCard({ ...sample, matchups: [{ label: "Private opponent", wins: 1, losses: 0 }] })).toBeNull();
    expect(encodeReportCard({ ...sample, macro: { score: 50.5, games: 1 } })).toBeNull();
    expect(encodeReportCard({ ...sample, macro: { score: 50, games: 1000 } })).toBeNull();
  });

  it("rejects oversized fragments before allocating decoded bytes", () => {
    const base64Decoder = vi.spyOn(globalThis, "atob");
    try {
      expect(decodeReportCard("A".repeat(60))).toBeNull();
      expect(base64Decoder).not.toHaveBeenCalled();
    } finally {
      base64Decoder.mockRestore();
    }
  });

  it("fails closed across seeded random bytes and mutations of a valid card", () => {
    let seed = 57233;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) >>> 16;
    const valid = Buffer.from(encodeReportCard(sample)!, "base64url");
    let accepted = 0;
    for (let index = 0; index < 2000; index++) {
      const bytes = index % 2 ? Buffer.from(valid) : Buffer.from(Array.from({ length: next() % 80 }, () => next() % 256));
      if (bytes.length) bytes[next() % bytes.length] = next() % 256;
      const fragment = bytes.toString("base64url");
      const model = decodeReportCard(fragment);
      if (model) {
        accepted++;
        expect(encodeReportCard(model)).toBe(fragment);
      }
    }
    expect(accepted).toBeGreaterThan(50);
    expect(accepted).toBeLessThan(1000);
  });
});

describe("report comparisons", () => {
  const comparison = {
    first: { games: 999, wins: 500, losses: 499 },
    second: { games: 999, wins: 499, losses: 500 },
  };
  const valid = wire(1, 2, 5, 4, 1, 8, 3, 5);

  it("encodes a bounded comparison with one record per side and keeps card types separate", () => {
    const fragment = encodeReportComparison(comparison);
    expect(fragment).toMatch(/^[A-Za-z0-9_-]{1,59}$/);
    expect(decodeReportComparison(fragment!)).toEqual(comparison);
    expect(decodeReportCard(fragment!)).toBeNull();
    expect(decodeReportComparison(encodeReportCard(sample)!)).toBeNull();
    const url = new URL(reportComparisonLink(comparison)!);
    expect(url.pathname).toBe(REPORT_COMPARE_PATH);
    expect(url.search).toBe("");
    expect(url.hash).toBe(`#${fragment}`);
    expect(decodeReportComparison(valid)).toEqual({
      first: { games: 5, wins: 4, losses: 1 }, second: { games: 8, wins: 3, losses: 5 },
    });
  });

  it.each([
    ["empty", ""], ["oversized", "A".repeat(60)], ["non-alphabet", "<Private Name>"],
    ["padded", valid + "="], ["noncanonical base64", "AQIFBAEIAwV"],
    ["unsupported version", wire(2, 2, 5, 4, 1, 8, 3, 5)],
    ["truncated", wire(1, 2, 5, 4, 1, 8, 3)],
    ["trailing bytes", wire(1, 2, 5, 4, 1, 8, 3, 5, 9)],
    ["noncanonical varint", wire(1, 2, 133, 0, 4, 1, 8, 3, 5)],
    ["no games", wire(1, 2, 0, 0, 0, 8, 3, 5)],
    ["inconsistent totals", wire(1, 2, 5, 5, 1, 8, 3, 5)],
    ["out-of-range games", wire(1, 2, 232, 7, 0, 0, 8, 3, 5)],
  ])("rejects %s", (_case, fragment) => {
    expect(decodeReportComparison(fragment)).toBeNull();
  });

  it("requires totals on both sides and allows a sample with no decided games", () => {
    expect(compareReportCards(sample, empty)).toBeNull();
    expect(compareReportCards(empty, sample)).toBeNull();
    const own = { ...empty, totals: { games: 2, wins: 0, losses: 0 } };
    expect(compareReportCards(own, sample)).toEqual({ first: own.totals, second: sample.totals });
    expect(encodeReportComparison({ ...comparison, first: { games: 1, wins: 1, losses: 1 } })).toBeNull();
    expect(encodeReportComparison({ ...comparison, second: { games: 1, wins: 1, losses: 1 } })).toBeNull();
  });

  it("reads only complete same-origin summary links", () => {
    const link = reportCardLink(sample)!;
    const url = new URL(link);
    expect(reportCardFromLink(`  ${link}  `)).toEqual(sample);
    expect(reportCardFromLink(link.replace("/report/", "/r%65port/"))).toEqual(sample);
    expect(reportCardFromLink(link.replace(REPORT_CARD_PATH, REPORT_COMPARE_PATH))).toBeNull();
    expect(reportCardFromLink(`https://example.test${url.pathname}${url.hash}`)).toBeNull();
    expect(reportCardFromLink(`https://PrivateName@${url.host}${url.pathname}${url.hash}`)).toBeNull();
    expect(reportCardFromLink(`${url.origin}${url.pathname}?q=PrivateName${url.hash}`)).toBeNull();
    expect(reportCardFromLink(`${link}${"A".repeat(240)}`)).toBeNull();
    expect(reportCardFromLink("Private Name")).toBeNull();
  });
});
