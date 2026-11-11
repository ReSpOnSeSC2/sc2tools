// @vitest-environment node
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { contrastThemes } from "../../scripts/contrast-tokens.mjs";
import { OVERLAY_RACE_COLORS } from "../overlayRaceColors";

it("matches the dark race tokens in globals.css", () => {
  const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
  const { dark } = contrastThemes(css);
  const names = { T: "terran", Z: "zerg", P: "protoss", R: "random" } as const;
  for (const [key, name] of Object.entries(names)) {
    const rgb: number[] = dark[`race-${name}`];
    const hex = "#" + rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("");
    expect(hex).toBe(OVERLAY_RACE_COLORS[key as keyof typeof names]);
  }
});
