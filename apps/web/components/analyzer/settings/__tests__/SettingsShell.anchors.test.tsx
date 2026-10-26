/**
 * SettingsShell and the URL hash: old hash-only links (`/settings#overlay`,
 * from before `?tab=`) open their tab and are rewritten to `?tab=`, and a
 * `#section` anchor scrolls to and highlights that section once its tab
 * is showing — including a section that only renders after its data
 * loads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect, useState } from "react";
import { SettingsShell, defaultTabVisibility, type SettingsTabId } from "../SettingsShell";
import { SECTION_FLASH_ATTR, SECTION_FLASH_MS } from "../revealSectionAnchor";

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn() }),
}));

function LateSection({ id }: { id: string }) {
  // Like a section that waits for its fetch before rendering.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setReady(true), 20);
    return () => window.clearTimeout(timer);
  }, []);
  return ready ? <div id={id}>late {id}</div> : <p>loading…</p>;
}

function renderPanel(id: SettingsTabId) {
  if (id === "overlay") {
    return (
      <>
        <p>panel overlay</p>
        <div id="platform-connections">Connected accounts</div>
      </>
    );
  }
  if (id === "voice") return <LateSection id="voice-readout" />;
  if (id === "help") return <div id="getting-started">panel help</div>;
  return <p>panel {id}</p>;
}

function shell(initialTab?: SettingsTabId, isTabVisible = defaultTabVisibility) {
  return <SettingsShell initialTab={initialTab} renderTab={renderPanel} isTabVisible={isTabVisible} />;
}

function activePanel() {
  return screen.getByRole("tabpanel").textContent;
}

let scrollIntoView: ReturnType<typeof vi.fn>;
const originalScroll = HTMLElement.prototype.scrollIntoView;

beforeEach(() => {
  scrollIntoView = vi.fn();
  HTMLElement.prototype.scrollIntoView = function(options) { if (typeof options === "object" && options.block === "nearest") return; scrollIntoView.call(this, options); };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  HTMLElement.prototype.scrollIntoView = originalScroll;
  window.history.replaceState(null, "", "/");
});

describe("SettingsShell legacy #tab links", () => {
  it.each([
    ["#overlay", "overlay", "panel overlay"],
    ["#profile", "profile", "panel profile"],
    ["#checkin", "checkin", "panel checkin"],
    ["#backups", "backups", "panel backups"],
    ["#streaming", "overlay", "panel overlay"],
    ["#foundation", "account", "panel account"],
    ["#account", "account", "panel account"],
    ["#misc", "preferences", "panel preferences"],
    ["#preferences", "preferences", "panel preferences"],
  ])("opens %s as ?tab=%s and drops the hash", (hash, tab, panel) => {
    window.history.replaceState(null, "", `/settings${hash}`);
    render(shell());
    expect(activePanel()).toContain(panel);
    expect(window.location.search).toBe(`?tab=${tab}`);
    expect(window.location.hash).toBe("");
  });

  it("keeps other params when rewriting", () => {
    window.history.replaceState(null, "", "/settings?ref=doctor#profile");
    render(shell());
    expect(activePanel()).toBe("panel profile");
    const params = new URLSearchParams(window.location.search);
    expect(params.get("tab")).toBe("profile");
    expect(params.get("ref")).toBe("doctor");
  });

  it("leaves a ?tab= link alone: its hash names a section", () => {
    window.history.replaceState(null, "", "/settings?tab=voice#overlay");
    render(shell("voice"));
    expect(activePanel()).toContain("loading");
    expect(window.location.search).toBe("?tab=voice");
    expect(window.location.hash).toBe("#overlay");
  });

  it("leaves a hash that names no tab alone", () => {
    window.history.replaceState(null, "", "/settings#platform-connections");
    render(shell());
    expect(activePanel()).toBe("panel account");
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("#platform-connections");
  });

  it("waits for a tab a caller temporarily hides", () => {
    window.history.replaceState(null, "", "/settings#import");
    const view = render(shell(undefined, (id) => id !== "import"));
    expect(activePanel()).toBe("panel account");
    expect(window.location.hash).toBe("#import");
    view.rerender(shell(undefined, () => true));
    expect(activePanel()).toBe("panel import");
    expect(window.location.search).toBe("?tab=import");
    expect(window.location.hash).toBe("");
  });

  it("stays on the rewritten tab when the URL catches up", () => {
    window.history.replaceState(null, "", "/settings#overlay");
    const view = render(shell());
    // Next.js feeds the rewritten ?tab=overlay back as a new initialTab.
    view.rerender(shell("overlay"));
    expect(activePanel()).toContain("panel overlay");
  });
});

describe("SettingsShell #section anchors", () => {
  it("gives mobile triggers real panel IDs and keyboard activation", () => {
    render(shell("backups"));
    const mobile = screen.getAllByRole("tablist", { name: "Settings sections" })[0];
    const active = within(mobile).getByRole("tab", { name: /Backups/ });
    const panel = screen.getByRole("tabpanel");
    expect(active.getAttribute("aria-controls")).toBe(panel.id);
    expect(active.tabIndex).toBe(0);
    fireEvent.keyDown(active, { key: "Home" });
    expect(document.activeElement?.getAttribute("aria-selected")).toBe("true");
    expect(activePanel()).toContain("panel account");
  });
  it("scrolls to and highlights the section once its tab is showing", () => {
    vi.useFakeTimers();
    window.history.replaceState(null, "", "/settings?tab=overlay#platform-connections");
    render(shell("overlay"));
    const section = document.getElementById("platform-connections") as HTMLElement;
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(section);
    expect(section.getAttribute(SECTION_FLASH_ATTR)).toBe("on");
    // The anchor stays in the URL, so a refresh lands in the same place.
    expect(window.location.hash).toBe("#platform-connections");
    act(() => {
      vi.advanceTimersByTime(SECTION_FLASH_MS);
    });
    expect(section.getAttribute(SECTION_FLASH_ATTR)).toBe("fading");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(section.hasAttribute(SECTION_FLASH_ATTR)).toBe(false);
  });

  it("waits for a section that renders after its data loads", async () => {
    window.history.replaceState(null, "", "/settings?tab=voice#voice-readout");
    render(shell("voice"));
    expect(scrollIntoView).not.toHaveBeenCalled();
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    expect(scrollIntoView.mock.contexts[0]).toBe(document.getElementById("voice-readout"));
  });

  it("stops waiting once the player starts using the page", async () => {
    window.history.replaceState(null, "", "/settings?tab=voice#voice-readout");
    render(shell("voice"));
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    });
    await screen.findByText("late voice-readout");
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("scrolls to the section a URL tab switch names", () => {
    window.history.replaceState(null, "", "/settings?tab=checkin");
    const view = render(shell("checkin"));
    expect(scrollIntoView).not.toHaveBeenCalled();
    window.history.replaceState(null, "", "/settings?tab=overlay#platform-connections");
    view.rerender(shell("overlay"));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("follows a later #anchor change on the same tab", () => {
    window.history.replaceState(null, "", "/settings?tab=overlay");
    render(shell("overlay"));
    expect(scrollIntoView).not.toHaveBeenCalled();
    act(() => {
      window.history.replaceState(null, "", "/settings?tab=overlay#platform-connections");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("leaves Help's article anchors to Help", () => {
    window.history.replaceState(null, "", "/settings?tab=help#getting-started");
    render(shell("help"));
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(document.getElementById("getting-started")?.hasAttribute(SECTION_FLASH_ATTR)).toBe(false);
  });

  it("leaves Skip to content and other chrome anchors outside the active panel alone", () => {
    window.history.replaceState(null, "", "/settings?tab=overlay#main-content");
    render(<main id="main-content" tabIndex={-1}>{shell("overlay")}<footer id="footer-links">Footer</footer></main>);
    const main = screen.getByRole("main");
    expect(main.hasAttribute(SECTION_FLASH_ATTR)).toBe(false);
    expect(scrollIntoView).not.toHaveBeenCalled();
    act(() => {
      window.history.replaceState(null, "", "/settings?tab=overlay#footer-links");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(document.getElementById("footer-links")?.hasAttribute(SECTION_FLASH_ATTR)).toBe(false);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
