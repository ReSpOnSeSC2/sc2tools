/** A drift guard for Clerk's literal colors against the CSS source of truth. */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { THEME_TOKENS } from "../theme/tokens";
import { appearanceFor } from "../clerk-appearance";
const css = fs.readFileSync(path.resolve(process.cwd(), "app/globals.css"), "utf8");
describe("Clerk theme tokens", () => {
  it.each(["light", "dark"] as const)("mirrors every mapped %s CSS token", (theme) => {
    const selector = theme === "dark" ? ":root:not([data-theme])" : ':root[data-theme="light"]';
    const block = css.slice(css.indexOf(selector)).split("}")[0];
    for (const [name, hex] of Object.entries(THEME_TOKENS[theme])) {
      const rgb = block.match(new RegExp(`--${name}:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)`));
      expect(rgb, name).not.toBeNull();
      const converted = "#" + rgb!.slice(1).map((value) => Number(value).toString(16).padStart(2, "0")).join("");
      expect(hex, name).toBe(converted);
    }
    const variables = appearanceFor(theme).variables!;
    expect(variables.colorBackground).toBe(THEME_TOKENS[theme]["bg-surface"]);
    expect(variables.colorInputBackground).toBe(THEME_TOKENS[theme]["bg-elevated"]);
    expect(variables.colorDanger).toBe(THEME_TOKENS[theme].danger);
  });
});
