import { describe, expect, it } from "vitest";
import { buildReportGuideLinks } from "../reportGuideLinks";
import { reportGuideFocus, tryFocusHref } from "../reportGuideTypes";
import { openerGuideLinks } from "../reportOpenerLinks";
import { buildInstantReport } from "../report";
import { realWin } from "./fixtures/reportGames";

const ownPath = "/guides/pvz/adept-glaives-robo";
describe("published report guide links and explicit focus", () => {
  it("fails closed on unavailable or unpublished sitemap targets", () => {
    expect(buildReportGuideLinks(null)).toEqual([]);
    expect(buildReportGuideLinks(new Set())).toEqual([]);
    const links = buildReportGuideLinks(new Set([ownPath]));
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ name: "PvZ - Adept Glaives (Robo)", matchup: "PvZ", kind: "build", key: "pvz/adept-glaives-robo" });
    expect(links[0].href).toContain("utm_source=instant");
    const games = buildInstantReport([realWin()], new Date()).games;
    expect(openerGuideLinks(links[0].name, "build", games, links)).toHaveLength(1);
    expect(openerGuideLinks(links[0].name, "counter", games, links)).toEqual([]);
    expect(openerGuideLinks(links[0].name, "build", games.map((game) => ({ ...game, matchup: "PvT" })), links)).toEqual([]);
  });

  it("accepts only exact published own-build keys and strict scalar URL intent", () => {
    const links = buildReportGuideLinks(new Set([ownPath]));
    expect(reportGuideFocus("pvz/adept-glaives-robo", links)?.name).toBe(links[0].name);
    for (const value of [null, ["pvz/adept-glaives-robo"], "PvZ/adept-glaives-robo", "pvz/unknown", "pvz/../x", "https://evil/x", "pvz/adept-glaives-robo#x"]) expect(reportGuideFocus(value, links)).toBeNull();
    expect(tryFocusHref("pvz", "adept-glaives-robo")).toContain("focus=pvz%2Fadept-glaives-robo");
    expect(tryFocusHref("pvz", "../secret")).toBeNull();
  });
});
