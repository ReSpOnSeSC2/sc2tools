import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Modal } from "../Modal";
import { MacroBreakdownPanel } from "@/components/analyzer/macro/MacroBreakdownPanel";

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "synthetic-owner" }) }));
vi.mock("@/lib/clientApi", () => ({
  useApi: (path: string | null) => ({
    data: path?.endsWith("/macro-breakdown") ? {
      macro_score: 60, race: "Protoss", raw: {}, game_length_sec: 300,
      stats_events: [{ time: 0, army_value: 0, food_workers: 12 }],
      opp_stats_events: [{ time: 0, army_value: 0, food_workers: 12 }],
    } : undefined,
    error: null, isLoading: false, mutate: vi.fn(), request: vi.fn(),
  }),
}));
vi.mock("@/components/analyzer/game/MapReplaySection", () => ({ MapReplaySection: () => <div>Unchanged replay boundary</div> }));

function PageLandmarks() {
  return <><header>Application navigation</header><footer>Application footer</footer></>;
}
function NestedDialogs() {
  const [child, setChild] = useState(false);
  return <><PageLandmarks />
    <Modal open onClose={() => undefined} title="Parent dialog" footer={<button type="button">Save parent</button>}>
      <button type="button" onClick={() => setChild(true)}>Open details</button>
      <Modal open={child} onClose={() => setChild(false)} title="Child details" footer={<button type="button" onClick={() => setChild(false)}>Done</button>}>
        <p>Selected detail</p>
      </Modal>
    </Modal>
  </>;
}
// The installed unit role mapper treats every native header/footer as a landmark.
// Apply the actual HTML scoping rule, not a dialog/class-based exclusion:
// https://www.w3.org/TR/html-aria/ (header/footer rows).
const SECTION_SCOPE = 'article,aside,main,nav,section,[role="article"],[role="complementary"],[role="main"],[role="navigation"],[role="region"]';
function documentLandmarks(role: "banner" | "contentinfo") {
  return screen.queryAllByRole(role).filter((node) => !(node.matches("header:not([role]),footer:not([role])") && node.parentElement?.closest(SECTION_SCOPE)));
}
function expectOnlyPageLandmarks() {
  expect(documentLandmarks("banner")).toEqual([screen.getByText("Application navigation")]);
  expect(documentLandmarks("contentinfo")).toEqual([screen.getByText("Application footer")]);
  for (const dialog of screen.getAllByRole("dialog")) {
    expect(documentLandmarks("banner").filter(node => dialog.contains(node))).toEqual([]);
    expect(documentLandmarks("contentinfo").filter(node => dialog.contains(node))).toEqual([]);
  }
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) { this.callback([{ target, contentRect: new DOMRect(0, 0, 600, 220) }] as ResizeObserverEntry[], this as unknown as ResizeObserver); }
    disconnect() {}
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("dialog grouping keeps document landmarks unique", () => {
  it("still detects unscoped dialog headers and explicit landmarks inside sections", () => {
    render(<><PageLandmarks /><div role="dialog" aria-label="Unscoped example"><header>Unscoped dialog header</header><footer>Unscoped dialog footer</footer></div>
      <section aria-label="Scoped example"><div role="banner">Explicit banner</div><div role="contentinfo">Explicit footer</div></section></>);
    expect(documentLandmarks("banner")).toEqual([screen.getByText("Application navigation"), screen.getByText("Unscoped dialog header"), screen.getByText("Explicit banner")]);
    expect(documentLandmarks("contentinfo")).toEqual([screen.getByText("Application footer"), screen.getByText("Unscoped dialog footer"), screen.getByText("Explicit footer")]);
  });

  it("retains both nested Modal headings, footer actions and focus without adding page landmarks", () => {
    render(<NestedDialogs />);
    const parent = screen.getByRole("dialog", { name: "Parent dialog" });
    expect(within(parent).getByRole("heading", { level: 2, name: "Parent dialog" })).toBeTruthy();
    expect(within(parent).getByRole("heading", { name: "Parent dialog" }).closest("header")?.getAttribute("role")).toBe("presentation");
    expect(within(parent).getByRole("button", { name: "Save parent" }).closest("footer")?.getAttribute("role")).toBe("presentation");
    expectOnlyPageLandmarks();
    const opener = within(parent).getByRole("button", { name: "Open details" }); opener.focus(); fireEvent.click(opener);
    const child = screen.getByRole("dialog", { name: "Child details" });
    expect(within(child).getByRole("heading", { level: 2, name: "Child details" })).toBeTruthy();
    expect(within(child).getByRole("heading", { name: "Child details" }).closest("header")?.getAttribute("role")).toBe("presentation");
    const done = within(child).getByRole("button", { name: "Done" });
    expect(done.closest("footer")?.getAttribute("role")).toBe("presentation");
    expectOnlyPageLandmarks();
    done.focus();
    expect(child.contains(document.activeElement)).toBe(true);
    fireEvent.click(done);
    expect(screen.queryByRole("dialog", { name: "Child details" })).toBeNull();
    expect(document.activeElement).toBe(opener);
    expectOnlyPageLandmarks();
  });

  it("keeps the Macro title, actions and real nested Probe detail accessible without banner/footer landmarks", () => {
    const onClose = vi.fn();
    render(<><PageLandmarks /><MacroBreakdownPanel open gameId="synthetic-game" onClose={onClose}
      headerMeta={{ playerName: "Player", opponentName: "Rival", myRace: "Protoss", opponentRace: "Terran" }} /></>);
    const panel = screen.getByRole("dialog", { name: /Player.*Rival/ });
    expect(within(panel).getByRole("heading", { level: 2, name: /Player.*Rival/ })).toBeTruthy();
    expect(within(panel).getByRole("heading", { name: /Player.*Rival/ }).closest("header")?.getAttribute("role")).toBe("presentation");
    expect(within(panel).getByRole("link", { name: "Open full game page" })).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "Recompute" }).closest("footer")?.getAttribute("role")).toBe("presentation");
    expectOnlyPageLandmarks();
    const probe = within(panel).getByRole("button", { name: "Probe — 12 on the field" }); probe.focus(); fireEvent.click(probe);
    const detail = screen.getByRole("dialog", { name: "Probe" });
    expect(within(detail).getByRole("heading", { level: 2, name: "Probe" })).toBeTruthy();
    expect(within(detail).getByRole("heading", { name: "Probe" }).closest("header")?.getAttribute("role")).toBe("presentation");
    expect(within(detail).getByText("12 on the field")).toBeTruthy();
    expectOnlyPageLandmarks();
    const detailClose = within(detail).getByRole("button", { name: "Close" }); detailClose.focus();
    expect(detail.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(detailClose, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Probe" })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(probe);
    fireEvent.click(within(panel).getByRole("button", { name: "Close macro breakdown" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
