import type { AnchorHTMLAttributes, ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { WhatsNewEntry } from "@/lib/whatsNew";
import { WhatsNewEntries } from "../WhatsNewEntries";

// Marks client-router links so a test can tell them from plain anchors.
vi.mock("next/link", () => ({ default: ({ href, children, prefetch, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { prefetch?: boolean }) => {
  void prefetch;
  return <a data-client-link="" href={href} {...props}>{children}</a>;
} }));
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: ({ children }: { children: ReactNode }) => <span>{children}</span> }));
afterEach(cleanup);

function entry(id: string, href: string): WhatsNewEntry {
  return { id, date: "2026-11-26", title: id, summary: "Summary.", audience: "website", highlights: ["One highlight."], link: { href, label: `Open ${id}` } };
}

it("opens static /play/ pages with a full page load and keeps client links elsewhere", () => {
  render(<WhatsNewEntries entries={[entry("game", "/play/humdingers"), entry("tools", "/tools")]} />);
  const game = screen.getByRole("link", { name: "Open game" });
  expect(game.getAttribute("href")).toBe("/play/humdingers");
  expect(game.hasAttribute("data-client-link")).toBe(false);
  const tools = screen.getByRole("link", { name: "Open tools" });
  expect(tools.getAttribute("href")).toBe("/tools");
  expect(tools.hasAttribute("data-client-link")).toBe(true);
});
