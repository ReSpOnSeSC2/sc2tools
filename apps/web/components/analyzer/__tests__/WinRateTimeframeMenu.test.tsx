/**
 * The Win rate card's timeframe menu: menu-button semantics and the
 * keyboard (open on the selected item, arrows wrap, Home/End, Esc back
 * to the button, Tab closes, Enter picks).
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PresetId } from "@/lib/datePresets";
import { WIN_RATE_PRESET_OPTIONS, WinRateLabel } from "../WinRateTimeframeMenu";

afterEach(cleanup);

function Harness({ initial = "last_30d", onPick = () => undefined }: { initial?: PresetId; onPick?: (id: PresetId) => void }) {
  const [preset, setPreset] = useState<PresetId>(initial);
  return (
    <WinRateLabel
      currentPreset={preset}
      seasons={[]}
      onPick={(id) => {
        setPreset(id);
        onPick(id);
      }}
    />
  );
}

function trigger(): HTMLElement {
  return screen.getByRole("button", { name: "Change Win Rate timeframe" });
}

function items(): HTMLElement[] {
  return screen.getAllByRole("menuitemradio");
}

function openMenu() {
  fireEvent.click(trigger());
  return screen.getByRole("menu", { name: "Win rate timeframe" });
}

describe("WinRateLabel menu", () => {
  it("is a menu button that reports its state", () => {
    render(<Harness />);
    expect(trigger().getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    const menu = openMenu();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(trigger().getAttribute("aria-controls")).toBe(menu.id);
    expect(items()).toHaveLength(WIN_RATE_PRESET_OPTIONS.length);
  });

  it("focuses the selected timeframe on open, or the first one", () => {
    render(<Harness initial="last_30d" />);
    openMenu();
    const selected = items().find((el) => el.getAttribute("aria-checked") === "true");
    expect(selected?.textContent).toBe("Last 30 days");
    expect(document.activeElement).toBe(selected);
    cleanup();

    render(<Harness initial="custom" />);
    openMenu();
    expect(document.activeElement).toBe(items()[0]);
  });

  it("moves with the arrows and wraps, and jumps with Home and End", () => {
    render(<Harness initial="all" />);
    const menu = openMenu();
    const all = items();
    expect(document.activeElement).toBe(all[all.length - 1]);

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(all[0]);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(all[1]);
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(all[all.length - 1]);
    fireEvent.keyDown(menu, { key: "Home" });
    expect(document.activeElement).toBe(all[0]);
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(all[all.length - 1]);
  });

  it("closes on Escape and returns focus to the button", () => {
    render(<Harness />);
    const menu = openMenu();
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on Tab from the button's place in the tab order", () => {
    render(<Harness />);
    const menu = openMenu();
    fireEvent.keyDown(menu, { key: "Tab" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("keeps the menu items and the outside-click catcher out of the tab order", () => {
    render(<Harness />);
    openMenu();
    for (const item of items()) expect(item.tabIndex).toBe(-1);
    const catcher = document.querySelector("button.fixed.inset-0");
    expect(catcher?.getAttribute("tabindex")).toBe("-1");
    expect(catcher?.getAttribute("aria-hidden")).toBe("true");
  });

  it("picks a timeframe, closes and returns focus to the button", () => {
    const onPick = vi.fn();
    render(<Harness initial="last_30d" onPick={onPick} />);
    const menu = openMenu();
    fireEvent.keyDown(menu, { key: "Home" });
    fireEvent.click(document.activeElement as HTMLElement);
    expect(onPick).toHaveBeenCalledWith(WIN_RATE_PRESET_OPTIONS[0]);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("opens from the keyboard with the down arrow", () => {
    render(<Harness initial="last_7d" />);
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(document.activeElement?.getAttribute("aria-checked")).toBe("true");
  });
});
