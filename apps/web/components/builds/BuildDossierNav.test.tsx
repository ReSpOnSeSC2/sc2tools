import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BuildDossierNav } from "./BuildDossierNav";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState({}, "", "/"); });
it("registers optional timing and plan anchors only while their sections exist", () => {
  const view = render(<BuildDossierNav insights plan />);
  expect(screen.getAllByRole("link").map(link => link.getAttribute("href"))).toEqual(["#overview", "#timings", "#plan", "#army", "#matchups", "#games"]);
  fireEvent.click(screen.getByRole("link", { name: "Plan survival" }));
  view.rerender(<BuildDossierNav insights />);
  expect(screen.queryByRole("link", { name: "Plan survival" })).toBeNull();
  expect(screen.getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBe("location");
});
it("observes native page sections and updates the active anchor from scrolling or a click", () => {
  let onIntersect: IntersectionObserverCallback = () => undefined;
  const observe = vi.fn(); const disconnect = vi.fn();
  vi.stubGlobal("IntersectionObserver", class { constructor(callback: IntersectionObserverCallback) { onIntersect = callback; } observe = observe; disconnect = disconnect; });
  const view = render(<><BuildDossierNav />{["overview", "army", "matchups", "games"].map((id) => <section id={id} key={id}>{id}</section>)}</>);
  expect(observe).toHaveBeenCalledTimes(4);
  const games = screen.getByRole("link", { name: "Games" });
  act(() => onIntersect([{ target: document.getElementById("games")!, isIntersecting: true, boundingClientRect: new DOMRect(0, 100, 100, 100), intersectionRect: new DOMRect(), intersectionRatio: 1, rootBounds: null, time: 0 }], {} as IntersectionObserver));
  expect(games.getAttribute("aria-current")).toBe("location");
  fireEvent.click(screen.getByRole("link", { name: "Army" }));
  expect(screen.getByRole("link", { name: "Army" }).getAttribute("aria-current")).toBe("location");
  expect(games.hasAttribute("aria-current")).toBe(false);
  view.unmount(); expect(disconnect).toHaveBeenCalledOnce();
});
