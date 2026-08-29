import { describe, expect, it } from "vitest";
import {
  MOBILE_TAB_KEYS,
  NAV_ENTRIES,
  isAnalyzerPath,
  isAppSurfacePath,
  isProtectedSurfacePath,
  matchSurface,
  surfaceTitle,
} from "../appNav";

describe("app surface matching", () => {
  it.each([
    "/app",
    "/app/replays",
    "/app/opponents",
    "/app/opponents/1-S2-1-99",
    "/app/game/g1",
    "/builds",
    "/builds/my-opener",
    "/meta",
    "/community",
    "/community/builds/slug",
    "/devices",
    "/settings",
    "/admin",
    "/admin/users/42",
    "/coaching",
  ])("claims %s for the app chrome", (pathname) => {
    expect(isAppSurfacePath(pathname)).toBe(true);
  });

  it.each([
    "/",
    "/download",
    "/donate",
    "/welcome",
    "/legal/privacy",
    "/p/handle",
    "/p/handle/replays",
    "/definitions",
    "/sign-in",
    "/overlay/token",
    null,
  ])("leaves %s on the marketing shell", (pathname) => {
    expect(isAppSurfacePath(pathname)).toBe(false);
  });

  it("does not let a lookalike prefix borrow the chrome", () => {
    // /application and /buildsomething are not app surfaces.
    expect(isAppSurfacePath("/application")).toBe(false);
    expect(isAppSurfacePath("/buildsomething")).toBe(false);
    expect(isAppSurfacePath("/community-guidelines")).toBe(false);
  });

  it("resolves the longest matching entry", () => {
    expect(matchSurface("/app/opponents/1-S2-1-99")?.entry.key).toBe("opponents");
    expect(matchSurface("/community/builds/slug")?.entry.key).toBe("community");
    expect(matchSurface("/app")?.entry.key).toBe("today");
  });

  it("flags detail pages and points back at their section root", () => {
    const dossier = matchSurface("/app/opponents/1-S2-1-99");
    expect(dossier?.isDetail).toBe(true);
    expect(dossier?.backHref).toBe("/app/opponents");

    const list = matchSurface("/app/opponents");
    expect(list?.isDetail).toBe(false);

    // The per-game replay is a leaf of the analyzer, not its own destination.
    const game = matchSurface("/app/game/g1");
    expect(game?.entry.key).toBe("today");
    expect(game?.backHref).toBe("/app");
    expect(surfaceTitle("/app/game/g1")).toBe("Replay");
  });

  it("titles each surface from its nav label", () => {
    expect(surfaceTitle("/app/replays")).toBe("Replays");
    expect(surfaceTitle("/settings")).toBe("Settings");
    expect(surfaceTitle("/devices")).toBe("Devices");
    expect(surfaceTitle("/builds/anything")).toBe("Custom builds");
    expect(surfaceTitle("/admin/users")).toBe("Admin");
    expect(surfaceTitle("/coaching")).toBe("Coaching");
  });

  it("separates public surfaces from the per-user ones", () => {
    expect(isProtectedSurfacePath("/app/replays")).toBe(true);
    expect(isProtectedSurfacePath("/settings")).toBe(true);
    expect(isProtectedSurfacePath("/app/macro")).toBe(true);
    expect(isProtectedSurfacePath("/coaching")).toBe(true);
    expect(isProtectedSurfacePath("/meta")).toBe(false);
    expect(isProtectedSurfacePath("/community/builds/slug")).toBe(false);
  });

  it("scopes analyzer-only concerns to /app", () => {
    expect(isAnalyzerPath("/app")).toBe(true);
    expect(isAnalyzerPath("/app/macro")).toBe(true);
    expect(isAnalyzerPath("/app/replays")).toBe(true);
    expect(isAnalyzerPath("/settings")).toBe(false);
    expect(isAnalyzerPath("/builds")).toBe(false);
  });

  it("keeps every nav key unique and every mobile tab real", () => {
    const keys = NAV_ENTRIES.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of MOBILE_TAB_KEYS) {
      expect(keys).toContain(key);
    }
  });

  it("keeps Coaching in the shared nav model behind its membership gate", () => {
    expect(isAppSurfacePath("/coaching")).toBe(true);
    expect(matchSurface("/coaching")?.entry.key).toBe("coaching");
    const coaching = NAV_ENTRIES.find((entry) => entry.href === "/coaching");
    expect(coaching).toMatchObject({
      key: "coaching",
      label: "Coaching",
      group: "utility",
      coachingOnly: true,
    });
    expect(MOBILE_TAB_KEYS).not.toContain("coaching");
  });
});
