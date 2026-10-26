import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import NotificationPanel from "../NotificationPanel";
vi.mock("next/link", () => ({ default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...props}>{children}</a> }));
afterEach(cleanup);

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
