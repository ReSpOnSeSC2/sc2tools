import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { NavProgress } from "../NavProgress";
const route = vi.hoisted(() => ({ path: "/", search: "" }));
vi.mock("next/navigation", () => ({ usePathname: () => route.path, useSearchParams: () => new URLSearchParams(route.search) }));
beforeEach(() => { route.path = "/"; route.search = ""; vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
it("starts on a plain internal link and uses a static bar for reduced motion", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  const view = render(<><a href="/other">Other</a><NavProgress /></>);
  // Prevent browser navigation after the progress listener has observed the click.
  const prevent = (event: MouseEvent) => event.preventDefault(); document.addEventListener("click", prevent);
  fireEvent.click(view.container.querySelector("a")!); act(() => vi.advanceTimersByTime(150));
  const bar = view.container.querySelector<HTMLElement>("[data-nav-progress]")!;
  expect(bar.style.width).toBe("100%"); expect(bar.style.transition).toBe("none");
  document.removeEventListener("click", prevent); vi.unstubAllGlobals();
});
it("delays feedback, completes on a route change, and times out cancelled navigation", () => {
  const pending = vi.fn(); const view = render(<><a href="/next">Next</a><NavProgress onPendingChange={pending} /></>);
  const link = view.container.querySelector("a")!; link.addEventListener("click", (event) => event.preventDefault());
  act(() => window.dispatchEvent(new Event("sc2tools:navigation-start"))); act(() => vi.advanceTimersByTime(149)); expect(view.container.querySelector("[data-nav-progress]")).toBeNull();
  act(() => vi.advanceTimersByTime(1)); expect(view.container.querySelector("[data-nav-progress]")).toBeTruthy();
  route.path = "/next"; view.rerender(<><a href="/next">Next</a><NavProgress onPendingChange={pending} /></>); act(() => vi.advanceTimersByTime(200)); expect(view.container.querySelector("[data-nav-progress]")).toBeNull(); expect(pending).toHaveBeenLastCalledWith(false);
  act(() => window.dispatchEvent(new Event("sc2tools:navigation-start"))); act(() => vi.advanceTimersByTime(15000)); expect(view.container.querySelector("[data-nav-progress]")).toBeNull();
});
it("ignores modified, external, hash and new-tab links", () => {
  const view = render(<><a href="/next">Internal</a><a href="https://example.com">External</a><a href="#anchor">Hash</a><a href="/next" target="_blank">New tab</a><NavProgress /></>);
  const links = view.container.querySelectorAll("a"); fireEvent.click(links[0], { ctrlKey: true }); fireEvent.click(links[1]); fireEvent.click(links[2]); fireEvent.click(links[3]);
  act(() => vi.advanceTimersByTime(500)); expect(view.container.querySelector("[data-nav-progress]")).toBeNull();
});
