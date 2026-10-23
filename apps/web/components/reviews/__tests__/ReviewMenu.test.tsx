import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ event: vi.fn(), success: vi.fn(), share: vi.fn(), copy: vi.fn() }));
vi.mock("@/lib/analytics/gtag", () => ({ gaEvent: h.event }));
vi.mock("@/components/ui/Toast", () => ({ useToastOptional: () => ({ toast: { success: h.success } }) }));
import { ReviewMenu } from "../ReviewMenu";
import { ReviewShareMenu } from "../ReviewShareMenu";

const items = [{ id: "one", label: "First" }, { id: "two", label: "Second" }, { id: "three", label: "Third" }];
beforeEach(() => {
  h.event.mockReset(); h.success.mockReset(); h.share.mockReset().mockResolvedValue(undefined); h.copy.mockReset().mockResolvedValue(undefined);
  const navigatorCopy = Object.create(navigator); navigatorCopy.share = h.share; navigatorCopy.clipboard = { writeText: h.copy };
  vi.stubGlobal("navigator", navigatorCopy); vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("opens with ArrowDown and roves with arrows, Home and End, then restores focus on Escape", () => {
  render(<ReviewMenu label="Actions" items={items}>More</ReviewMenu>);
  const trigger = screen.getByRole("button", { name: "Actions" });
  expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const first = screen.getByRole("menuitem", { name: "First" });
  expect(document.activeElement).toBe(first); expect(first.tabIndex).toBe(0);
  expect(trigger.getAttribute("aria-controls")).toBe(screen.getByRole("menu").id);
  fireEvent.keyDown(first, { key: "ArrowDown" }); expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Second" }));
  fireEvent.keyDown(document.activeElement!, { key: "End" }); expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Third" }));
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" }); expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: "ArrowUp" }); expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Third" }));
  fireEvent.keyDown(document.activeElement!, { key: "Home" }); expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: "Escape" }); expect(screen.queryByRole("menu")).toBeNull(); expect(document.activeElement).toBe(trigger);
});

it("supports ArrowUp, Enter and Space opening, outside dismissal and Tab dismissal", () => {
  render(<ReviewMenu label="Actions" items={items}>More</ReviewMenu>);
  const trigger = screen.getByRole("button", { name: "Actions" });
  fireEvent.keyDown(trigger, { key: "ArrowUp" }); expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Third" }));
  fireEvent.pointerDown(document.body); expect(screen.queryByRole("menu")).toBeNull(); expect(document.activeElement).toBe(trigger);
  fireEvent.keyDown(trigger, { key: "Enter" }); expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "First" }));
  fireEvent.keyDown(document.activeElement!, { key: "Tab" }); expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.keyDown(trigger, { key: " " }); expect(screen.getByRole("menu")).toBeTruthy();
});

it("focuses the first report reason on a second step and hides a menu with no permitted actions", () => {
  const { rerender } = render(<ReviewMenu label="Actions" items={[{ id: "report", label: "Report…", items: [{ id: "spam", label: "Spam" }, { id: "other", label: "Other" }] }]}>More</ReviewMenu>);
  fireEvent.click(screen.getByRole("button")); fireEvent.click(screen.getByRole("menuitem", { name: "Report…" }));
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Spam" }));
  rerender(<ReviewMenu label="Actions" items={[]}>More</ReviewMenu>); expect(screen.queryByRole("button")).toBeNull();
});

it("flips above a trigger near the viewport bottom and shifts an otherwise clipped popup into view", () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return { x: -100, y: 760, top: 760, bottom: 800, left: -100, right: 156, width: 256, height: this.getAttribute("role") === "menu" ? 160 : 40, toJSON: () => ({}) };
  });
  render(<ReviewMenu label="Actions" items={items}>More</ReviewMenu>); fireEvent.click(screen.getByRole("button"));
  const menu = screen.getByRole("menu"); expect(menu.className).toContain("bottom-full"); expect(menu.style.transform).toBe("translateX(108px)");
  expect(screen.getAllByRole("menuitem").every((item) => item.className.includes("min-h-10"))).toBe(true);
});

it("uses a real absolute HTTPS Reddit link and reports its share channel", async () => {
  render(<ReviewShareMenu path="/reviews/request" question="How should I scout here?" matchup="PvZ" />);
  fireEvent.click(screen.getByRole("button", { name: "Share this review" }));
  const reddit = await screen.findByRole("menuitem", { name: "Post to Reddit" }); const href = new URL(reddit.getAttribute("href")!);
  expect(href.protocol).toBe("https:"); expect(href.searchParams.get("url")).toBe(`${window.location.origin}/reviews/request`);
  expect(reddit.getAttribute("target")).toBe("_blank"); expect(reddit.getAttribute("rel")).toBe("noopener noreferrer");
  fireEvent.click(reddit); expect(h.event).toHaveBeenCalledWith("review_shared", { channel: "reddit" });
});

it("uses one-tap native sharing on a coarse pointer, ignores cancellation and falls back for another error", async () => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
  render(<ReviewShareMenu path="/reviews/request" question="How should I scout here?" matchup="PvZ" />);
  const trigger = screen.getByRole("button", { name: "Share this review" });
  fireEvent.click(trigger); await waitFor(() => expect(h.share).toHaveBeenCalledOnce());
  expect(h.share).toHaveBeenCalledWith({ title: "[PvZ] How should I scout here?", url: `${window.location.origin}/reviews/request` });
  expect(screen.queryByRole("menu")).toBeNull();
  h.share.mockRejectedValueOnce({ name: "AbortError" }); fireEvent.click(trigger); await waitFor(() => expect(h.share).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("menu")).toBeNull();
  h.share.mockRejectedValueOnce({ name: "NotAllowedError" }); fireEvent.click(trigger);
  expect(await screen.findByRole("menuitem", { name: "Copy link" })).toBeTruthy();
});

it("shows and selects copyable text on a clipboard failure without opening window.prompt", async () => {
  const prompt = vi.spyOn(window, "prompt"); h.copy.mockRejectedValue(new Error("denied"));
  render(<ReviewShareMenu path="/reviews/request" question="How should I scout here?" matchup="PvZ" />);
  fireEvent.click(screen.getByRole("button", { name: "Share this review" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Copy for Discord" }));
  const fallback = await screen.findByRole("textbox", { name: "Copy this text" }) as HTMLInputElement;
  expect(fallback.readOnly).toBe(true); expect(fallback.value).toContain(`${window.location.origin}/reviews/request`);
  expect(document.activeElement).toBe(fallback); expect(fallback.selectionStart).toBe(0); expect(fallback.selectionEnd).toBe(fallback.value.length);
  expect(prompt).not.toHaveBeenCalled(); expect(screen.getByRole("menu").contains(fallback)).toBe(true);
});

it("copies the link, announces success and keeps the existing analytics channel", async () => {
  render(<ReviewShareMenu path="/reviews/request" question="How should I scout here?" matchup="PvZ" />);
  fireEvent.click(screen.getByRole("button", { name: "Share this review" })); fireEvent.click(await screen.findByRole("menuitem", { name: "Copy link" }));
  await waitFor(() => expect(h.success).toHaveBeenCalledWith("Link copied"));
  expect(screen.getByRole("status").textContent).toBe("Link copied"); expect(h.event).toHaveBeenCalledWith("review_shared", { channel: "link" });
  expect(screen.queryByRole("menu")).toBeNull();
});
