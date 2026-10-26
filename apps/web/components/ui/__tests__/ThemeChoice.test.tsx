import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ThemeChoice } from "../ThemeChoice";
import { ThemeToggle } from "../ThemeToggle";
import { getTheme, getThemeMode, setTheme } from "@/lib/theme";
beforeEach(() => { localStorage.clear(); document.documentElement.removeAttribute("data-theme-mode"); document.documentElement.removeAttribute("data-theme"); vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it("provides three choices with one Tab stop and roving arrows/Home/End", () => {
  render(<ThemeChoice />); const group = screen.getByRole("radiogroup", { name: "Theme" });
  const radios = within(group).getAllByRole("radio"); expect(radios).toHaveLength(3); expect(radios.filter(radio => radio.tabIndex === 0)).toHaveLength(1);
  const system = screen.getByRole("radio", { name: "System" }); expect(system.getAttribute("aria-checked")).toBe("true"); system.focus();
  fireEvent.keyDown(system, { key: "ArrowRight" }); expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Light" })); expect(getThemeMode()).toBe("light");
  fireEvent.keyDown(document.activeElement!, { key: "End" }); expect(document.activeElement).toBe(system); expect(getThemeMode()).toBe("system");
  fireEvent.keyDown(system, { key: "ArrowLeft" }); expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Dark" }));
  fireEvent.keyDown(document.activeElement!, { key: "Home" }); expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Light" }));
});
it("keeps one-click toggle, offers System via Arrow Down and returns focus on Escape", () => {
  render(<ThemeToggle size="sm" />); const toggle = screen.getByRole("button", { name: "Switch to light theme" }); expect(toggle.classList.contains("h-8")).toBe(true);
  fireEvent.click(toggle); expect(getThemeMode()).toBe("light"); toggle.focus(); fireEvent.keyDown(toggle, { key: "ArrowDown" });
  const dialog = screen.getByRole("dialog", { name: "Appearance" }); expect(within(dialog).getAllByRole("radio")).toHaveLength(3);
  fireEvent.click(within(dialog).getByRole("radio", { name: "System" })); expect(getThemeMode()).toBe("system");
  fireEvent.keyDown(document, { key: "Escape" }); expect(screen.queryByRole("dialog")).toBeNull(); expect(document.activeElement).toBe(toggle);
});
it("consumes a long press without toggling and still accepts a later keyboard click", async () => {
  vi.useFakeTimers(); vi.stubGlobal("PointerEvent", MouseEvent); render(<ThemeToggle />); const toggle = screen.getByRole("button", { name: "Switch to light theme" });
  toggle.focus(); fireEvent.pointerDown(toggle, { button: 0 }); await act(async () => vi.advanceTimersByTimeAsync(500)); fireEvent.pointerUp(toggle); fireEvent.click(toggle, { detail: 1 });
  expect(screen.getByRole("dialog")).toBeTruthy(); expect(getThemeMode()).toBe("system"); fireEvent.click(screen.getByRole("button", { name: "Done" }));
  fireEvent.click(toggle, { detail: 0 }); expect(getTheme()).toBe("light");
});
it("updates all controls on cross-tab sync", () => {
  render(<><ThemeChoice /><ThemeToggle /></>); act(() => setTheme("light"));
  expect(screen.getByRole("radio", { name: "Light" }).getAttribute("aria-checked")).toBe("true"); expect(screen.getByRole("button", { name: "Switch to dark theme" })).toBeTruthy();
  act(() => window.dispatchEvent(new StorageEvent("storage", { key: "sc2tools.theme", newValue: "dark" })));
  expect(screen.getByRole("radio", { name: "Dark" }).getAttribute("aria-checked")).toBe("true"); expect(screen.getByRole("button", { name: "Switch to light theme" })).toBeTruthy();
});
