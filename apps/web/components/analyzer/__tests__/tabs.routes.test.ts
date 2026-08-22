import { describe, expect, it } from "vitest";
import {
  TABS,
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
