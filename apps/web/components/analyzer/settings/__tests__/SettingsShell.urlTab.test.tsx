/**
 * SettingsShell — the active tab follows `?tab=` changes while Settings
 * stays mounted (a link from one tab to another), keeps the
 * unsaved-changes guard for them, and writes hand-picked tabs back to the
 * URL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { SettingsShell, type SettingsTabId } from "../SettingsShell";
import { usePublishDirty } from "../SettingsContext";

const callbacks = vi.hoisted(() => ({ confirm: null as (() => void) | null, navigate: null as ((href: string) => void) | null }));
vi.mock("../OverlayManagerNav", async importOriginal => {
  const actual = await importOriginal<typeof import("../OverlayManagerNav")>();
  return { ...actual, OverlayManagerNav: (props: Parameters<typeof actual.OverlayManagerNav>[0]) => { callbacks.navigate = props.onNavigate; return <actual.OverlayManagerNav {...props} />; } };
});
vi.mock("@/components/ui/ConfirmDialog", async importOriginal => {
  const actual = await importOriginal<typeof import("@/components/ui/ConfirmDialog")>();
  return { ...actual, ConfirmDialog: (props: Parameters<typeof actual.ConfirmDialog>[0]) => { callbacks.confirm = props.onConfirm; return <actual.ConfirmDialog {...props} />; } };
});

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
  it("same-tab section navigation keeps the mounted draft; leaving it still asks first", () => {
    function Draft() {
      const [value, setValue] = useState("saved"); usePublishDirty("overlay", value !== "saved");
      return <><label>Draft theme<input value={value} onChange={event => setValue(event.target.value)} /></label><section id="theme">Theme section</section></>;
    }
    window.history.replaceState(null, "", "/settings?tab=overlay&ref=keep");
    render(<SettingsShell ownerKey="owner-a" initialTab="overlay" renderTab={id => id === "overlay" ? <Draft /> : <p>panel {id}</p>} />);
    const input = screen.getByRole("textbox", { name: "Draft theme" });
    fireEvent.change(input, { target: { value: "unsaved accent" } });
    fireEvent.click(screen.getByRole("link", { name: "Theme" }));
    expect(screen.getByRole("textbox", { name: "Draft theme" })).toBe(input);
    expect((input as HTMLInputElement).value).toBe("unsaved accent");
    expect(window.location.search + window.location.hash).toBe("?tab=overlay&ref=keep#theme");
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getAllByRole("tab", { name: "Chat & alerts" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Stay on this tab" }));
    expect((input as HTMLInputElement).value).toBe("unsaved accent");
    expect(window.location.search + window.location.hash).toBe("?tab=overlay&ref=keep#theme");
  });
  it("an earlier section callback cannot navigate after owner A→B→A", () => {
    window.history.replaceState(null, "", "/settings?tab=overlay");
    const owner = (ownerKey: string) => <SettingsShell ownerKey={ownerKey} initialTab="overlay" renderTab={id => <p>panel {id}</p>} />;
    const view = render(owner("a")); const retired = callbacks.navigate!;
    view.rerender(owner("b")); view.rerender(owner("a"));
    act(() => retired("/settings?tab=chat#bot"));
    expect(activePanel()).toBe("panel overlay"); expect(window.location.search).toBe("?tab=overlay");
    act(() => callbacks.navigate!("/settings?tab=chat#bot"));
    expect(activePanel()).toBe("panel chat"); expect(window.location.hash).toBe("#bot");
  });
  it("a retained discard callback cannot admit an older destination or cross owner A→B→A", () => {
    window.history.replaceState(null, "", "/settings?tab=preferences&ref=kept#notifications");
    const renderOwner = (ownerKey: string, requestedSearch: string) => <SettingsShell ownerKey={ownerKey} initialTab="preferences" requestedSearch={requestedSearch} renderTab={id => id === "preferences" ? <DirtyPanel id={id} /> : <p>panel {id}</p>} />;
    const view = render(renderOwner("a", "tab=preferences&ref=kept"));
    window.history.replaceState(null, "", "/settings?tab=overlay&section=dock");
    view.rerender(renderOwner("a", "tab=overlay&section=dock")); const oldDiscard = callbacks.confirm!;
    window.history.replaceState(null, "", "/settings?tab=help#help-section");
    view.rerender(renderOwner("a", "tab=help"));
    act(oldDiscard);
    expect(activePanel()).toBe("dirty preferences");
    expect(screen.getByRole("dialog", { name: "Discard unsaved changes?" })).toBeTruthy();
    const beforeOwner = callbacks.confirm!;
    view.rerender(renderOwner("b", "tab=help")); view.rerender(renderOwner("a", "tab=help"));
    act(beforeOwner);
    expect(activePanel()).toBe("dirty preferences");
    expect(screen.queryByRole("dialog", { name: "Discard unsaved changes?" })).toBeNull();
    expect(window.location.search).toBe("?tab=help");
  });
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
    expect(window.location.search).toBe("?tab=misc");
    expect(window.location.hash).toBe("");
    expect(activePanel()).toBe("dirty preferences");

    window.history.replaceState(null, "", "/settings?tab=foundation&ref=old#setup-health");
    view.rerender(shell("account", "preferences"));
    // The request prop did not change: a later intentional click still guards.
    fireEvent.click(screen.getAllByRole("tab", { name: "Account" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Discard & switch" }));
    expect(activePanel()).toBe("panel account");
    expect(window.location.search).toBe("?tab=account&ref=old");
  });

  it("guards a moved same-tab destination, restores the full old alias/hash on Stay and admits the new anchor on Discard", () => {
    window.history.replaceState(null, "", "/settings?tab=misc&ref=original#notifications");
    const view = render(shell("preferences", "preferences"));
    window.history.replaceState(null, "", "/settings?tab=overlay&section=chat&ref=incoming#twitch-automation");
    view.rerender(<SettingsShell initialTab="overlay" requestedSearch="tab=overlay&section=chat&ref=incoming" renderTab={id => id === "preferences" ? <DirtyPanel id={id} /> : <p>panel {id}</p>} />);
    expect(activePanel()).toBe("dirty preferences");
    fireEvent.click(screen.getByRole("button", { name: "Stay on this tab" }));
    expect(window.location.pathname + window.location.search + window.location.hash).toBe("/settings?tab=misc&ref=original#notifications");
    window.history.replaceState(null, "", "/settings?tab=overlay&section=dock&ref=next#stream-dock");
    view.rerender(<SettingsShell requestedSearch="tab=overlay&section=dock&ref=next" renderTab={id => id === "preferences" ? <DirtyPanel id={id} /> : <p>panel {id}</p>} />);
    fireEvent.click(screen.getByRole("button", { name: "Discard & switch" }));
    expect(activePanel()).toBe("panel chat");
    expect(window.location.pathname + window.location.search + window.location.hash).toBe("/settings?tab=chat&ref=next#stream-dock");
  });
});
