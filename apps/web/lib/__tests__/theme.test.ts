import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTheme, getThemeMode, NO_FLASH_THEME_SCRIPT, readStoredTheme, setTheme, subscribeTheme, THEME_COLORS, THEME_STORAGE_KEY, toggleTheme } from "../theme";
let osLight = false;
const changes = new Set<() => void>(), cleanups: (() => void)[] = [];
const media = { get matches() { return osLight; }, addEventListener: vi.fn((_type: string, callback: () => void) => changes.add(callback)), removeEventListener: vi.fn((_type: string, callback: () => void) => changes.delete(callback)) };
const follow = () => { const stop = subscribeTheme(() => {}); cleanups.push(stop); return stop; };
const os = (light: boolean) => { osLight = light; changes.forEach(callback => callback()); };
const color = () => [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map(meta => meta.content);
beforeEach(() => {
  osLight = false; localStorage.clear(); document.documentElement.removeAttribute("data-theme"); document.documentElement.removeAttribute("data-theme-mode");
  document.head.innerHTML = '<meta name="theme-color" media="(prefers-color-scheme: light)" content="#f4f6fa"><meta name="theme-color" media="(prefers-color-scheme: dark)" content="#06090e">';
  vi.stubGlobal("matchMedia", vi.fn(() => media)); media.addEventListener.mockClear(); media.removeEventListener.mockClear();
});
afterEach(() => { cleanups.splice(0).forEach(stop => stop()); changes.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("theme mode and runtime", () => {
  it("defaults to System and follows OS changes, including meta color and legacy listeners", () => {
    const legacy = vi.fn(); window.addEventListener("storage", legacy); localStorage.setItem(THEME_STORAGE_KEY, "system");
    follow(); expect(getThemeMode()).toBe("system"); expect(getTheme()).toBe("dark"); expect(changes.size).toBe(1);
    const write = vi.spyOn(Storage.prototype, "setItem"); os(true);
    expect(getTheme()).toBe("light"); expect(color()).toEqual([THEME_COLORS.light, THEME_COLORS.light]); expect(write).not.toHaveBeenCalled(); expect(legacy).toHaveBeenCalled();
    window.removeEventListener("storage", legacy);
  });
  it("forces light/dark independently of OS and attaches an OS listener only in System", () => {
    setTheme("light"); follow(); expect(changes.size).toBe(0); expect(getTheme()).toBe("light");
    os(false); expect(getTheme()).toBe("light"); setTheme("system"); expect(changes.size).toBe(1); expect(getTheme()).toBe("dark");
    setTheme("dark"); expect(changes.size).toBe(0); os(true); expect(getTheme()).toBe("dark"); expect(color()).toEqual([THEME_COLORS.dark, THEME_COLORS.dark]);
  });
  it("shares one OS listener and retires it after the final subscriber", () => {
    const first = follow(), second = follow(); expect(changes.size).toBe(1); expect(media.addEventListener).toHaveBeenCalledOnce();
    first(); expect(changes.size).toBe(1); second(); expect(changes.size).toBe(0);
  });
  it("applies cross-tab mode changes, invalid values and storage.clear without persisting them", () => {
    follow(); const write = vi.spyOn(Storage.prototype, "setItem");
    window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY, newValue: "light" })); expect(getThemeMode()).toBe("light"); expect(changes.size).toBe(0);
    window.dispatchEvent(new StorageEvent("storage", { key: "unrelated", newValue: "dark" })); expect(getTheme()).toBe("light");
    osLight = true; window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY, newValue: "sepia" })); expect(getThemeMode()).toBe("system"); expect(getTheme()).toBe("light");
    setTheme("dark"); write.mockClear(); window.dispatchEvent(new StorageEvent("storage", { key: null })); expect(getThemeMode()).toBe("system"); expect(write).not.toHaveBeenCalled();
  });
  it("keeps a choice in this tab when storage throws and one click exits System", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    osLight = true; follow(); expect(getTheme()).toBe("light"); expect(toggleTheme()).toBe("dark"); expect(getThemeMode()).toBe("dark"); expect(changes.size).toBe(0);
    setTheme("system"); os(false); expect(getTheme()).toBe("dark");
  });
  it.each(["light", "dark", "system"])("reads saved %s as a mode", mode => { localStorage.setItem(THEME_STORAGE_KEY, mode); expect(readStoredTheme()).toBe(mode); });
});
describe("prepaint bootstrap", () => {
  it.each([["system", true, "light"], ["system", false, "dark"], ["dark", true, "dark"], ["light", false, "light"], ["invalid", true, "light"]])("resolves %s with OS light=%s before paint", (saved, light, resolved) => {
    localStorage.setItem(THEME_STORAGE_KEY, String(saved)); osLight = Boolean(light); Function(NO_FLASH_THEME_SCRIPT)();
    expect(getTheme()).toBe(resolved); expect(getThemeMode()).toBe(saved === "invalid" ? "system" : saved); expect(color()).toEqual([THEME_COLORS[resolved as "light" | "dark"], THEME_COLORS[resolved as "light" | "dark"]]);
  });
  it("still follows the OS when storage is blocked", () => {
    osLight = true; vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    Function(NO_FLASH_THEME_SCRIPT)(); expect(getTheme()).toBe("light"); expect(getThemeMode()).toBe("system");
  });
});
