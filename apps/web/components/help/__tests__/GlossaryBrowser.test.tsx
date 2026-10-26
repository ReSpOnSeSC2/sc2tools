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
  const related = screen.getByRole("link", { name: "Pulse ID" });
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
  fireEvent.keyDown(input, { key: "Escape" }); expect(screen.getAllByRole("term")).toHaveLength(GLOSSARY.length);
});

it.each(["page", "compact"] as const)("renders and searches canonical formula text in the %s glossary", (variant) => {
  render(<GlossaryBrowser variant={variant} />);
  const input = screen.getByRole("textbox", { name: "Search glossary" });
  // This coefficient occurs in the formula, not the term/short/long prose.
  fireEvent.change(input, { target: { value: "0.00137" } });
  expect(screen.getAllByRole("term").map(node => node.textContent)).toEqual(["Spending Quotient"]);
  expect(screen.getByText("Formula or rule:").parentElement?.textContent).toContain("0.00137");
  expect(screen.getByText("Formula or rule:").parentElement?.className).toContain("break-words");
  expect(screen.getByRole("link", { name: "Read Spending Quotient in context" }).getAttribute("href")).toBe("/help/macro#macro-score");
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.getAllByRole("term")).toHaveLength(GLOSSARY.length);
});

it("keeps all published term IDs and contextual links through the real article renderer", () => {
  const { container } = render(<HelpArticleBody article={article} />);
  for (const link of within(screen.getByRole("navigation", { name: "Glossary A to Z" })).getAllByRole("link")) {
    expect(link.getAttribute("href")).toBe(`#glossary-letter-${link.textContent!.toLowerCase()}`);
  }
  for (const term of GLOSSARY) {
    const entry = container.querySelector(`[id="${term.id}"]`)!;
    expect(entry, term.id).not.toBeNull();
    expect(within(entry as HTMLElement).getByRole("term").textContent).toBe(term.term);
    if (term.formula) expect(within(entry as HTMLElement).getByText("Formula or rule:").parentElement?.textContent).toContain(term.formula);
    expect(within(entry as HTMLElement).getByRole("link", { name: `Read ${term.term} in context` }).getAttribute("href")).toMatch(/^\/help\//);
    for (const id of term.related) {
      const related = GLOSSARY.find(item => item.id === id)!;
      expect(within(entry as HTMLElement).getByRole("link", { name: related.term }).getAttribute("href")).toBe(`#${id}`);
    }
  }
});

it("keeps compact Help anchors local instead of duplicating public IDs", () => {
  const { container } = render(<><HelpArticleBody article={article} variant="compact" /><HelpArticleBody article={article} variant="compact" /></>);
  for (const navigation of screen.getAllByRole("navigation", { name: "Glossary A to Z" })) {
    for (const link of within(navigation).getAllByRole("link")) {
      expect(link.getAttribute("href")).toBe(`/help/glossary#glossary-letter-${link.textContent!.toLowerCase()}`);
    }
  }
  for (const term of GLOSSARY) {
    expect(container.querySelector(`[id="${term.id}"]`)).toBeNull();
    const entries = container.querySelectorAll<HTMLElement>(`[data-help-anchor="${term.id}"]`);
    expect(entries).toHaveLength(2);
    for (const entry of entries) for (const id of term.related) {
      const related = GLOSSARY.find(item => item.id === id)!;
      expect(within(entry).getByRole("link", { name: related.term }).getAttribute("href")).toBe(`/help/glossary#${id}`);
    }
  }
  const ids = Array.from(container.querySelectorAll("[id]")).map(node => node.id);
  expect(new Set(ids).size).toBe(ids.length);
});

it.each(["Ctrl", "Meta"] as const)("keeps compact A–Z and Related destinations native for %s-click", (modifier) => {
  const frame = vi.fn(), scroll = vi.fn(), replace = vi.spyOn(history, "replaceState");
  vi.stubGlobal("requestAnimationFrame", frame);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
  render(<HelpArticleBody article={article} variant="compact" />);
  const input = screen.getByRole("textbox", { name: "Search glossary" });
  fireEvent.change(input, { target: { value: "look-alike" } });
  const links = [
    { link: within(screen.getByRole("navigation", { name: "Glossary A to Z" })).getByRole("link", { name: "B" }), href: "/help/glossary#glossary-letter-b" },
    { link: screen.getByRole("link", { name: "Pulse ID" }), href: "/help/glossary#pulse-id" },
  ];
  for (const { link, href } of links) {
    expect(link.getAttribute("href")).toBe(href);
    let consumerPrevented: boolean | undefined;
    // Observe the consumer's decision after React's delegated handler, then
    // prevent jsdom's unsupported navigation without altering that decision.
    const observe = (event: MouseEvent) => { consumerPrevented = event.defaultPrevented; event.preventDefault(); };
    document.addEventListener("click", observe, { once: true });
    fireEvent.click(link, modifier === "Ctrl" ? { ctrlKey: true } : { metaKey: true });
    document.removeEventListener("click", observe);
    expect(consumerPrevented).toBe(false);
    expect((input as HTMLInputElement).value).toBe("look-alike");
    expect(screen.getAllByRole("term").map(node => node.textContent)).toEqual(["Barcode"]);
  }
  expect(frame).not.toHaveBeenCalled(); expect(scroll).not.toHaveBeenCalled(); expect(replace).not.toHaveBeenCalled();
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
