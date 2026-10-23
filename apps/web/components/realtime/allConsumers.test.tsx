import type { ReactNode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  io: vi.fn(), refresh: vi.fn(), apiCall: vi.fn(), toast: {}, token: vi.fn(async () => "current-token"),
  resources: new Map<string, { data: unknown; mutate: ReturnType<typeof vi.fn>; isLoading: boolean }>(),
  handlers: new Map<string, (value?: unknown) => void>(), disconnect: vi.fn(),
}));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "admin", getToken: h.token }) }));
vi.mock("socket.io-client", () => ({ io: (...args: unknown[]) => h.io(...args) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/app", useSearchParams: () => new URLSearchParams(), useRouter: () => ({ refresh: h.refresh }) }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/lib/clientApi", () => ({ API_BASE: "https://api.example.test", apiCall: h.apiCall,
  useApi: (path: string | null) => {
    const key = path || "none";
    if (!h.resources.has(key)) {
      const data = path === "/v1/me" ? { isAdmin: true }
        : path === "/v1/coaching/alerts" ? { eligible: true, unreadCount: 0, alert: null }
          : path?.includes("unread-count") ? { count: 0 }
            : path === "/v1/import/status" ? { jobId: "job", status: "running", total: 10, completed: 1, errors: 0 }
              : path?.startsWith("/v1/admin/events?") ? { items: [], nextBefore: null }
                : path === "/v1/admin/events/counts" ? { unreadCount: 1 } : undefined;
      h.resources.set(key, { data, isLoading: false, mutate: vi.fn(async () => data) });
    }
    return h.resources.get(key);
  },
}));
vi.mock("@/lib/useSeasons", async (original) => ({ ...await original<object>(), useSeasons: () => ({ data: undefined }) }));
vi.mock("@/lib/reviews", () => ({ reviewsVisible: () => true }));
vi.mock("@/lib/useChartTheme", () => ({ useReducedMotion: () => true }));
vi.mock("@/lib/instant/useInstantImport", () => ({ useInstantImport: () => ({ enabled: false }) }));
vi.mock("@/components/analyzer/DoctorBanner", () => ({ DoctorBanner: () => null }));
vi.mock("@/components/analyzer/FilterBar", () => ({ FilterBar: () => null }));
vi.mock("@/components/analyzer/ActiveFilterChips", () => ({ ActiveFilterChips: () => null }));
vi.mock("@/components/onboarding/OnboardingChecklist", () => ({ checklistVisible: () => true, OnboardingChecklist: () => null }));
vi.mock("@/components/imports/ImportProgressCard", () => ({ ImportProgressCard: () => null }));
vi.mock("@/components/ui/Toast", () => ({ useToastOptional: () => null, useToast: () => ({ toast: h.toast }) }));
vi.mock("@/app/admin/components/AdminPageHeader", () => ({ AdminPageHeader: ({ title, actions }: { title: string; actions: ReactNode }) => <header>{title}{actions}</header> }));
vi.mock("@/app/admin/components/AdminFragments", () => ({ ForbiddenCard: () => null, LoadingRows: () => null, MetricStat: () => null }));
vi.mock("@/app/admin/components/AdminEventRow", () => ({ AdminEventRow: () => <li>Live durable event</li> }));

import { RealtimeProvider } from "./RealtimeProvider";
import { SyncStatus } from "@/components/SyncStatus";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { CoachingBookingAlert } from "@/components/chrome/CoachingBookingAlert";
import { BuildCheckInProvider, useBuildCheckInRevision } from "@/components/build-checkin/BuildCheckInProvider";
import { AnalyzerProvider } from "@/components/AnalyzerProvider";
import { AnalyzerFrame } from "@/components/dashboard/AnalyzerFrame";
import { useFilters } from "@/lib/filterContext";
import { useImportStatus } from "@/components/imports/useImportStatus";
import { AdminShell } from "@/app/admin/components/AdminShell";
import Dashboard from "@/app/admin/page";
import Notifications from "@/app/admin/notifications/page";
import CoachingPractice from "@/app/coaching/CoachingPractice";
import NotificationsCenter from "@/app/notifications/page";
import { SiteIncidentBanner } from "@/components/announcements/SiteIncidentBanner";
import { WhatsNewButton } from "@/components/announcements/WhatsNewButton";

function CheckIn() { return <output data-testid="checkin">{useBuildCheckInRevision().revision}</output>; }
function AnalyzerRevision() { return <output data-testid="analyzer">{useFilters().dbRev}</output>; }
function Import() { return <output data-testid="import">{useImportStatus().job?.completed}</output>; }
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); h.resources.clear(); h.handlers.clear();
  h.apiCall.mockImplementation(async (_token, path) => String(path).startsWith("/v1/site/banner") ? { banner: null } : { items: [], nextCursor: null });
  h.io.mockImplementation(() => ({ connected: false, connect: vi.fn(), disconnect: h.disconnect,
    on: (event: string, callback: (value?: unknown) => void) => h.handlers.set(event, callback), off: () => h.handlers.clear(),
  }));
});
afterEach(() => { cleanup(); act(() => vi.runOnlyPendingTimers()); vi.useRealTimers(); });

it("mounts every current user and admin consumer on one socket and fans out reconnects, live events and one shared chart refresh", async () => {
  const corpusCalls = () => h.apiCall.mock.calls.filter(([, path]) => String(path).startsWith("/v1/games/analysis-corpus?"));
  const view = render(<RealtimeProvider>
    <SyncStatus total={5} latest={null} userId="admin" />
    <NotificationBell /><CoachingBookingAlert />
    <NotificationsCenter /><SiteIncidentBanner /><WhatsNewButton />
    <BuildCheckInProvider><CheckIn /></BuildCheckInProvider>
    <AnalyzerProvider analysisGamesEnabled><AnalyzerRevision /></AnalyzerProvider>
    <AnalyzerFrame me={{ userId: "admin", source: "cloud", games: { total: 0, latest: null }, agentPaired: false }}><span>Analyzer content</span></AnalyzerFrame>
    <Import /><CoachingPractice role="student" />
    <AdminShell><Dashboard /><Notifications /></AdminShell>
  </RealtimeProvider>);
  await act(async () => {});
  expect(corpusCalls()).toHaveLength(1);
  expect(h.io).toHaveBeenCalledTimes(1);
  const counts = h.resources.get("/v1/admin/events/counts")!.mutate;
  const dashboard = h.resources.get("/v1/admin/events?limit=8")!.mutate;
  const notifications = h.resources.get("/v1/admin/events?limit=50&unread=true")!.mutate;
  act(() => h.handlers.get("connect")?.());
  expect(counts).toHaveBeenCalledTimes(3); expect(dashboard).toHaveBeenCalledOnce(); expect(notifications).toHaveBeenCalledOnce();
  expect(screen.getAllByText("● Live")).toHaveLength(2);
  act(() => h.handlers.get("admin:event")?.({ eventId: "a", type: "user_signup", createdAt: new Date().toISOString(), payload: {}, readAt: null }));
  expect(counts).toHaveBeenCalledTimes(6); expect(notifications).toHaveBeenCalledTimes(2); expect(screen.getByText("Live durable event")).toBeTruthy();
  act(() => { h.handlers.get("disconnect")?.("transport close"); h.handlers.get("connect")?.(); });
  expect(counts).toHaveBeenCalledTimes(9); expect(dashboard).toHaveBeenCalledTimes(2); expect(notifications).toHaveBeenCalledTimes(3);
  act(() => {
    h.handlers.get("notifications:changed")?.({}); h.handlers.get("coaching:booking")?.({});
    h.handlers.get("import:progress")?.({ jobId: "job", completed: 4 });
    h.handlers.get("games:changed")?.({ count: 2, inserted: 1, bulk: false, reason: "ingest" });
  });
  expect(h.resources.get("/v1/me/notifications/unread-count")!.mutate).toHaveBeenCalledTimes(6);
  expect(h.resources.get("/v1/coaching/alerts")!.mutate).toHaveBeenCalledOnce();
  expect(screen.getByTestId("import").textContent).toBe("4"); expect(screen.getByText("6")).toBeTruthy();
  expect(screen.getByTestId("analyzer").textContent).toBe("0"); expect(h.refresh).not.toHaveBeenCalled();
  await act(async () => { vi.advanceTimersByTime(2000); });
  await act(async () => { vi.advanceTimersByTime(1); });
  expect(corpusCalls()).toHaveLength(2);
  expect(h.resources.get("/v1/coaching/assignments?page=1&limit=20")!.mutate).toHaveBeenCalledOnce();
  expect(screen.getByTestId("analyzer").textContent).toBe("1"); expect(screen.getByTestId("checkin").textContent).toBe("1"); expect(h.refresh).toHaveBeenCalledOnce();
  act(() => h.handlers.get("games:changed")?.({ count: 25, inserted: 2, bulk: true, reason: "ingest" }));
  expect(screen.getByText("8")).toBeTruthy();
  await act(async () => { vi.advanceTimersByTime(29999); });
  expect(corpusCalls()).toHaveLength(2);
  expect(screen.getByTestId("analyzer").textContent).toBe("1");
  await act(async () => { vi.advanceTimersByTime(1); });
  await act(async () => { vi.advanceTimersByTime(1); });
  expect(corpusCalls()).toHaveLength(3);
  expect(screen.getByTestId("analyzer").textContent).toBe("2");
  expect(screen.getByTestId("checkin").textContent).toBe("2");
  expect(h.refresh).toHaveBeenCalledTimes(2);
  await act(async () => { h.handlers.get("site:banner")?.({ hash: "notice-2" }); });
  expect(h.apiCall.mock.calls.filter(([, path]) => path === "/v1/site/banner?v=notice-2")).toHaveLength(1);
  expect(corpusCalls()).toHaveLength(3);
  expect(h.io).toHaveBeenCalledTimes(1); view.unmount(); act(() => vi.advanceTimersByTime(0)); expect(h.disconnect).toHaveBeenCalledOnce();
});
