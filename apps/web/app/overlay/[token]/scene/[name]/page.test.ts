import { describe, expect, it } from "vitest";
import { isValidElement } from "react";
import { STREAM_BACKGROUND_IDS } from "@/lib/streamBackgrounds";
import { isValidScene } from "@/components/overlay/scenes/sceneVariants";
import OverlayScenePage from "./page";

describe("scene route allowlist", () => {
  it("includes every catalog background and preserves all legacy scenes", () => {
    for (const id of STREAM_BACKGROUND_IDS) {
      expect(isValidScene(id)).toBe(true);
    }
    for (const id of [
      "between-games",
      "starting-soon",
      "brb",
      "intermission",
      "manual",
    ]) {
      expect(isValidScene(id)).toBe(true);
    }
  });

  it("still rejects arbitrary path input", () => {
    expect(isValidScene("../../frontier-cantina")).toBe(false);
    expect(isValidScene("unknown-set")).toBe(false);
  });

  it.each<{ query: Record<string, string | string[]>; demoCreditQr: boolean; showCredit: boolean }>([
    { query: { creditQr: "1" }, demoCreditQr: false, showCredit: true },
    { query: { demo: "1", creditQr: "1" }, demoCreditQr: true, showCredit: true },
    { query: { demo: "1", creditQr: "1", credit: "0" }, demoCreditQr: true, showCredit: false },
    { query: { demo: "1", creditQr: ["1", "0"] }, demoCreditQr: false, showCredit: true },
  ])("keeps the QR query opt-in exclusive to demos ($query)", async ({ query, demoCreditQr, showCredit }) => {
    const element = await OverlayScenePage({
      params: Promise.resolve({ token: "synthetic-token", name: "starting-soon" }),
      searchParams: Promise.resolve(query),
    });
    expect(isValidElement(element) && element.props).toMatchObject({ demoCreditQr, showCredit });
  });
});
