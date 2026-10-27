import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CommandSearchContext, type CommandSearchContextValue, type CommandSettings,
} from "@/components/chrome/CommandSearchContext";
import { SettingsShell, type SettingsTabId } from "../SettingsShell";
import { usePublishDirty } from "../SettingsContext";
import { SECTION_FLASH_ATTR } from "../revealSectionAnchor";

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", async importOriginal => ({
  ...await importOriginal<typeof import("next/navigation")>(), useRouter: () => router,
}));

// Capture the real committed Shell registration. The context registrar neither
// implements navigation nor replaces the real dirty-state/confirmation guard.
let registration: CommandSettings | null = null;
const registerSettings = vi.fn((config: CommandSettings) => {
  registration = config;
  return () => { if (registration === config) registration = null; };
});
const ANCHORS: Partial<Record<SettingsTabId, string>> = {
  preferences: "notifications", profile: "pulse-ids", help: "sessions", voice: "voice-readout",
};

function DraftPanel({ id }: { id: SettingsTabId }) {
  const [value, setValue] = useState("saved");
  usePublishDirty(id, value !== "saved");
  return <>
    <p data-testid="current-settings-panel">{id}</p>
    <label>{id} draft<input value={value} onChange={event => setValue(event.target.value)} /></label>
    <section id={ANCHORS[id] ?? `${id}-section`}>{id} section</section>
  </>;
}

function tree(ownerKey = "owner-a", isTabVisible?: (id: SettingsTabId) => boolean) {
  const context: CommandSearchContextValue = {
    ownerKey, open: () => {}, registerChrome: () => () => {}, registerSettings,
  };
  return <CommandSearchContext.Provider value={context}>
    <SettingsShell initialTab="preferences" ownerKey={ownerKey} isTabVisible={isTabVisible}
      renderTab={id => <DraftPanel key={`${ownerKey}:${id}`} id={id} />} />
  </CommandSearchContext.Provider>;
}
function current() {
  if (!registration) throw new Error("Expected actual committed Settings registration");
  return registration;
}
function draft(id = "preferences"): HTMLInputElement {
  return screen.getByRole("textbox", { name: `${id} draft` }) as HTMLInputElement;
}
function edit(value = "unsaved draft") {
  const input = draft(); fireEvent.change(input, { target: { value } }); return input;
}
function command(href: string) { act(() => current().navigate(href)); }
function guard() { return screen.getByRole("dialog", { name: "Discard unsaved changes?" }); }
function stay() { fireEvent.click(screen.getByRole("button", { name: "Stay on this tab" })); }
function discard() { fireEvent.click(screen.getByRole("button", { name: "Discard & switch" })); }
function panel() { return screen.getByTestId("current-settings-panel").textContent; }
function href() { return window.location.pathname + window.location.search + window.location.hash; }

beforeEach(() => {
  router.push.mockReset(); registerSettings.mockClear(); registration = null;
  window.history.replaceState(null, "", "/settings?tab=preferences&ref=command#notifications");
});
afterEach(() => { cleanup(); registration = null; window.history.replaceState(null, "", "/"); });

describe("real SettingsShell command-search admission", () => {
  it("keeps the exact draft, tab and complete URL on Stay, then reveals the chosen Settings section on Discard", () => {
    render(tree());
    const input = edit("keep my notification draft"), before = window.location.href;
    expect(current().ownerKey).toBe("owner-a");
    command("/settings?tab=profile#pulse-ids");
    expect(guard()).toBeTruthy(); expect(panel()).toBe("preferences");
    expect(window.location.href).toBe(before); expect(input.value).toBe("keep my notification draft");
    stay();
    expect(screen.queryByRole("dialog")).toBeNull(); expect(draft()).toBe(input);
    expect(input.value).toBe("keep my notification draft"); expect(window.location.href).toBe(before);
    command("/settings?tab=profile#pulse-ids"); discard();
    expect(screen.queryByRole("dialog")).toBeNull(); expect(panel()).toBe("profile");
    expect(href()).toBe("/settings?tab=profile#pulse-ids");
    expect(document.getElementById("pulse-ids")?.getAttribute(SECTION_FLASH_ATTR)).toBe("on");
    expect(router.push).not.toHaveBeenCalled();
  });

  it("blocks an external Help route until Discard and leaves the draft intact on Stay", () => {
    render(tree()); const input = edit("retain before leaving Settings"), before = window.location.href;
    command("/help/sessions");
    expect(guard()).toBeTruthy(); expect(router.push).not.toHaveBeenCalled(); expect(window.location.href).toBe(before);
    stay();
    expect(draft()).toBe(input); expect(input.value).toBe("retain before leaving Settings");
    expect(window.location.href).toBe(before); expect(panel()).toBe("preferences");
    command("/help/sessions"); discard();
    expect(router.push).toHaveBeenCalledTimes(1); expect(router.push).toHaveBeenCalledWith("/help/sessions");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("retires an owner-A callback across A→B→A without navigating or closing the new owner's guard", () => {
    const view = render(tree()); edit("first owner lifetime");
    const retired = current().navigate;
    command("/settings?tab=profile#pulse-ids"); expect(guard()).toBeTruthy();
    view.rerender(tree("owner-b")); expect(screen.queryByRole("dialog")).toBeNull();
    expect(current().ownerKey).toBe("owner-b");
    view.rerender(tree("owner-a")); const input = edit("new owner-A lifetime");
    command("/settings?tab=help#sessions"); const newerGuard = guard(), before = window.location.href;
    act(() => {
      retired("/help/sessions");
      retired("/settings?tab=profile#pulse-ids");
    });
    expect(guard()).toBe(newerGuard); expect(router.push).not.toHaveBeenCalled();
    expect(window.location.href).toBe(before); expect(input.value).toBe("new owner-A lifetime");
    discard();
    expect(panel()).toBe("help"); expect(href()).toBe("/settings?tab=help#sessions");
    expect(router.push).not.toHaveBeenCalled();
  });

  it("omits unavailable tabs and ignores their commands without invalidating a valid pending guard", () => {
    const visible = (id: SettingsTabId) => id !== "voice";
    render(tree("owner-a", visible)); const input = edit(), before = window.location.href;
    expect(current().tabs).not.toContain("voice"); expect(screen.queryByRole("tab", { name: "Voice" })).toBeNull();
    command("/settings?tab=voice#voice-readout");
    expect(screen.queryByRole("dialog")).toBeNull(); expect(window.location.href).toBe(before);
    expect(input.value).toBe("unsaved draft");
    command("/settings?tab=profile#pulse-ids"); const pending = guard();
    command("/settings?tab=voice#voice-readout");
    expect(guard()).toBe(pending); expect(window.location.href).toBe(before);
    stay(); expect(screen.queryByRole("dialog")).toBeNull(); expect(draft()).toBe(input);
    command("/settings?tab=profile#pulse-ids");
    command("/settings?tab=voice#voice-readout"); discard();
    expect(panel()).toBe("profile"); expect(href()).toBe("/settings?tab=profile#pulse-ids");
    expect(router.push).not.toHaveBeenCalled();
  });

  it("preserves the mounted draft on repeated same-tab targets and still guards the next tab change", () => {
    render(tree()); const input = edit("same tab draft"), target = href();
    command(target); command(target);
    expect(screen.queryByRole("dialog")).toBeNull(); expect(draft()).toBe(input);
    expect(input.value).toBe("same tab draft"); expect(href()).toBe(target);
    expect(panel()).toBe("preferences"); expect(router.push).not.toHaveBeenCalled();
    command("/settings?tab=profile#pulse-ids"); expect(guard()).toBeTruthy();
    stay(); expect(input.value).toBe("same tab draft"); expect(href()).toBe(target);
  });

  it("navigates directly with a clean current registration and retires the callback on unmount", () => {
    const view = render(tree()); command("/help/sessions");
    expect(screen.queryByRole("dialog")).toBeNull(); expect(router.push).toHaveBeenCalledWith("/help/sessions");
    const retired = current().navigate; router.push.mockClear();
    view.unmount(); expect(registration).toBeNull();
    act(() => retired("/help/sessions")); expect(router.push).not.toHaveBeenCalled();
  });
});
