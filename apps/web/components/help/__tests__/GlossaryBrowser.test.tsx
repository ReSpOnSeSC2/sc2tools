import type { AnchorHTMLAttributes } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { GLOSSARY } from "@/lib/glossary";
import article from "@/lib/help/articles/analyzer/glossary";
import { HelpArticleBody } from "../HelpArticleBody";
import { GlossaryBrowser } from "../GlossaryBrowser";
vi.mock("next/link", () => ({ default: ({ children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a> }));
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
const initialUrl = window.location.href;
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (originalScroll) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScroll);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  history.replaceState(history.state, "", initialUrl);
});

function heldNavigation(variant: "page" | "compact" = "page") {
  const frames: FrameRequestCallback[] = [], scroll = vi.fn();
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { frames.push(callback); return frames.length; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
  const content = (mode: "page" | "compact") => <><GlossaryBrowser variant={mode} /><button type="button">Outside action</button></>;
  const view = render(content(variant));
  const input = screen.getByRole("textbox", { name: "Search glossary" });
  fireEvent.change(input, { target: { value: "look-alike" } });
  const related = screen.getByRole("link", { name: "Pulse ID", exact: true });
  related.focus(); fireEvent.click(related);
  expect(frames).toHaveLength(1);
  return { ...view, input, related, scroll,
    changeVariant: () => view.rerender(content("compact")),
    release: () => act(() => { frames.splice(0).forEach(callback => callback(0)); }),
  };
}

it("sorts the canonical terms A to Z, filters definition text and clears with Escape", () => {
  render(<GlossaryBrowser />);
  expect(screen.getAllByRole("term").map(node => node.textContent)).toEqual([...GLOSSARY].sort((a, b) => a.term.localeCompare(b.term, "en")).map(term => term.term));
  expect(screen.getByRole("navigation", { name: "Glossary A to Z" })).toBeTruthy();
  const input = screen.getByRole("textbox", { name: "Search glossary" });
  fireEvent.change(input, { target: { value: "LOOK-ALIKE" } });
  expect(screen.getAllByRole("term").map(node => node.textContent)).toEqual(["Barcode"]); expect(screen.getByRole("status").textContent).toBe("1 term");
  fireEvent.change(input, { target: { value: "no glossary definition matches" } }); expect(screen.getByText(/No terms match/)).toBeTruthy();
  fireEvent.keyDown(input, { key: "Escape" }); expect(screen.getAllByRole("term")).toHaveLength(7);
});

it("keeps all published term IDs and contextual links through the real article renderer", () => {
  const { container } = render(<HelpArticleBody article={article} />);
  for (const term of GLOSSARY) {
    const entry = container.querySelector(`[id="${term.id}"]`)!;
    expect(entry, term.id).not.toBeNull();
    expect(within(entry as HTMLElement).getByRole("term").textContent).toBe(term.term);
    expect(within(entry as HTMLElement).getByRole("link", { name: `Read ${term.term} in context` }).getAttribute("href")).toMatch(/^\/help\//);
  }
});

it("keeps compact Help anchors local instead of duplicating public IDs", () => {
  const { container } = render(<><HelpArticleBody article={article} variant="compact" /><HelpArticleBody article={article} variant="compact" /></>);
  for (const term of GLOSSARY) {
    expect(container.querySelector(`[id="${term.id}"]`)).toBeNull();
    expect(container.querySelectorAll(`[data-help-anchor="${term.id}"]`)).toHaveLength(2);
  }
  const ids = Array.from(container.querySelectorAll("[id]")).map(node => node.id);
  expect(new Set(ids).size).toBe(ids.length);
});

it.each(["page", "compact"] as const)("retires queued %s Related navigation when the reader returns to search, even while its target remains", (variant) => {
  const view = heldNavigation(variant), replace = vi.spyOn(history, "replaceState");
  view.input.focus(); fireEvent.change(view.input, { target: { value: "player" } });
  const target = view.container.querySelector<HTMLElement>('[data-glossary-id="pulse-id"]');
  expect(target).not.toBeNull();
  view.release();
  expect(document.activeElement).toBe(view.input);
  expect((view.input as HTMLInputElement).value).toBe("player");
  expect(view.scroll).not.toHaveBeenCalled(); expect(replace).not.toHaveBeenCalled();
});

it.each(["page", "compact"] as const)("keeps explicit %s Related navigation when it still owns the action", (variant) => {
  const view = heldNavigation(variant), replace = vi.spyOn(history, "replaceState");
  const target = view.container.querySelector<HTMLElement>('[data-glossary-id="pulse-id"]');
  view.release();
  expect(document.activeElement).toBe(target); expect(view.scroll).toHaveBeenCalledTimes(1);
  expect((view.input as HTMLInputElement).value).toBe("");
  if (variant === "page") expect(replace).toHaveBeenCalledWith(history.state, "", "#pulse-id");
  else expect(replace).not.toHaveBeenCalled();
});

it.each(["focus", "variant", "new action", "unmount"] as const)("does not apply a queued Related frame after %s retirement", (change) => {
  const view = heldNavigation(), replace = vi.spyOn(history, "replaceState");
  if (change === "focus") screen.getByRole("button", { name: "Outside action" }).focus();
  else if (change === "variant") view.changeVariant();
  else if (change === "new action") fireEvent.keyDown(document, { key: "ArrowDown" });
  else view.unmount();
  const focused = document.activeElement;
  view.release();
  expect(view.scroll).not.toHaveBeenCalled(); expect(replace).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(focused);
});
