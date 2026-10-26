import { useRef } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import NotificationPanel from "../NotificationPanel";
import { Modal } from "@/components/ui/Modal";
import { Popover } from "@/components/ui/Popover";
vi.mock("next/link", () => ({ default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...props}>{children}</a> }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("focuses the first committed row synchronously after readiness, without stealing later user focus", () => {
  const noop = () => {};
  const props = { items: [], ready: false, loading: true, listError: false, unreadError: false, readError: false, view: "all" as const, selectView: noop, onClose: noop, retryList: noop, retryUnread: noop, retryRead: noop, onMore: null, markAll: noop, markingAll: false, unread: 0, openedNew: new Set<string>() };
  const view = render(<NotificationPanel {...props} />);
  expect(document.activeElement).toBe(document.body);
  const row = { id: "row", kind: "review.new", title: "A review", body: "", href: "/reviews/row", count: 1, readAt: null, createdAt: "2026-10-23T00:00:00Z" };
  view.rerender(<NotificationPanel {...props} items={[row]} ready loading={false} />);
  expect(document.activeElement).toBe(screen.getByRole("link", { name: /A review/ }));
  const all = screen.getByRole("button", { name: "All notifications" }); all.focus();
  view.rerender(<NotificationPanel {...props} items={[{ ...row, count: 2 }]} ready loading={false} />);
  expect(document.activeElement).toBe(all);
});

it.each(["empty", "list error", "unread error"] as const)("focuses the header for %s entry without owning a second dialog", (state) => {
  const noop = () => {};
  const props = { items: [], ready: state === "empty", loading: state !== "empty", listError: state === "list error", unreadError: state === "unread error", readError: false, view: "all" as const, selectView: noop, onClose: noop, retryList: noop, retryUnread: noop, retryRead: noop, onMore: null, markAll: noop, markingAll: false, unread: 0, openedNew: new Set<string>() };
  const view = render(<NotificationPanel {...props} />);
  const header = screen.getByRole("heading", { name: "Notifications" });
  expect(document.activeElement).toBe(header);
  expect(screen.queryByRole("dialog")).toBeNull();
  const toggle = screen.getByRole("button", { name: "All notifications" });
  toggle.focus();
  view.rerender(<NotificationPanel {...props} ready loading={false} listError={false} unreadError={false} />);
  expect(document.activeElement).toBe(toggle);
});

it("consumes initial focus without leaving a newer Modal or refocusing after it closes", () => {
  const noop = () => {};
  const props = { items: [], ready: false, loading: true, listError: false, unreadError: false, readError: false, view: "all" as const, selectView: noop, onClose: noop, retryList: noop, retryUnread: noop, retryRead: noop, onMore: null, markAll: noop, markingAll: false, unread: 0, openedNew: new Set<string>() };
  const row = { id: "later", kind: "review.new", title: "Late review", body: "", href: "/reviews/later", count: 1, readAt: null, createdAt: "2026-10-23T00:00:00Z" };
  const view = render(<><button type="button">Outside action</button><NotificationPanel {...props} />
    <Modal open onClose={noop} title="Newer dialog"><button type="button">Keep modal focus</button></Modal></>);
  const laterAction = screen.getByRole("button", { name: "Keep modal focus" });
  laterAction.focus();
  view.rerender(<><button type="button">Outside action</button><NotificationPanel {...props} items={[row]} ready loading={false} />
    <Modal open onClose={noop} title="Newer dialog"><button type="button">Keep modal focus</button></Modal></>);
  expect(screen.getByRole("link", { name: /Late review/ })).toBeTruthy();
  expect(document.activeElement).toBe(laterAction);

  view.rerender(<><button type="button">Outside action</button><NotificationPanel {...props} items={[row]} ready loading={false} />
    <Modal open={false} onClose={noop} title="Newer dialog"><button type="button">Keep modal focus</button></Modal></>);
  const outside = screen.getByRole("button", { name: "Outside action" });
  outside.focus();
  view.rerender(<><button type="button">Outside action</button><NotificationPanel {...props} items={[{ ...row, count: 2 }]} ready loading={false} />
    <Modal open={false} onClose={noop} title="Newer dialog"><button type="button">Keep modal focus</button></Modal></>);
  expect(document.activeElement).toBe(outside);
});

it("waits for real Popover placement before focusing a cached error header", async () => {
  const attempts: string[] = [];
  const nativeFocus = HTMLElement.prototype.focus;
  vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, ...args) {
    if (this.tagName === "H2" && this.textContent === "Notifications") {
      attempts.push(this.closest<HTMLElement>('[role="dialog"]')?.style.visibility ?? "no-dialog");
    }
    nativeFocus.apply(this, args);
  });
  function CachedError() {
    const anchorRef = useRef<HTMLButtonElement>(null);
    const noop = () => {};
    const props = { items: [], ready: false, loading: false, listError: true, unreadError: true, readError: false, view: "all" as const, selectView: noop, onClose: noop, retryList: noop, retryUnread: noop, retryRead: noop, onMore: null, markAll: noop, markingAll: false, unread: 0, openedNew: new Set<string>() };
    const popover = { open: true, onClose: noop, anchorRef, label: "Cached notifications", autoFocus: false,
      children: <NotificationPanel {...props} /> };
    return <><button ref={anchorRef} type="button">Bell trigger</button><Popover {...popover} /></>;
  }
  render(<CachedError />);
  const header = screen.getByRole("heading", { name: "Notifications" });
  await waitFor(() => expect(document.activeElement).toBe(header));
  expect(attempts).toEqual([""]);
  expect(screen.getByRole("dialog", { name: "Cached notifications" }).style.visibility).toBe("");
});
