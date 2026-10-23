import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SWRConfig, type Cache } from "swr";
import type { ReactNode } from "react";

type Row = {
  id: string; kind: string; title: string; body: string; href: string;
  count: number; readAt: string | null; createdAt: string;
};
const harness = vi.hoisted(() => ({
  userId: "ann",
  getToken: vi.fn(async () => "token-ann"),
  handlers: null as Record<string, (payload: unknown) => void> | null,
  connections: 0,
  disconnections: 0,
}));
vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ userId: harness.userId, getToken: harness.getToken, isLoaded: true, isSignedIn: true }),
}));
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: ReactNode; href: string }) => <a href={href} {...props}>{children}</a>,
}));
vi.mock("@/lib/useUserSocket", async () => {
  const { useEffect } = await import("react");
  return { useUserSocket: (handlers: typeof harness.handlers) => {
    useEffect(() => {
      if (!handlers) return;
      harness.handlers = handlers;
      harness.connections += 1;
      return () => { harness.disconnections += 1; };
    }, [handlers]);
  } };
});

import { NotificationBell } from "../NotificationBell";

let rows: Record<string, Row[]>;
let failRead: boolean;
let failUnread: boolean;
let deferAnnRead: boolean;
let pendingRead: (() => void) | null;
let deferList: boolean;
let pendingLists: Array<() => void>;
let fetchMock: ReturnType<typeof vi.fn>;
let cache: Cache;
let dedupingInterval: number;

function notification(id: string, read = false, createdAt = "2026-10-01T12:00:00.000Z"): Row {
  return { id, kind: "review.new", title: `Review ${id}`, body: "Review activity", href: `/reviews/${id}`,
    count: 1, readAt: read ? createdAt : null, createdAt };
}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});
const versionCursor = (row: Row) => `${row.createdAt}|${row.id}`;

beforeEach(() => {
  rows = { ann: [], bob: [] };
  failRead = false;
  failUnread = false;
  deferAnnRead = false;
  pendingRead = null;
  deferList = false;
  pendingLists = [];
  cache = new Map();
  dedupingInterval = 0;
  harness.userId = "ann";
  harness.getToken = vi.fn(async () => `token-${harness.userId}`);
  harness.handlers = null;
  harness.connections = 0;
  harness.disconnections = 0;
  vi.stubEnv("NEXT_PUBLIC_REVIEWS_ENABLED", "on");
  fetchMock = vi.fn(async (raw: string, init?: RequestInit) => {
    const url = new URL(raw, "http://localhost");
    const headers = init?.headers as Record<string, string>;
    const userId = (headers.authorization || "").replace("Bearer token-", "");
    if (url.pathname === "/v1/me") return response({ isAdmin: true });
    if (url.pathname.endsWith("/unread-count")) return failUnread ? response({ error: { code: "internal_error" } }, 503) : response({ count: rows[userId].filter((row) => !row.readAt).length });
    if (url.pathname.endsWith("/read")) {
      if (failRead) return response({ error: { code: "internal_error" } }, 503);
      if (deferAnnRead && userId === "ann") await new Promise<void>((resolve) => { pendingRead = resolve; });
      const body = JSON.parse(init?.body as string);
      const ids = body.all ? rows[userId].map((row) => row.id) : body.ids as string[];
      rows[userId].forEach((row) => { if (ids.includes(row.id)) row.readAt = "2026-10-17T12:00:00.000Z"; });
      return response({ updated: ids.length });
    }
    if (deferList) await new Promise<void>((resolve) => { pendingLists.push(resolve); });
    let page = rows[userId].filter((row) => !url.searchParams.has("unread") || !row.readAt);
    const before = url.searchParams.get("before");
    if (before) page = page.filter((row) => versionCursor(row) < before);
    page = [...page].sort((a, b) => versionCursor(b).localeCompare(versionCursor(a)));
    return response({ items: page.slice(0, 20), nextCursor: page.length > 20 ? versionCursor(page[19]) : null });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function Bell() {
  return <SWRConfig value={{ provider: () => cache, dedupingInterval, shouldRetryOnError: false }}><NotificationBell /></SWRConfig>;
}
const readCalls = () => fetchMock.mock.calls.filter((call) => String(call[0]).endsWith("/notifications/read"));
const open = async (count: number) => {
  fireEvent.click(await screen.findByRole("button", { name: `Notifications, ${count} unread` }));
  return screen.findByRole("dialog", { name: "Notifications" });
};

describe("NotificationBell unread and history", () => {
  it("shows older unread rows hidden behind recent read history and retains them after marking read", async () => {
    rows.ann = [
      ...Array.from({ length: 20 }, (_, i) => notification(`recent-${i}`, true, "2026-10-17T12:00:00.000Z")),
      ...Array.from({ length: 9 }, (_, i) => notification(`old-${i}`)),
    ];
    render(<Bell />);
    const panel = await open(9);
    expect(within(panel).getByRole("button", { name: "Unread" }).getAttribute("aria-pressed")).toBe("true");
    await within(panel).findByText("Review old-0");
    await waitFor(() => expect(readCalls()).toHaveLength(1));
    await screen.findByRole("button", { name: "Notifications" });
    expect(within(panel).getByText("Review old-0")).toBeTruthy();
    expect(within(panel).queryByText("Review recent-0")).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: "All notifications" }));
    expect(await within(panel).findByText("Review recent-0")).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "Load more notifications" })).toBeTruthy();
  });

  it("loads every remaining unread batch and keeps all shown rows after acknowledgements", async () => {
    rows.ann = Array.from({ length: 25 }, (_, i) => notification(`old-${String(i).padStart(2, "0")}`));
    render(<Bell />);
    const panel = await open(25);
    await within(panel).findByText("Review old-24");
    await waitFor(() => expect(readCalls()).toHaveLength(1));
    fireEvent.click(within(panel).getByRole("button", { name: "Load more notifications" }));
    await within(panel).findByText("Review old-00");
    await screen.findByRole("button", { name: "Notifications" });
    expect(within(panel).getAllByRole("link").filter((link) => link.hasAttribute("data-notification-row"))).toHaveLength(25);
    expect(readCalls()).toHaveLength(2);
    expect(within(panel).queryByRole("button", { name: "Load more notifications" })).toBeNull();
  });

  it("does not repeat read writes or reconnect its socket when SWR wrappers and token callbacks change", async () => {
    rows.ann = [notification("one")];
    const view = render(<Bell />);
    await open(1);
    await screen.findByRole("button", { name: "Notifications" });
    const handlers = harness.handlers;
    harness.getToken = vi.fn(async () => "token-ann");
    view.rerender(<Bell />);
    view.rerender(<Bell />);
    await act(async () => { harness.handlers?.["notifications:changed"]({}); });
    expect(harness.handlers).toBe(handlers);
    expect(harness.connections).toBe(1);
    expect(harness.disconnections).toBe(0);
    expect(readCalls()).toHaveLength(1);
    expect(screen.getByText("Review one")).toBeTruthy();
  });

  it("refreshes the head after paging so a realtime unread row cannot hide above the cursor", async () => {
    dedupingInterval = 2_000;
    rows.ann = Array.from({ length: 25 }, (_, i) => notification(`old-${String(i).padStart(2, "0")}`));
    render(<Bell />);
    const panel = await open(25);
    await within(panel).findByText("Review old-24");
    fireEvent.click(within(panel).getByRole("button", { name: "Load more notifications" }));
    await within(panel).findByText("Review old-00");
    await screen.findByRole("button", { name: "Notifications" });
    rows.ann.push(notification("new-head", false, "2026-10-17T12:00:00.000Z"));

    await act(async () => { harness.handlers?.["notifications:changed"]({}); });

    expect(await within(panel).findByText("Review new-head")).toBeTruthy();
    await screen.findByRole("button", { name: "Notifications" });
    expect(within(panel).getAllByRole("link").filter((link) => link.hasAttribute("data-notification-row"))).toHaveLength(26);
  });

  it("keeps the history tail cursor when a head refresh adds a new notification", async () => {
    rows.ann = Array.from({ length: 55 }, (_, i) => notification(`history-${String(i).padStart(2, "0")}`, true));
    render(<Bell />);
    fireEvent.click(await screen.findByRole("button", { name: "Notifications" }));
    const panel = await screen.findByRole("dialog", { name: "Notifications" });
    await within(panel).findByText("Review history-54");
    fireEvent.click(within(panel).getByRole("button", { name: "Load more notifications" }));
    await within(panel).findByText("Review history-15");
    rows.ann.push(notification("new-history-head", false, "2026-10-17T12:00:00.000Z"));
    await act(async () => { harness.handlers?.["notifications:changed"]({}); });
    await within(panel).findByText("Review new-history-head");

    fireEvent.click(within(panel).getByRole("button", { name: "Load more notifications" }));

    await within(panel).findByText("Review history-00");
    expect(within(panel).getAllByRole("link").filter((link) => link.hasAttribute("data-notification-row"))).toHaveLength(56);
    expect(within(panel).queryByRole("button", { name: "Load more notifications" })).toBeNull();
  });

  it("does not resurrect acknowledged rows from a warm unread cache after switching views", async () => {
    rows.ann = [notification("seen")];
    render(<Bell />);
    const panel = await open(1);
    await within(panel).findByText("Review seen");
    await screen.findByRole("button", { name: "Notifications" });
    fireEvent.click(within(panel).getByRole("button", { name: "All notifications" }));
    await within(panel).findByText("Review seen");

    fireEvent.click(within(panel).getByRole("button", { name: "Unread", pressed: false }));

    expect(await within(panel).findByText("No unread notifications.")).toBeTruthy();
    expect(within(panel).queryByText("Review seen")).toBeNull();
    expect(readCalls()).toHaveLength(1);
  });

  it("waits for fresh unread data after remount instead of reviving the previous session's nine rows", async () => {
    rows.ann = Array.from({ length: 9 }, (_, i) => notification(`seen-${i}`));
    const first = render(<Bell />);
    await open(9);
    await screen.findByRole("button", { name: "Notifications" });
    first.unmount();
    rows.ann.push(notification("fresh-one", false, "2026-10-17T12:00:00.000Z"));
    rows.ann.push(notification("fresh-two", false, "2026-10-17T12:00:01.000Z"));
    deferList = true;
    render(<Bell />);
    const panel = await open(2);
    await waitFor(() => expect(pendingLists.length).toBeGreaterThan(0));
    expect(within(panel).queryByText("Review seen-0")).toBeNull();

    await act(async () => {
      deferList = false;
      pendingLists.forEach((resolve) => resolve());
    });

    expect(await within(panel).findByText("Review fresh-one")).toBeTruthy();
    expect(within(panel).getByText("Review fresh-two")).toBeTruthy();
    expect(within(panel).queryByText("Review seen-0")).toBeNull();
    await screen.findByRole("button", { name: "Notifications" });
    expect(readCalls()).toHaveLength(2);
  });

  it("keeps failed reads unread and retries only after an explicit retry", async () => {
    rows.ann = [notification("failed")];
    failRead = true;
    const view = render(<Bell />);
    await open(1);
    await screen.findByRole("alert");
    view.rerender(<Bell />);
    expect(readCalls()).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Notifications, 1 unread" })).toBeTruthy();
    failRead = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("button", { name: "Notifications" });
    expect(readCalls()).toHaveLength(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Review failed")).toBeTruthy();
  });

  it("closes and clears retained rows on account switch, including a late read response", async () => {
    rows.ann = [notification("private-ann")];
    rows.bob = [notification("private-bob")];
    deferAnnRead = true;
    const view = render(<Bell />);
    await open(1);
    await screen.findByText("Review private-ann");
    await waitFor(() => expect(pendingRead).not.toBeNull());
    harness.userId = "bob";
    view.rerender(<Bell />);
    expect(screen.queryByText("Review private-ann")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    await open(1);
    await screen.findByText("Review private-bob");
    await act(async () => { pendingRead?.(); });
    expect(screen.queryByText("Review private-ann")).toBeNull();
    expect(screen.getByText("Review private-bob")).toBeTruthy();
  });
});


describe("notification center panel behavior", () => {
  it("is enabled with Reviews off, styles the selected segment, and retains New styling after acknowledgement", async () => {
    vi.stubEnv("NEXT_PUBLIC_REVIEWS_ENABLED", "off"); rows.ann = [notification("one")];
    render(<Bell />); const panel = await open(1);
    const segment = within(panel).getByRole("button", { name: "Unread" });
    expect(segment.className).toContain("bg-accent/15");
    await waitFor(() => expect(readCalls()).toHaveLength(1));
    await screen.findByRole("button", { name: "Notifications" });
    const row = within(panel).getByRole("link", { name: /Review one/ });
    expect(row.className).toContain("bg-accent/10"); expect(within(row).getByText("New")).toBeTruthy();
    expect(within(panel).getByRole("link", { name: "See all notifications" }).getAttribute("href")).toBe("/notifications");
  });

  it("moves focus into the first row and restores it after Escape or outside click", async () => {
    rows.ann = [notification("focus")]; render(<Bell />);
    const panel = await open(1);
    const row = await within(panel).findByRole("link", { name: /Review focus/ });
    await waitFor(() => expect(document.activeElement).toBe(row));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Notifications" }));
    fireEvent.click(document.activeElement!);
    const reopened = await screen.findByRole("dialog");
    await waitFor(() => expect(document.activeElement).toBe(within(reopened).getByRole("link", { name: /Review focus/ })));
    fireEvent.mouseDown(document.body);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Notifications" }));
  });

  it("keeps an unavailable bell rendered and offers a working unread-count retry", async () => {
    failUnread = true; render(<Bell />);
    fireEvent.click(await screen.findByRole("button", { name: "Notifications" }));
    const panel = await screen.findByRole("dialog");
    expect(await within(panel).findByText(/Couldn't load notifications/)).toBeTruthy();
    failUnread = false; fireEvent.click(within(panel).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(within(panel).queryByText(/Couldn't load notifications/)).toBeNull());
    expect(screen.getByRole("button", { name: "Notifications" })).toBeTruthy();
  });

  it("filters loaded kinds and hides absent categories without discarding rows", async () => {
    rows.ann = [notification("review"), { ...notification("booking"), kind: "coaching.booked", title: "Session booked" }];
    render(<Bell />); const panel = await open(2);
    await within(panel).findByText("Session booked");
    expect(within(panel).queryByRole("button", { name: "System" })).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: "Coaching" }));
    expect(within(panel).queryByText("Review review")).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: "All" }));
    expect(within(panel).getByText("Review review")).toBeTruthy();
  });

  it("marks rows beyond the visible first page read with the existing all:true action", async () => {
    rows.ann = Array.from({ length: 25 }, (_, i) => notification(`mark-${i}`));
    render(<Bell />); const panel = await open(25);
    await screen.findByRole("button", { name: "Notifications, 5 unread" });
    fireEvent.click(within(panel).getByRole("button", { name: "Mark all read" }));
    await screen.findByRole("button", { name: "Notifications" });
    expect(readCalls().some((call) => JSON.parse(call[1]?.body as string).all === true)).toBe(true);
    expect(rows.ann.every((row) => row.readAt)).toBe(true);
    expect((within(panel).getByRole("button", { name: "Mark all read" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("retries a failed mark-all action for rows beyond the visible page", async () => {
    rows.ann = Array.from({ length: 25 }, (_, i) => notification(`retry-all-${i}`));
    render(<Bell />); const panel = await open(25);
    await screen.findByRole("button", { name: "Notifications, 5 unread" });
    failRead = true; fireEvent.click(within(panel).getByRole("button", { name: "Mark all read" }));
    await within(panel).findByRole("alert");
    failRead = false; fireEvent.click(within(panel).getByRole("button", { name: "Retry" }));
    await screen.findByRole("button", { name: "Notifications" });
    expect(rows.ann.every((row) => row.readAt)).toBe(true);
    expect(readCalls().filter((call) => JSON.parse(call[1]?.body as string).all === true)).toHaveLength(2);
    expect(within(panel).queryByRole("alert")).toBeNull();
  });
});
