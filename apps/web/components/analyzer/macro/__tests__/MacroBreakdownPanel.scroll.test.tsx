import { StrictMode, useState, type AnchorHTMLAttributes } from "react";
import { flushSync } from "react-dom";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MacroBreakdownPanel } from "../MacroBreakdownPanel";

const navigationDispatched = vi.hoisted(() => vi.fn());
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "synthetic-owner" }) }));
vi.mock("@/lib/clientApi", () => ({ useApi: (path: string | null) => ({
  data: path?.endsWith("/macro-breakdown") ? { macro_score: 60, race: "Protoss", raw: {}, game_length_sec: 300,
    stats_events: [{ time: 0, army_value: 0, food_workers: 12 }], opp_stats_events: [{ time: 0, army_value: 0, food_workers: 12 }] } : undefined,
  error: null, isLoading: false, mutate: vi.fn(), request: vi.fn(),
}) }));
vi.mock("@/components/analyzer/game/MapReplaySection", () => ({ MapReplaySection: () => <div>Replay boundary</div> }));
// Verified installed Next15.5 Link contract: user click first; only unmodified
// navigation calls onNavigate, before router dispatch. No actual navigation here.
vi.mock("next/link", () => ({ default: ({ onNavigate, onClick, prefetch, scroll, replace, href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & {
  onNavigate?: (event: { preventDefault: () => void }) => void; prefetch?: unknown; scroll?: unknown; replace?: unknown;
}) => {
  void prefetch; void scroll; void replace;
  return <a {...props} href={href} onClick={event => {
    onClick?.(event);
    const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0;
    const prevented = event.defaultPrevented;
    event.preventDefault(); // Cancel jsdom's unimplemented browser navigation.
    if (modified || prevented) return;
    let cancelled = false;
    onNavigate?.({ preventDefault: () => { cancelled = true; } });
    if (!cancelled) navigationDispatched();
  }}>{children}</a>;
} }));

let x = 24, y = 180;
const originalHref = window.location.href;
const originalX = Object.getOwnPropertyDescriptor(window, "scrollX");
const originalY = Object.getOwnPropertyDescriptor(window, "scrollY");
const originalOverflow = document.body.style.overflow;
const scrollTo = vi.fn();
const META = { playerName: "Player", opponentName: "Rival", myRace: "Protoss", opponentRace: "Terran" };
function Harness({ conditional = false, mounted = true, showOpener = true, gameId = "first", syncClose = false }: {
  conditional?: boolean; mounted?: boolean; showOpener?: boolean; gameId?: string; syncClose?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const close = () => { if (syncClose) flushSync(() => setOpen(false)); else setOpen(false); };
  return <>{showOpener ? <button type="button" onClick={() => setOpen(true)}>Open Macro</button> : null}
    {mounted && (!conditional || open) ? <MacroBreakdownPanel open={open} onClose={close} gameId={gameId} headerMeta={META} /> : null}
  </>;
}
function openPanel() {
  const opener = screen.getByRole("button", { name: "Open Macro" }); opener.focus(); fireEvent.click(opener);
  act(() => { vi.advanceTimersByTime(0); });
  return opener;
}
function closePanel() { fireEvent.click(screen.getByRole("button", { name: "Close macro breakdown" })); }
function drift() { x = 37; y = 205; }

beforeEach(() => {
  vi.useFakeTimers(); x = 24; y = 180; scrollTo.mockReset(); navigationDispatched.mockReset();
  Object.defineProperty(window, "scrollX", { configurable: true, get: () => x });
  Object.defineProperty(window, "scrollY", { configurable: true, get: () => y });
  scrollTo.mockImplementation((options: ScrollToOptions) => { x = options.left ?? x; y = options.top ?? y; });
  vi.spyOn(window, "scrollTo").mockImplementation(scrollTo);
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) { this.callback([{ target, contentRect: new DOMRect(0, 0, 600, 220) }] as ResizeObserverEntry[], this as unknown as ResizeObserver); }
    disconnect() {}
  });
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  document.body.style.overflow = originalOverflow;
  if (originalX) Object.defineProperty(window, "scrollX", originalX);
  if (originalY) Object.defineProperty(window, "scrollY", originalY);
  history.replaceState(null, "", originalHref);
});

describe("Macro returns to the same background page", () => {
  it("restores both original axes and focus on ordinary conditional unmount", () => {
    document.body.style.overflow = "scroll";
    render(<Harness conditional />); const opener = openPanel(); const focus = vi.spyOn(opener, "focus"); drift(); closePanel();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true }); expect(document.activeElement).toBe(opener);
    expect(scrollTo).toHaveBeenCalledTimes(1); expect(scrollTo).toHaveBeenCalledWith({ left: 24, top: 180, behavior: "instant" });
    expect([x, y]).toEqual([24, 180]); expect(document.body.style.overflow).toBe("scroll"); document.body.style.overflow = "";
  });

  it("restores the original position on Escape without a receiving open=false render", () => {
    render(<Harness conditional />); const opener = openPanel(); drift();
    fireEvent.keyDown(screen.getByRole("button", { name: "Close macro breakdown" }), { key: "Escape" });
    expect(scrollTo).toHaveBeenCalledWith({ left: 24, top: 180, behavior: "instant" }); expect(document.activeElement).toBe(opener);
  });

  it("does not scroll during passive rerenders or game changes, and keeps the first open origin", () => {
    const view = render(<Harness />); openPanel(); drift(); view.rerender(<Harness gameId="second" />);
    act(() => { vi.advanceTimersByTime(0); }); expect(scrollTo).not.toHaveBeenCalled();
    closePanel(); expect(scrollTo).toHaveBeenCalledTimes(1); expect(scrollTo).toHaveBeenCalledWith({ left: 24, top: 180, behavior: "instant" });
  });

  it("does not pull position or focus back after the URL changes", () => {
    render(<Harness />); const opener = openPanel(); const focus = vi.spyOn(opener, "focus"); drift();
    history.pushState(null, "", "/different-page?view=next#macro"); closePanel();
    expect(scrollTo).not.toHaveBeenCalled(); expect(focus).not.toHaveBeenCalled(); expect([x, y]).toEqual([37, 205]);
  });

  it("marks real full-game navigation before synchronous close while the old href is still pending", () => {
    render(<Harness conditional syncClose />); const opener = openPanel(); const focus = vi.spyOn(opener, "focus"); drift(); const href = location.href;
    fireEvent.click(screen.getByRole("link", { name: "Open full game page" }));
    expect(navigationDispatched).toHaveBeenCalledTimes(1); expect(location.href).toBe(href);
    expect(screen.queryByRole("dialog")).toBeNull(); expect(scrollTo).not.toHaveBeenCalled(); expect(focus).not.toHaveBeenCalled();
  });

  it("keeps a modified click as an ordinary current-page close", () => {
    render(<Harness conditional />); const opener = openPanel(); drift();
    fireEvent.click(screen.getByRole("link", { name: "Open full game page" }), { ctrlKey: true });
    expect(navigationDispatched).not.toHaveBeenCalled(); expect(document.activeElement).toBe(opener);
    expect(scrollTo).toHaveBeenCalledWith({ left: 24, top: 180, behavior: "instant" });
  });

  it("resets navigation intent and captures a new origin when reopened", () => {
    render(<Harness />); openPanel(); drift(); fireEvent.click(screen.getByRole("link", { name: "Open full game page" }));
    expect(scrollTo).not.toHaveBeenCalled(); openPanel(); x = 42; y = 333; closePanel();
    expect(scrollTo).toHaveBeenCalledTimes(1); expect(scrollTo).toHaveBeenCalledWith({ left: 37, top: 205, behavior: "instant" });
  });

  it("restores same-page coordinates even when the opener was removed, without focusing it", () => {
    const view = render(<Harness />); const opener = openPanel(); const focus = vi.spyOn(opener, "focus"); drift();
    view.rerender(<Harness showOpener={false} />); expect(opener.isConnected).toBe(false); closePanel();
    expect(focus).not.toHaveBeenCalled(); expect(scrollTo).toHaveBeenCalledWith({ left: 24, top: 180, behavior: "instant" });
  });

  it("keeps child Escape local and restores the origin when a parent with a child is unmounted", () => {
    const view = render(<Harness />); const opener = openPanel(); drift();
    const probe = screen.getByRole("button", { name: "Probe — 12 on the field" }); probe.focus(); fireEvent.click(probe);
    let child = screen.getByRole("dialog", { name: "Probe" }); fireEvent.keyDown(within(child).getByRole("button", { name: "Close" }), { key: "Escape" });
    expect(scrollTo).not.toHaveBeenCalled(); expect(document.body.style.overflow).toBe("hidden");
    fireEvent.click(probe); child = screen.getByRole("dialog", { name: "Probe" }); expect(child).toBeTruthy();
    view.rerender(<Harness mounted={false} />); expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.style.overflow).toBe(""); expect(document.activeElement).toBe(opener);
    expect(scrollTo).toHaveBeenCalledTimes(1); expect(scrollTo).toHaveBeenCalledWith({ left: 24, top: 180, behavior: "instant" });
  });

  it("does not introduce passive scroll writes during StrictMode's repeated setup", () => {
    render(<StrictMode><Harness conditional /></StrictMode>); openPanel(); expect(scrollTo).not.toHaveBeenCalled(); drift(); closePanel();
    expect(scrollTo).toHaveBeenCalledWith({ left: 24, top: 180, behavior: "instant" });
  });
});
