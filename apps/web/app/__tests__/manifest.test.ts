// @vitest-environment node
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "../manifest";

const PUBLIC_DIR = path.resolve(process.cwd(), "public");

describe("web app manifest", () => {
  const m = manifest();

  it("installs as the app: fixed id, opens on Today, any orientation", () => {
    expect(m.id).toBe("/app");
    expect(m.start_url).toBe("/app?source=pwa");
    expect(m.scope).toBe("/");
    expect(m.display).toBe("standalone");
    expect(m.orientation).toBe("any");
  });

  it("uses the app background for the splash screen and title bar", () => {
    expect(m.theme_color).toBe("#06090e");
    expect(m.background_color).toBe("#06090e");
  });

  it("offers shortcuts to Today, Opponents, Replays and Stream settings", () => {
    expect(m.shortcuts?.map((s) => [s.name, s.url])).toEqual([
      ["Today", "/app"],
      ["Opponents", "/app/opponents"],
      ["Replays", "/app/replays"],
      ["Stream settings", "/settings?tab=overlay"],
    ]);
    for (const shortcut of m.shortcuts ?? []) {
      expect(shortcut.short_name?.length ?? 0).toBeLessThanOrEqual(12);
      expect(shortcut.description).toBeTruthy();
    }
  });

  it("only points at icons that exist", () => {
    const icons = [...(m.icons ?? []), ...(m.shortcuts ?? []).flatMap((s) => s.icons ?? [])];
    expect(icons.length).toBeGreaterThan(0);
    for (const icon of icons) expect(existsSync(path.join(PUBLIC_DIR, icon.src)), icon.src).toBe(true);
    expect(m.icons?.some((icon) => icon.purpose === "maskable")).toBe(true);
  });
});
