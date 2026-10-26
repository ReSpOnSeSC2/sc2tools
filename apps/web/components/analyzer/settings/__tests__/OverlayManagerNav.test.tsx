import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OverlayManagerNav, useOverlaySection } from "../OverlayManagerNav";
const state = vi.hoisted(() => ({ search: "tab=overlay&section=look&ref=keep" }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(state.search) }));
afterEach(cleanup);
it("keeps only the five remaining compact Overlay panes and preserves unrelated query context", () => {
  render(<OverlayManagerNav section="look" />);
  expect(screen.getAllByRole("link").map(link => link.textContent)).toEqual(["Setup", "Widgets", "Look", "Scenes", "Tokens"]);
  expect(screen.getByRole("link", { name: "Look" })).toHaveAttribute("aria-current", "page");
  for (const link of screen.getAllByRole("link")) expect(new URL(link.getAttribute("href")!, "https://fixture.invalid").searchParams.get("ref")).toBe("keep");
});
it("does not infer a hidden Chat/Dock pane or substring-match an unknown hash", () => {
  state.search = "tab=overlay&section=unknown"; window.history.replaceState(null, "", "/settings#unknown-chat-suffix");
  function Probe() { return <p>{useOverlaySection()}</p>; }
  render(<Probe />); expect(screen.getByText("setup")).toBeTruthy();
});
