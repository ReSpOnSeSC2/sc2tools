/**
 * SettingsShell — the active tab follows `?tab=` changes while Settings
 * stays mounted (a link from one tab to another), keeps the
 * unsaved-changes guard for them, and writes hand-picked tabs back to the
 * URL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SettingsShell, type SettingsTabId } from "../SettingsShell";
import { usePublishDirty } from "../SettingsContext";

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn() }),
}));

function DirtyPanel({ id }: { id: string }) {
  usePublishDirty(id, true);
  return <p>dirty {id}</p>;
}

function shell(initialTab: SettingsTabId, dirtyTab: SettingsTabId | null = null) {
  return (
    <SettingsShell
      initialTab={initialTab}
      renderTab={(id) =>
        id === dirtyTab ? <DirtyPanel id={id} /> : <p>panel {id}</p>
      }
    />
  );
}

function activePanel() {
  return screen.getByRole("tabpanel").textContent;
}

beforeEach(() => {
  window.history.replaceState(null, "", "/settings?tab=checkin");
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("SettingsShell ?tab= sync", () => {
  it("switches when the URL asks for another tab", () => {
    const view = render(shell("checkin"));
    expect(activePanel()).toBe("panel checkin");
    window.history.replaceState(null, "", "/settings?tab=help#build-check-in");
    view.rerender(shell("help"));
    expect(activePanel()).toBe("panel help");
    // The link's anchor survives for the Help section to scroll to.
    expect(window.location.search).toBe("?tab=help");
    expect(window.location.hash).toBe("#build-check-in");
  });

  it("writes a hand-picked tab to the URL, keeping other params", () => {
    window.history.replaceState(null, "", "/settings?tab=checkin&ref=chip#build-check-in");
    render(shell("checkin"));
    fireEvent.click(screen.getAllByRole("tab", { name: "Voice" })[0]);
    expect(activePanel()).toBe("panel voice");
    expect(window.location.pathname).toBe("/settings");
    expect(new URLSearchParams(window.location.search).get("tab")).toBe("voice");
    expect(new URLSearchParams(window.location.search).get("ref")).toBe("chip");
    expect(window.location.hash).toBe("");
  });

  it("follows a link back to the tab that was open before a hand-picked one", () => {
    const view = render(shell("checkin"));
    fireEvent.click(screen.getAllByRole("tab", { name: "Help" })[0]);
    expect(activePanel()).toBe("panel help");
    // Next.js feeds the written ?tab=help back through useSearchParams.
    expect(new URLSearchParams(window.location.search).get("tab")).toBe("help");
    view.rerender(shell("help"));
    expect(activePanel()).toBe("panel help");
    // "Settings → Build check-in" on the Help tab: back to ?tab=checkin.
    window.history.replaceState(null, "", "/settings?tab=checkin");
    view.rerender(shell("checkin"));
    expect(activePanel()).toBe("panel checkin");
  });

  it("asks before a URL switch drops unsaved edits and can stay put", () => {
    const view = render(shell("checkin", "checkin"));
    window.history.replaceState(null, "", "/settings?tab=help#build-check-in");
    view.rerender(shell("help", "checkin"));
    expect(screen.getByRole("dialog", { name: "Discard unsaved changes?" })).toBeTruthy();
    expect(activePanel()).toBe("dirty checkin");

    fireEvent.click(screen.getByRole("button", { name: "Stay on this tab" }));
    expect(screen.queryByRole("dialog", { name: "Discard unsaved changes?" })).toBeNull();
    expect(activePanel()).toBe("dirty checkin");
    // The URL goes back to the tab that is actually showing.
    expect(new URLSearchParams(window.location.search).get("tab")).toBe("checkin");
  });

  it("switches after Discard and keeps the link's anchor", () => {
    const view = render(shell("checkin", "checkin"));
    window.history.replaceState(null, "", "/settings?tab=help#build-check-in");
    view.rerender(shell("help", "checkin"));
    fireEvent.click(screen.getByRole("button", { name: "Discard & switch" }));
    expect(activePanel()).toBe("panel help");
    expect(window.location.search).toBe("?tab=help");
    expect(window.location.hash).toBe("#build-check-in");
  });

  it("guards a hand-picked switch away from unsaved edits too", () => {
    render(shell("checkin", "checkin"));
    fireEvent.click(screen.getAllByRole("tab", { name: "Help" })[0]);
    expect(screen.getByRole("dialog", { name: "Discard unsaved changes?" })).toBeTruthy();
    // Nothing is written until the switch happens.
    expect(new URLSearchParams(window.location.search).get("tab")).toBe("checkin");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Discard & switch" }));
    });
    expect(activePanel()).toBe("panel help");
    expect(new URLSearchParams(window.location.search).get("tab")).toBe("help");
  });

  it("ignores a URL tab that isn't shown", () => {
    const visible = (id: SettingsTabId) => id !== "import";
    const view = render(<SettingsShell initialTab="checkin" isTabVisible={visible} renderTab={(id) => <p>panel {id}</p>} />);
    view.rerender(<SettingsShell initialTab="import" isTabVisible={visible} renderTab={(id) => <p>panel {id}</p>} />);
    expect(activePanel()).toBe("panel checkin");
  });

  it("guards canonical Preferences when a legacy link resolves to another tab", () => {
    window.history.replaceState(null, "", "/settings?tab=misc");
    const view = render(shell("preferences", "preferences"));
    window.history.replaceState(null, "", "/settings?tab=foundation&ref=old#setup-health");
    view.rerender(shell("account", "preferences"));
    expect(screen.getByRole("dialog", { name: "Discard unsaved changes?" })).toBeTruthy();
    expect(activePanel()).toBe("dirty preferences");
    fireEvent.click(screen.getByRole("button", { name: "Stay on this tab" }));
    expect(window.location.search).toBe("?tab=preferences&ref=old");
    expect(activePanel()).toBe("dirty preferences");

    window.history.replaceState(null, "", "/settings?tab=foundation&ref=old#setup-health");
    view.rerender(shell("account", "preferences"));
    // The request prop did not change: a later intentional click still guards.
    fireEvent.click(screen.getAllByRole("tab", { name: "Account" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Discard & switch" }));
    expect(activePanel()).toBe("panel account");
    expect(window.location.search).toBe("?tab=account&ref=old");
  });
});
