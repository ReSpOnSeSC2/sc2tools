import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ToastProvider } from "@/components/ui/Toast";
import { SettingsHelp } from "../SettingsHelp";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SettingsHelp", () => {
  it("renders every guide section and the support email", () => {
    render(
      <ToastProvider>
        <SettingsHelp />
      </ToastProvider>,
    );
    for (const heading of [
      /Getting started/,
      /Dashboard & analyzer/,
      /Build check-in: count the build you went for/,
      /OBS overlay setup/,
      /Multi-platform chat \(Twitch/,
      /Stream Dock \(your control panel\)/,
      /Viewer engagement: XP/,
      /Troubleshooting & support/,
    ]) {
      expect(screen.getByText(heading)).toBeTruthy();
    }
    expect(
      screen.getByRole("link", { name: "responsecoaching@gmail.com" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Stream Studio crash course & widget guides" }).getAttribute("href"),
    ).toBe("/stream-studio/learn");
    // The commands card is embedded with the full command list.
    expect(screen.getByText("!rank")).toBeTruthy();
    expect(screen.getByText("!opponent")).toBeTruthy();
  });

  it("explains build check-in and links to its settings", () => {
    render(
      <ToastProvider>
        <SettingsHelp />
      </ToastProvider>,
    );
    const section = document.getElementById("build-check-in") as HTMLDetailsElement;
    expect(section).toBeTruthy();
    expect(section.open).toBe(false);
    expect(
      screen.getByRole("link", { name: "Settings → Build check-in" }).getAttribute("href"),
    ).toBe("/settings?tab=checkin");
    expect(section.textContent).toContain("What's the plan?");
    expect(section.textContent).toContain("Which build were you going for?");
    expect(section.textContent).toContain("Build check-ins (N)");
  });

  it("explains correcting the opponent's build on the desktop card and the website", () => {
    render(
      <ToastProvider>
        <SettingsHelp />
      </ToastProvider>,
    );
    const text = (document.getElementById("build-check-in") as HTMLElement).textContent ?? "";
    expect(text).toContain("The opponent's build");
    // Desktop end card labels.
    expect(text).toContain("Opponent's build: …");
    expect(text).toContain("Faced before");
    expect(text).toContain("Search opponent builds");
    expect(text).toContain("changed");
    // Website card labels.
    expect(text).toContain("Change…");
    expect(text).toContain("Use replay's label");
    expect(text).toContain("Corrected");
    expect(text).toContain("Opponent strategy");
  });

  it("explains adding a new build from a check-in", () => {
    render(
      <ToastProvider>
        <SettingsHelp />
      </ToastProvider>,
    );
    const text = (document.getElementById("build-check-in") as HTMLElement).textContent ?? "";
    expect(text).toContain("Add a build you don't have yet");
    expect(text).toContain("Add new build…");
    expect(text).toContain("Add “…” as a new build…");
    expect(text).toContain("Save as new build");
    expect(text).toContain("Save build");
    expect(text).toContain("Save & Reclassify");
    expect(text).toContain("Saved to your library and checked in");
    expect(text).toContain("Available once your replay uploads");
  });

  it("opens the build check-in guide when reached through its anchor", () => {
    window.history.replaceState(null, "", "/settings?tab=help#build-check-in");
    const scrollIntoView = vi.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      render(
        <ToastProvider>
          <SettingsHelp />
        </ToastProvider>,
      );
      const section = document.getElementById("build-check-in") as HTMLDetailsElement;
      expect(section.open).toBe(true);
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
      window.history.replaceState(null, "", "/");
    }
  });

  it("copies the bio text to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(
      <ToastProvider>
        <SettingsHelp />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Copy for your bio/ }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });
    const text = writeText.mock.calls[0][0] as string;
    expect(text).toContain("!win");
    expect(text).toContain("CHAT COMMANDS");
  });
});
