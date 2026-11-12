import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import { SettingsSaveScope } from "@/components/analyzer/settings/SettingsSaveBar";
import type { NotificationRow } from "../notificationModel";
import type { MyReport } from "../MyReports";

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: "ann", isLoaded: true, isSignedIn: true, getToken: async () => "fixture-token" }) }));
vi.mock("@/lib/useUserSocket", () => ({ useUserSocket: () => undefined }));
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: ({ slug }: { slug: string }) => <a href={`/help/${slug}`}>Help</a> }));
import NotificationsPage from "@/app/notifications/page";
import { NotificationPreferences } from "../NotificationPreferences";
import { MyReports } from "../MyReports";
import { ReportReplyControl } from "@/app/admin/components/ReportReplyControl";

let rows: NotificationRow[];
let report: MyReport;
let prefs: { muted: string[]; milestones?: boolean };
let failSave: boolean;
let failReply: boolean;
let fetcher: ReturnType<typeof vi.fn>;
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
function mount(children: ReactNode) { return render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>{children}</SWRConfig>); }
beforeEach(() => {
  rows = Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, kind: i < 25 ? "coaching.booked" : "import.done", title: `Notice ${i}`, body: "Fixture update", href: "/coaching", count: 1, createdAt: new Date().toISOString(), readAt: null }));
  prefs = { muted: [] }; failSave = false; failReply = false;
  report = { eventId: "report-one", subject: "Missing chart", message: "The chart did not load.", createdAt: new Date().toISOString(), status: "new", revision: 0, replies: [] };
  fetcher = vi.fn(async (raw: string, init?: RequestInit) => {
    const url = new URL(raw, "http://localhost");
    if (url.pathname.endsWith("/preferences/notifications")) {
      if (init?.method === "PUT") { if (failSave) return response({ error: { code: "internal_error", message: "Save unavailable" } }, 503); prefs = JSON.parse(init.body as string); }
      return response(prefs);
    }
    if (url.pathname.endsWith("/messages/mine")) return response({ items: [report] });
    if (url.pathname.endsWith("/admin/messages/report-one")) {
      if (failReply) return response({ error: { code: "internal_error", message: "Reply unavailable" } }, 503);
      const body = JSON.parse(init!.body as string);
      report = { ...report, status: body.status, revision: report.revision + 1, replies: [...report.replies, { id: body.requestId, message: body.reply, createdAt: new Date().toISOString() }] };
      return response(report);
    }
    if (url.pathname.endsWith("/unread-count")) return response({ count: rows.filter((row) => !row.readAt).length });
    if (url.pathname.endsWith("/notifications/read")) {
      const body = JSON.parse(init!.body as string);
      rows = rows.map((row) => body.all || body.ids.includes(row.id) ? { ...row, readAt: new Date().toISOString() } : row);
      return response({ updated: rows.length });
    }
    if (url.pathname.endsWith("/me/notifications")) {
      let page = rows.filter((row) => !url.searchParams.has("unread") || !row.readAt);
      const kind = url.searchParams.get("kind");
      if (kind === "coaching") page = page.filter((row) => row.kind.startsWith("coaching."));
      if (kind === "milestones") page = page.filter((row) => row.kind.startsWith("moment."));
      if (kind === "system") page = page.filter((row) => row.kind === "import.done");
      if (kind === "reviews") page = [];
      const offset = Number(url.searchParams.get("before") || 0);
      return response({ items: page.slice(offset, offset + 20), nextCursor: page.length > offset + 20 ? String(offset + 20) : null });
    }
    return response({});
  }); vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("notification center consumers", () => {
  it("uses server kind/cursor filters, returns to the first page on filter change, and marks the entire inbox read", async () => {
    mount(<NotificationsPage />);
    await screen.findByText("Notice 0"); fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Notice 20"); expect(screen.queryByText("Notice 0")).toBeNull(); expect(screen.getByText("Page 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "System" }));
    await screen.findByText("Notice 25"); expect(screen.getByText("Page 1")).toBeTruthy(); expect(screen.queryByText("Notice 20")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reviews" })); await screen.findByText("No reviews notifications");
    expect(screen.getByRole("link", { name: "Help" }).getAttribute("href")).toBe("/help/notifications");
    fireEvent.click(screen.getByRole("button", { name: "Mark all as read" }));
    await waitFor(() => expect(rows.every((row) => row.readAt)).toBe(true));
    await waitFor(() => expect((screen.getByRole("button", { name: "Mark all as read" }) as HTMLButtonElement).disabled).toBe(true));
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST" && JSON.parse(init.body as string).all === true)).toBe(true);
  });

  it("filters private milestone rows and links to their game", async () => {
    rows.unshift(
      { ...rows[0], id: "milestone", kind: "moment.win_streak", title: "5 wins in a row", href: "/app/game/test-game" },
      { ...rows[0], id: "unsafe", kind: "moment.revenge_win", title: "Revenge win over Private Opponent" },
    );
    mount(<NotificationsPage />);
    await screen.findByText("Notice 0");
    fireEvent.click(screen.getByRole("button", { name: "Milestones" }));
    await waitFor(() => expect(screen.queryByText("Notice 0")).toBeNull());
    const notice = await screen.findByRole("link", { name: /5 wins in a row/ });
    expect(notice.getAttribute("href")).toBe("/app/game/test-game");
    const share = screen.getByRole("button", { name: "Share 5 wins in a row" });
    expect(share.closest("li")).toBe(notice.closest("li"));
    expect(notice.contains(share)).toBe(false);
    expect(screen.getAllByRole("button", { name: /^Share / })).toEqual([share]);
    expect(screen.getByRole("link", { name: /Revenge win over Private Opponent/ })).toBeTruthy();
  });

  it("retains an opt-in and muted-kind draft on failed save, then lets the player opt out", async () => {
    mount(<SettingsSaveScope tabId="preferences"><NotificationPreferences /></SettingsSaveScope>);
    const input = await screen.findByRole<HTMLInputElement>("checkbox", { name: "Import finished" });
    const milestones = screen.getByRole<HTMLInputElement>("checkbox", { name: "Milestones" });
    expect(milestones.checked).toBe(false);
    fireEvent.click(milestones);
    fireEvent.click(input);
    failSave = true; fireEvent.click(screen.getByRole("button", { name: "Save notifications" }));
    await screen.findByRole("alert"); expect(input.checked).toBe(false); expect(milestones.checked).toBe(true);
    failSave = false; fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await screen.findByText("Notification preferences saved"); expect(prefs).toEqual({ muted: ["import.done"], milestones: true });
    fireEvent.click(milestones);
    fireEvent.click(screen.getByRole("button", { name: "Save notifications" }));
    await screen.findByText("Notification preferences saved"); expect(prefs).toEqual({ muted: ["import.done"], milestones: false });
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "PUT").every(([url]) => String(url).endsWith("/preferences/notifications"))).toBe(true);
  });

  it("keeps a failed admin reply draft/request ID and displays the saved reply in My reports after refresh", async () => {
    mount(<><ReportReplyControl eventId={report.eventId} linkedUser /><MyReports /></>);
    await screen.findByText("Missing chart"); fireEvent.click(screen.getByRole("button", { name: "Status / Reply" }));
    const input = screen.getByRole("textbox", { name: "Reply to the user" }); fireEvent.change(input, { target: { value: "We fixed the chart." } });
    failReply = true; fireEvent.click(screen.getByRole("button", { name: "Save and send reply" }));
    await screen.findByRole("alert"); expect((input as HTMLTextAreaElement).value).toBe("We fixed the chart.");
    failReply = false; fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    const writes = fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH").map(([, init]) => JSON.parse(init!.body as string));
    expect(writes).toHaveLength(2); expect(writes[0].requestId).toBe(writes[1].requestId);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Refresh reports" })); });
    const summary = screen.getByText("Missing chart").closest("summary")!; fireEvent.click(summary);
    expect(await screen.findByText("We fixed the chart.")).toBeTruthy(); expect(within(document.getElementById("my-reports")!).getByText("Reply from SC2 Tools")).toBeTruthy();
  });
});
