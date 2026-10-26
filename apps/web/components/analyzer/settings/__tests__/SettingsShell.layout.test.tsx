import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { SettingsShell } from "../SettingsShell";
import { SettingsSectionsReady } from "../SettingsSectionNav";

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/settings");
});

describe("SettingsShell layout containment", () => {
  it("adds the third real section rail without remounting the current draft", async () => {
    function ProfileBody() {
      const [ready, setReady] = useState(false);
      return <><SettingsSectionsReady revision={ready} /><input aria-label="Profile draft" defaultValue="saved" />
        <button onClick={() => setReady(true)}>Admit third section</button><section id="profile-details">Profile details</section>
        <section id="pulse-ids">Pulse IDs</section>{ready ? <section id="player-channels">Channels</section> : null}</>;
    }
    window.history.replaceState(null, "", "/settings?tab=profile");
    render(<SettingsShell initialTab="profile" renderTab={id => id === "profile" ? <ProfileBody /> : <p>{id}</p>} />);
    const draft = screen.getByRole("textbox", { name: "Profile draft" });
    fireEvent.change(draft, { target: { value: "unsaved profile" } });
    expect(screen.queryByRole("navigation", { name: "On this page" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Admit third section" }));
    await waitFor(() => expect(screen.getByRole("navigation", { name: "On this page" })).toBeTruthy());
    expect(screen.getByRole("textbox", { name: "Profile draft" })).toBe(draft);
    expect((draft as HTMLInputElement).value).toBe("unsaved profile");
  });
  it("gives the content track a zero minimum width", () => {
    render(
      <SettingsShell
        initialTab="overlay"
        renderTab={(id) => <div>{id}</div>}
      />,
    );

    const grid = screen.getByRole("navigation", { name: "Settings navigation" }).parentElement;
    expect(grid).not.toBeNull();
    expect(grid!.className.split(/\s+/)).toContain(
      "lg:grid-cols-[240px_minmax(0,1fr)]",
    );

    const panel = screen.getByRole("tabpanel", { name: "Overlay" });
    expect(panel.className.split(/\s+/)).toContain("min-w-0");
    expect(
      screen.getAllByRole("tab", { name: "Backups & data" }),
    ).toHaveLength(2);
    expect(screen.getAllByRole("combobox", { name: "Find a setting" })).toHaveLength(1);
    expect(screen.getByRole("combobox", { name: "Find a setting" }).compareDocumentPosition(grid!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
