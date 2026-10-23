import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { STREAMS_MIN_AGENT_VERSION } from "@/lib/agentNotice";
import { LandingPageContent } from "../LandingPageContent";
const mocks = vi.hoisted(() => ({ mode: "all", signedIn: false }));
vi.mock("@clerk/nextjs", () => ({ SignedIn: ({ children }: { children: React.ReactNode }) => mocks.signedIn ? children : null, SignedOut: ({ children }: { children: React.ReactNode }) => mocks.signedIn ? null : children }));
vi.mock("@/lib/instant/flag", () => ({ getInstantImportMode: () => mocks.mode }));
vi.mock("@/components/landing/ReplayDemo", () => ({ ReplayDemo: () => <div>Build editor demo</div> }));
vi.mock("@/components/landing/GuidesStrip", () => ({ GuidesStrip: () => null }));
vi.mock("@/components/pwa/InstallPrompt", () => ({ InstallPrompt: () => null }));
vi.mock("@/components/landing/RealGameShowcase", () => ({ RealGameShowcase: () => <div>Real game</div> }));
afterEach(cleanup);
beforeEach(() => { mocks.signedIn = false; mocks.mode = "all"; });
it("puts the headline before product slides and gives the hero one browser try path", () => {
  const { container } = render(<LandingPageContent />);
  const heading = screen.getByRole("heading", { level: 1 });
  const carousel = screen.getByRole("region", { name: "SC2 Tools product highlights" });
  expect(heading.compareDocumentPosition(carousel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const hero = heading.closest("section")!;
  expect(hero.querySelector('a[href="#replay-demo"]')).toBeNull();
  expect(container.querySelectorAll("#replay-demo")).toHaveLength(1);
  const practice = container.querySelector("#practice")!; const demo = container.querySelector("#replay-demo")!;
  expect(practice.compareDocumentPosition(demo) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(container.textContent).not.toMatch(/Coming with/);
  expect(container.textContent).toContain(`Included in the desktop app since ${STREAMS_MIN_AGENT_VERSION}`);
});

it("gives signed-in visitors dashboard and update paths in both CTA rows", () => {
  mocks.signedIn = true; const { container } = render(<LandingPageContent />);
  expect(screen.getAllByRole("link", { name: "Open your dashboard" })).toHaveLength(2);
  expect(screen.getAllByRole("link", { name: "What's new" })).toHaveLength(2);
  expect(screen.queryByRole("link", { name: "Download the free agent" })).toBeNull();
  expect(container.querySelector("header.border-y")).toBeNull();
});
it("keeps visitor download choices and gates the Getting started browser option", () => {
  const { rerender } = render(<LandingPageContent />);
  expect(screen.getByRole("link", { name: "Download the free agent" })).toBeTruthy();
  const step = screen.getByRole("heading", { name: "Install the agent" }).parentElement!;
  expect(within(step).getByRole("link", { name: "Analyze replays in your browser" }).getAttribute("href")).toBe("/try");
  mocks.mode = "off"; rerender(<LandingPageContent />);
  expect(within(step).queryByText(/Mac or Chromebook/)).toBeNull();
});
