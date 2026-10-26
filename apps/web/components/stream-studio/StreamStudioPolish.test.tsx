import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import StreamStudioCtas from "../landing/StreamStudioAuthCtas";
import { StreamManagerShowcase } from "../landing/StreamManagerShowcase";
import { FEATURE_GROUPS } from "../landing/StreamStudioPage";
import { STREAMS_MIN_AGENT_VERSION } from "@/lib/agentNotice";
import { WIDGET_GUIDES } from "@/lib/streamStudioLearn";
import { CrashCourse } from "./CrashCourse";
import { WidgetExplorer } from "./WidgetExplorer";
import { LearnSectionNav } from "./LearnSectionNav";
const auth = vi.hoisted(() => ({ isLoaded: false, isSignedIn: false }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => auth,
  SignedIn: ({ children }: { children: ReactNode }) => auth.isSignedIn ? children : null,
  SignedOut: ({ children }: { children: ReactNode }) => auth.isSignedIn ? null : children,
}));
beforeEach(() => { auth.isLoaded = false; auth.isSignedIn = false; localStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it("preserves useful signed-out SSR while Clerk loads and shows all signed-in shortcuts", () => {
  expect(renderToString(<StreamStudioCtas />)).toContain("Download the free agent");
  const view = render(<StreamStudioCtas />); expect(screen.getByRole("link", { name: "Create a free account" })).toBeTruthy();
  auth.isLoaded = true; auth.isSignedIn = true; view.rerender(<StreamStudioCtas />);
  expect(screen.getByRole("link", { name: "Open Overlay settings" }).getAttribute("href")).toBe("/settings?tab=overlay");
  expect(screen.getByRole("link", { name: "Set up my Stream Dock" }).getAttribute("href")).toBe("/settings?tab=overlay#stream-dock");
  expect(screen.getByRole("link", { name: "Continue the crash course" }).getAttribute("href")).toBe("/stream-studio/learn#crash-course");
  expect(screen.queryByRole("link", { name: "Create a free account" })).toBeNull();
});
it("shows shipped desktop copy and every linked feature has a real guide", () => {
  render(<StreamManagerShowcase />);
  expect(screen.getByText("In the desktop app")).toBeTruthy();
  expect(screen.getByText(`Included in the desktop app since ${STREAMS_MIN_AGENT_VERSION}. Update from the tray or the download page.`)).toBeTruthy();
  const ids = new Set(WIDGET_GUIDES.map((g) => g.id));
  for (const group of FEATURE_GROUPS) for (const item of group.items) if (item.guideId) expect(ids.has(item.guideId as typeof WIDGET_GUIDES[number]["id"])).toBe(true);
});
it.each([true, false])("opens gallery after hydration only when desktop matches=%s", (matches) => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches })));
  expect(renderToString(<WidgetExplorer />)).not.toMatch(/<details[^>]*open/);
  render(<WidgetExplorer />);
  expect((screen.getByText("Browse widget previews").closest("details") as HTMLDetailsElement).open).toBe(matches);
});
it("restores the full course position/checklist with Undo and expires it at eight seconds", () => {
  vi.useFakeTimers(); render(<CrashCourse />);
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "Next lesson" }));
  fireEvent.click(screen.getByRole("button", { name: "Reset course progress" }));
  expect(screen.getByText(/0 of 6 lessons/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("Pair your gaming PC");
  expect(JSON.parse(localStorage.getItem("sc2tools:stream-studio:crash-course:v1")!)).toEqual({ activeId: "pair-your-pc", completed: ["connect-the-dots"] });
  fireEvent.click(screen.getByRole("button", { name: "Reset course progress" }));
  act(() => vi.advanceTimersByTime(8000)); expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
});
it("updates aria-current from intersections and disconnects without animated scrolling", () => {
  let callback: IntersectionObserverCallback;
  const observe = vi.fn(); const disconnect = vi.fn();
  vi.stubGlobal("IntersectionObserver", class { constructor(cb: IntersectionObserverCallback) { callback = cb; } observe = observe; disconnect = disconnect; });
  const view = render(<><LearnSectionNav />{["crash-course", "starter-setups", "widget-library", "troubleshooting"].map((id) => <section key={id} id={id} />)}</>);
  expect(observe).toHaveBeenCalledTimes(4);
  act(() => callback([{ target: document.getElementById("widget-library")!, isIntersecting: true, boundingClientRect: { top: 120 } } as unknown as IntersectionObserverEntry], {} as IntersectionObserver));
  expect(screen.getByRole("link", { name: "Widget guide" }).getAttribute("aria-current")).toBe("true");
  expect(screen.getByRole("link", { name: "Crash course" }).hasAttribute("aria-current")).toBe(false);
  const prior = document.getElementById("starter-setups")!;
  const next = document.getElementById("widget-library")!;
  vi.spyOn(prior, "getBoundingClientRect").mockReturnValue({ top: -564.875 } as DOMRect);
  vi.spyOn(next, "getBoundingClientRect").mockReturnValue({ top: 112.125 } as DOMRect);
  act(() => callback([
    { target: prior, isIntersecting: true }, { target: next, isIntersecting: true },
  ] as unknown as IntersectionObserverEntry[], {} as IntersectionObserver));
  expect(screen.getByRole("link", { name: "Widget guide" }).getAttribute("aria-current")).toBe("true");
  view.unmount(); expect(disconnect).toHaveBeenCalled();
});
