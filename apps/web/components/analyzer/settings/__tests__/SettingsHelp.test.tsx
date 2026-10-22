import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ToastProvider } from "@/components/ui/Toast";
import { SettingsHelp } from "../SettingsHelp";

// The support line asks Clerk whether "Report a problem" can be offered.
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: false }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

function renderHelp() {
  return render(
    <ToastProvider>
      <SettingsHelp />
    </ToastProvider>,
  );
}

function stubScroll() {
  const scrollIntoView = vi.fn();
  const original = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
  return { scrollIntoView, restore: () => (HTMLElement.prototype.scrollIntoView = original) };
}

describe("SettingsHelp", () => {
  it("renders every guide section and the support email", () => {
    renderHelp();
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
      expect(screen.getByText(heading, { selector: "summary" })).toBeTruthy();
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

  it("opens Getting started by default and links to the public help center", () => {
    renderHelp();
    expect((document.getElementById("getting-started") as HTMLDetailsElement).open).toBe(true);
    expect((document.getElementById("stream-dock") as HTMLDetailsElement).open).toBe(false);
    expect(screen.getByRole("link", { name: "Open the help center" }).getAttribute("href")).toBe("/help");
  });

  it("explains build check-in and links to its settings", () => {
    renderHelp();
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
    renderHelp();
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
    renderHelp();
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
    const scroll = stubScroll();
    try {
      renderHelp();
      const section = document.getElementById("build-check-in") as HTMLDetailsElement;
      expect(section.open).toBe(true);
      expect(scroll.scrollIntoView).toHaveBeenCalledTimes(1);
      expect(window.location.search).toBe("?tab=help");
      expect(window.location.hash).toBe("#build-check-in");
    } finally {
      scroll.restore();
    }
  });

  it("deep-links any article by its slug, including after a hash change", () => {
    window.history.replaceState(null, "", "/settings?tab=help#stream-dock");
    const scroll = stubScroll();
    try {
      renderHelp();
      expect((document.getElementById("stream-dock") as HTMLDetailsElement).open).toBe(true);
      act(() => {
        window.history.replaceState(null, "", "/settings?tab=help#viewer-engagement");
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      });
      expect((document.getElementById("viewer-engagement") as HTMLDetailsElement).open).toBe(true);
    } finally {
      scroll.restore();
    }
  });

  it("opens a search result in place and moves focus to it", () => {
    window.history.replaceState(null, "", "/settings?tab=help");
    const scroll = stubScroll();
    try {
      renderHelp();
      fireEvent.change(screen.getByRole("searchbox", { name: "Search help" }), {
        target: { value: "stream dock" },
      });
      const results = screen.getByRole("list", { name: "Search results" });
      const first = within(results).getAllByRole("link")[0];
      expect(first.getAttribute("href")).toBe("/settings?tab=help#stream-dock");
      fireEvent.click(first);
      const section = document.getElementById("stream-dock") as HTMLDetailsElement;
      expect(section.open).toBe(true);
      expect(document.activeElement).toBe(section.querySelector("summary"));
      expect(window.location.hash).toBe("#stream-dock");
      expect(window.location.search).toBe("?tab=help");
    } finally {
      scroll.restore();
    }
  });

  it("opens related articles in place", () => {
    const scroll = stubScroll();
    try {
      renderHelp();
      const dock = document.getElementById("stream-dock") as HTMLElement;
      const related = within(dock).getByRole("link", { name: "Viewer engagement: XP, ranks & predictions" });
      expect(related.getAttribute("href")).toBe("/settings?tab=help#viewer-engagement");
      fireEvent.click(related);
      expect((document.getElementById("viewer-engagement") as HTMLDetailsElement).open).toBe(true);
      expect(within(dock).getByRole("link", { name: "Open full article" }).getAttribute("href")).toBe(
        "/help/stream-dock",
      );
    } finally {
      scroll.restore();
    }
  });

  it("copies the bio text to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    renderHelp();
    fireEvent.click(screen.getByRole("button", { name: /Copy for your bio/ }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });
    const text = writeText.mock.calls[0][0] as string;
    expect(text).toContain("!win");
    expect(text).toContain("CHAT COMMANDS");
  });
});
