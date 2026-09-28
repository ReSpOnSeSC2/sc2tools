/**
 * SettingsShell — the opt-in Import tab: hidden unless the page allows
 * it, and a hidden initial tab falls back to the first visible one.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  SettingsShell,
  defaultTabVisibility,
  isSettingsTabId,
  visibleSettingsTabs,
} from "../SettingsShell";

afterEach(cleanup);

describe("SettingsShell import tab", () => {
  it("is hidden by default", () => {
    render(<SettingsShell renderTab={(id) => <div>{id}</div>} />);
    expect(screen.queryAllByRole("tab", { name: "Import" })).toHaveLength(0);
    expect(screen.getAllByRole("tab", { name: "Backups & data" })).toHaveLength(2);
    expect(defaultTabVisibility("import")).toBe(false);
    expect(visibleSettingsTabs()).not.toContain("import");
  });

  it("is shown and selectable when the page allows it", () => {
    render(
      <SettingsShell
        initialTab="import"
        isTabVisible={() => true}
        renderTab={(id) => <div>panel:{id}</div>}
      />,
    );
    expect(screen.getAllByRole("tab", { name: "Import" })).toHaveLength(2);
    expect(screen.getByRole("tabpanel", { name: "Import" }).textContent).toBe("panel:import");
  });

  it("falls back to the first visible tab for a hidden initial tab", () => {
    render(<SettingsShell initialTab="import" renderTab={(id) => <div>panel:{id}</div>} />);
    expect(screen.getByRole("tabpanel", { name: "Foundation" }).textContent).toBe("panel:foundation");
  });

  it("recognises tab ids from the query string", () => {
    expect(isSettingsTabId("import")).toBe(true);
    expect(isSettingsTabId("nope")).toBe(false);
    expect(isSettingsTabId(null)).toBe(false);
  });
});
