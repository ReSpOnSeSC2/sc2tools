import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { SettingsShell } from "../SettingsShell";

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn() }),
}));

afterEach(cleanup);

describe("SettingsShell layout containment", () => {
  it("gives the content track a zero minimum width", () => {
    const { container } = render(
      <SettingsShell
        initialTab="overlay"
        renderTab={(id) => <div>{id}</div>}
      />,
    );

    const grid = container.firstElementChild;
    expect(grid).not.toBeNull();
    expect(grid!.className.split(/\s+/)).toContain(
      "lg:grid-cols-[240px_minmax(0,1fr)]",
    );

    const panel = screen.getByRole("tabpanel", { name: "Overlay" });
    expect(panel.className.split(/\s+/)).toContain("min-w-0");
    expect(
      screen.getAllByRole("tab", { name: "Backups & data" }),
    ).toHaveLength(2);
  });

  it("groups desktop navigation without breaking arrows between groups", () => {
    render(<SettingsShell renderTab={(id) => <div>panel {id}</div>} />);
    const sidebar = screen.getByRole("navigation", { name: "Settings navigation" });
    const desktop = screen.getAllByRole("tablist", { name: "Settings sections" })[1];
    expect(within(sidebar).getAllByRole("heading").map((node) => node.textContent))
      .toEqual(["Account", "Gameplay", "Streaming"]);
    const tabs = within(desktop).getAllByRole("tab");
    expect(tabs.map((node) => node.getAttribute("data-value")))
      .toEqual(["account", "profile", "backups", "checkin", "randomizer", "import", "overlay", "chat", "voice", "preferences", "help"]);
    expect(Array.from(desktop.children).every((node) => node.getAttribute("role") === "tab")).toBe(true);
    const devices = within(sidebar).getByRole("link", { name: "Devices" });
    expect(devices.getAttribute("href")).toBe("/devices");
    expect(devices.getAttribute("data-settings-group")).toBe("account");
    expect(within(desktop).queryByRole("tab", { name: /Devices/ })).toBeNull();
    const overlay = within(desktop).getByRole("tab", { name: "Overlay" });
    expect(overlay.getAttribute("aria-describedby")!.split(" ").map((id) => document.getElementById(id)?.textContent).join(" "))
      .toBe("Streaming OBS sources, widgets, scenes and theme");

    const backups = within(desktop).getByRole("tab", { name: "Backups & data" });
    fireEvent.keyDown(backups, { key: "ArrowDown" });
    expect(document.activeElement).toBe(within(desktop).getByRole("tab", { name: "Build check-in" }));
    expect(screen.getByRole("tabpanel").textContent).toBe("panel checkin");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(backups);
    fireEvent.keyDown(backups, { key: "End" });
    expect(document.activeElement).toBe(within(desktop).getByRole("tab", { name: "Help" }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(within(desktop).getByRole("tab", { name: "Account" }));
  });

  it("keeps mobile Home, End and horizontal arrows in the same registry order", () => {
    render(<SettingsShell initialTab="backups" renderTab={(id) => <div>panel {id}</div>} />);
    const mobile = screen.getAllByRole("tablist", { name: "Settings sections" })[0];
    const backups = within(mobile).getByRole("tab", { name: "Backups & data" });
    fireEvent.keyDown(backups, { key: "ArrowRight" });
    expect(document.activeElement).toBe(within(mobile).getByRole("tab", { name: "Build check-in" }));
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(within(mobile).getByRole("tab", { name: "Account" }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(within(mobile).getByRole("tab", { name: "Help" }));
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(screen.getByRole("tabpanel").textContent).toBe("panel help");
  });
});
