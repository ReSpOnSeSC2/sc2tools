import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Dashboard from "./page";
import { weekOverWeek } from "./components/adminDailyEvents";
import type { AdminAttentionResp, AdminDailyEvent } from "./components/adminTypes";

const mocks = vi.hoisted(() => ({ loading: true, failed: false, counts: vi.fn(), recent: vi.fn(), storage: vi.fn(), attention: vi.fn(), daily: vi.fn(),
  attentionData: undefined as AdminAttentionResp | undefined, activity: false }));
const routes = {
  attention: "/v1/admin/attention",
  daily: "/v1/admin/events/daily?days=30",
  counts: "/v1/admin/events/counts",
  recent: "/v1/admin/events?limit=8",
  storage: "/v1/admin/storage-summary",
} as const;
const daily = (values: [number, number, number] = [0, 0, 0]): AdminDailyEvent[] =>
  Array.from({ length: 30 }, (_, index) => ({
    date: "2026-10-" + String(index + 1).padStart(2, "0"),
    user_signup: index === 29 ? values[2] : index >= 22 ? values[1] : index >= 15 ? values[0] : 0,
    agent_download: index === 1 ? 60 : 0,
    agent_connected: index === 1 ? 30 : 0,
  }));
const noQueues: AdminAttentionResp = {
  openReports: 0, pendingIdentities: 0, pendingChannels: 0, unreadMessages: 0, alerts: 0,
  advisories: { level: null }, generatedAt: "2026-10-01T12:04:00Z",
};

vi.mock("@/lib/useUserSocket", () => ({ useUserSocket: () => undefined }));
vi.mock("next/dynamic", () => ({ default: () => () => <div>Chart placeholder</div> }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: "admin" }) }));
vi.mock("./components/useAdminEventsSocket", () => ({ useAdminEventsSocket: () => undefined }));
// Article loading has its own integration coverage. Keep this test focused on
// independent dashboard requests, including simultaneous failures.
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: () => null }));
vi.mock("@/lib/clientApi", () => ({ useApi: (url: string) => {
  const name = (Object.keys(routes) as (keyof typeof routes)[]).find((key) => routes[key] === url);
  if (!name) throw new Error("Unexpected admin request: " + url);
  const data = name === "attention" ? mocks.attentionData : !mocks.activity ? undefined
    : name === "daily" ? { days: daily([1, 2, 99]) }
      : name === "storage" ? { dataBytes: 1_024, indexBytes: 512, collectionCount: 2 }
        : name === "counts" ? {
          totalUsers: 120, totalDownloads: 90, unreadCount: 7, agents: { active24h: 12 },
          downloadsByPlatform: { windows: 41, macos: 3, linux: 1 },
        } : { items: [], nextBefore: null };
  return { data, isLoading: mocks.loading,
    error: mocks.failed ? { status: 503, message: "Service unavailable", requestId: url } : undefined,
    mutate: mocks[name],
  };
} }));
afterEach(() => {
  cleanup(); mocks.loading = true; mocks.failed = false; mocks.attentionData = undefined; mocks.activity = false; vi.clearAllMocks();
});

it("keeps one Dashboard heading while loading and after data settles", () => {
  const { rerender } = render(<Dashboard />);
  expect(screen.getAllByRole("heading", { level: 1, name: "Dashboard" })).toHaveLength(1);
  mocks.loading = false;
  rerender(<Dashboard />);
  expect(screen.getAllByRole("heading", { level: 1, name: "Dashboard" })).toHaveLength(1);
  const refresh = screen.getAllByRole("button", { name: "Refresh" });
  expect(refresh).toHaveLength(2);
  refresh.forEach((button) => fireEvent.click(button));
  expect(mocks.recent).toHaveBeenCalledTimes(2);
});

it("keeps failures recoverable while revalidating each independent source", () => {
  mocks.failed = true;
  render(<Dashboard />);
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  screen.getAllByRole("button", { name: "Retry" }).forEach((button) => fireEvent.click(button));
  expect(mocks.counts).toHaveBeenCalledTimes(1);
  expect(mocks.recent).toHaveBeenCalledTimes(1);
  expect(mocks.storage).toHaveBeenCalledTimes(1);
  expect(mocks.attention).toHaveBeenCalledTimes(1);
  expect(mocks.daily).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("All clear")).toBeNull();
});

it("lists nonzero queues in triage order with accurate counts and deep links", () => {
  mocks.attentionData = { ...noQueues, unreadMessages: 1, alerts: 2, openReports: 4, pendingIdentities: 3, pendingChannels: 2, advisories: { level: "upgrade" } };
  render(<Dashboard />);
  const panel = within(screen.getByRole("region", { name: "Needs attention" }));
  const links = panel.getAllByRole("link");
  expect(links.slice(0, 6).map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
    ["Read 1 user message", "/admin/notifications?type=user_message"],
    ["Check 2 system alerts", "/admin/notifications"],
    ["Resolve 4 community reports", "/admin/moderation"],
    ["Review 3 identity submissions", "/admin/player-identities"],
    ["Review 2 channel submissions", "/admin/player-channels?pendingOnly=1"],
    ["Infrastructure: upgrade advised", "/admin/health"],
  ]);
  expect(panel.getByRole("link", { name: /How to triage/ }).getAttribute("href")).toMatch(/#daily-triage$/);
});

it("shows a checked time only for a successful empty attention response", () => {
  const { rerender } = render(<Dashboard />);
  expect(screen.getByRole("status", { name: "Checking admin queues" })).toBeTruthy();
  mocks.attentionData = noQueues;
  rerender(<Dashboard />);
  const panel = within(screen.getByRole("region", { name: "Needs attention" }));
  expect(panel.getByRole("status").textContent).toMatch(/All clear.*checked .*:\d{2}/);
  expect(panel.getAllByRole("link")).toHaveLength(1);
});

it("links each total, defines the measured counts and offers the UTC chart table", () => {
  mocks.loading = false;
  mocks.activity = true;
  render(<Dashboard />);
  const links = [
    [/^Total users 120 Registered accounts Signups \+100%/, "/admin/users"],
    [/^Active agents 12 Paired devices seen in the last 24h/, "/admin/users?filter=with_agent"],
    [/^Agent downloads 90 Recorded download clicks Windows 41 · macOS 3 · Linux 1/, "/admin/notifications?type=agent_download&unread=0"],
    [/^Unread 7 Activity and messages marked unread/, "/admin/notifications"],
    [/^Database .* Infrastructure$/, "/admin/health"],
  ] as const;
  for (const [name, href] of links) expect(screen.getByRole("link", { name }).getAttribute("href")).toBe(href);
  expect(screen.queryByText("Database storage")).toBeNull();
  const activity = within(screen.getByRole("region", { name: "Last 30 days" }));
  expect(activity.getByText("Last 30 days: 120 signups, 60 download clicks, 30 first connections.")).toBeTruthy();
  fireEvent.click(activity.getByRole("button", { name: "View as table" }));
  const table = within(activity.getByRole("table", { name: "Daily activity in UTC" }));
  expect(table.getByRole("columnheader", { name: "Date (UTC)" })).toBeTruthy();
  expect(table.getByRole("row", { name: "2026-10-02 0 60 30" })).toBeTruthy();
  fireEvent.click(activity.getByRole("button", { name: "View as chart" }));
  expect(activity.queryByRole("table")).toBeNull();
});

it("compares completed weeks and handles a zero prior count", () => {
  expect(weekOverWeek(daily([1, 2, 99]), "user_signup")).toBe("+100% vs last week");
  expect(weekOverWeek(daily([2, 1, 0]), "user_signup")).toBe("-50% vs last week");
  expect(weekOverWeek(daily([0, 1, 0]), "user_signup")).toBe("new vs last week");
  expect(weekOverWeek(daily([0, 0, 99]), "user_signup")).toBeNull();
  expect(weekOverWeek(daily().slice(-14), "user_signup")).toBeNull();
});

it("uses chart theme colors and has no hardcoded hex strokes", () => {
  const source = readFileSync(resolve(__dirname, "components/AdminDailyChart.tsx"), "utf8");
  expect(source).toContain("useChartTheme()");
  expect(source).not.toMatch(/#[0-9a-f]{3,8}\b/i);
});
