import { afterEach, expect, it, vi } from "vitest";
import { applyAppearanceAttributes, sanitizeAppearance } from "@/lib/appearance";
import { prefersReducedMotion } from "@/lib/a11y/useReducedMotion";
import { startOfWeek } from "@/lib/datePresets";

afterEach(() => {
  document.documentElement.removeAttribute("data-motion");
  document.documentElement.removeAttribute("data-text-size");
  document.documentElement.removeAttribute("data-density");
  vi.unstubAllGlobals();
});

it("applies the account's motion preference before the OS choice and exempts stream surfaces", () => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
  const prefs = sanitizeAppearance({ motion: "full", textSize: "125", density: "compact" });
  applyAppearanceAttributes(prefs, "/settings");
  expect(prefersReducedMotion()).toBe(false);
  expect(document.documentElement.getAttribute("data-text-size")).toBe("125");
  applyAppearanceAttributes(sanitizeAppearance({ motion: "reduce" }), "/settings");
  expect(prefersReducedMotion()).toBe(true);
  applyAppearanceAttributes(prefs, "/dock/game");
  expect(document.documentElement.hasAttribute("data-motion")).toBe(false);
  expect(document.documentElement.hasAttribute("data-text-size")).toBe(false);
  expect(prefersReducedMotion()).toBe(true);
});

it("aligns a local weekly range to the selected starting day", () => {
  const tuesday = new Date(2026, 10, 17, 14);
  expect(startOfWeek(tuesday, 1).getDate()).toBe(16);
  expect(startOfWeek(tuesday, 6).getDate()).toBe(14);
});
