import { describe, expect, it } from "vitest";
import {
  TABS,
  TODAY_DEFAULT_TAB,
  defaultTabRedirect,
  hrefForTab,
  isTabId,
  opponentDossierHref,
  slugForTab,
  tabForSlug,
} from "../tabs";

describe("routed section slugs", () => {
  it("round-trips every tab through its slug", () => {
    for (const tab of TABS) {
      const slug = slugForTab(tab.id);
      expect(tabForSlug(slug)?.id).toBe(tab.id);
      expect(hrefForTab(tab.id)).toBe(`/app/${slug}`);
    }
  });

  it("routes the battlefield tab at its user-facing name", () => {
    expect(hrefForTab("battlefield")).toBe("/app/maps");
    expect(tabForSlug("maps")?.id).toBe("battlefield");
    expect(tabForSlug("battlefield")).toBeNull();
  });

  it("routes the replay library at its sidebar label", () => {
    expect(hrefForTab("replays")).toBe("/app/replays");
    expect(tabForSlug("replays")?.id).toBe("replays");
  });

  it("keeps Replays between Builds and Arcade in shared navigation", () => {
    expect(TABS.map((tab) => tab.id).slice(-3)).toEqual([
      "builds",
      "replays",
      "arcade",
    ]);
  });

  it("rejects unknown slugs and retired tab ids", () => {
    expect(tabForSlug("ml")).toBeNull();
    expect(tabForSlug("")).toBeNull();
    expect(isTabId("ml")).toBe(false);
    expect(isTabId("macro")).toBe(true);
    expect(isTabId(undefined)).toBe(false);
  });

  it("encodes dossier ids so barcode ids with slashes survive", () => {
    expect(opponentDossierHref("1-S2-1-42/alt")).toBe(
      "/app/opponents/1-S2-1-42%2Falt",
    );
  });
});

describe("Settings default tab", () => {
  it("sends Today to a chosen section", () => {
    for (const tab of TABS) expect(defaultTabRedirect(tab.id)).toBe(tab.id);
  });

  it("stays on Today for Today, no choice or a removed section", () => {
    expect(TODAY_DEFAULT_TAB).toBe("today");
    for (const pref of [TODAY_DEFAULT_TAB, undefined, null, "", "ml"]) {
      expect(defaultTabRedirect(pref)).toBeNull();
    }
  });
});
