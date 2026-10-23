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
