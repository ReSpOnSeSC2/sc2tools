import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TOURS, type TourId } from "@/lib/tours";
import { FiltersContext } from "@/lib/filterContext";
import { ToastProvider } from "@/components/ui/Toast";
import { TodayView } from "@/components/dashboard/TodayView";
import { AnalysisGamesProvider } from "@/components/analyzer/arcade/hooks/useAnalysisGames";
import { LevelUpChecklist } from "./LevelUpChecklist";
import { GameDetailPage } from "@/components/analyzer/game/GameDetailPage";
import { SettingsOverlay } from "@/components/analyzer/settings/SettingsOverlay";
import { SettingsContextProvider } from "@/components/analyzer/settings/SettingsContext";
import { BuildCheckInProvider } from "@/components/build-checkin/BuildCheckInProvider";
import { ACTIVATION_PATH } from "@/lib/activation";
import { defaultOverlayProfile, type OverlayProfile } from "@/lib/overlayProfile";
import { BuildCheckInCard } from "@/components/build-checkin/BuildCheckInCard";
import { intent, confirmedResponse } from "@/components/build-checkin/__tests__/cardFixtures";
import type { GameIntentState } from "@/lib/buildIntent";

const fixture = vi.hoisted(() => ({ dismissed: false, complete: false, games: 2, firstRun: false,
  previous: false, gameId: "game-one", checkIn: null as GameIntentState | null, admissions: [] as { id: string; ready: boolean; recordKey?: string }[], writes: vi.fn(), mutate: vi.fn(), token: vi.fn(async () => "synthetic") }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: "synthetic-owner", isLoaded: true, isSignedIn: true, getToken: fixture.token }), useUser: () => ({ isLoaded: true, user: { id: "synthetic-owner" } }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }), usePathname: () => location.pathname, useSearchParams: () => new URLSearchParams(location.search) }));
// This boundary supplies no target ids. Every registered target comes from its actual owner below.
vi.mock("./GuidedTours", () => ({ GuidedTours: ({ children, className, ...admission }: { children: ReactNode; className?: string; id: string; ready: boolean; recordKey?: string }) => { fixture.admissions.push(admission); return <div className={className}>{children}</div>; } }));
vi.mock("@/components/dashboard/AnalyzerFrame", () => ({ useDashboardMe: () => ({ agentPaired: true, games: { total: fixture.games, latest: null } }), onboardingView: () => ({ checklist: fixture.firstRun }) }));
vi.mock("@/lib/instant/useInstantImport", () => ({ useInstantImport: () => ({ enabled: false, mode: "off", loading: false }) }));
vi.mock("@/components/dashboard/AgentUpgradeNotice", () => ({ AgentUpgradeNotice: () => null }));
vi.mock("@/components/scouting/LiveScoutingBrief", () => ({ LiveScoutingBrief: () => null }));
vi.mock("@/lib/useUserSocket", () => ({ useUserSocket: () => undefined }));
// Visit-marker persistence is separately covered by its actual integration suite.
vi.mock("./useFirstGameViewed", () => ({ useFirstGameViewed: () => "idle" }));
vi.mock("@/lib/useGhostPractice", () => ({ useGhostPractice: () => ({ owner: "synthetic-owner", config: { v: 2, slots: {} }, hasConfig: true, loading: false, saving: false, offline: false, readError: null, error: null, assign: fixture.writes, migrate: fixture.writes, retry: fixture.mutate }) }));
vi.mock("@/components/analyzer/settings/SettingsStreamingTokenOwner", () => ({ useSettingsStreamingToken: () => ({ ownerId: "synthetic-owner", token: { token: "synthetic-private", label: "Fixture", enabledWidgets: [], createdAt: "2026-10-26" }, credential: { key: 1 }, getToken: fixture.token, isCurrent: () => true, refresh: fixture.mutate, patchToken: vi.fn() }) }));
// Only the admitted profile owner is synthetic; actual Setup/Widgets/Scenes/Theme owners render.
vi.mock("@/components/analyzer/settings/OverlayProfileEditor", () => ({ OverlayProfileEditor: ({ children }: { children: (value: { profile: OverlayProfile; saving: boolean; setTheme: () => void; setDuration: () => void }) => ReactNode }) => children({ profile: defaultOverlayProfile(), saving: false, setTheme: vi.fn(), setDuration: vi.fn() }) }));
vi.mock("@/lib/clientApi", async original => ({
  ...await original<typeof import("@/lib/clientApi")>(),
  apiCall: (...args: unknown[]) => { fixture.writes(...args); throw new Error("Target contract rendering cannot write"); },
  useApi: (path: string | null) => {
    let data: unknown, error: unknown;
    if (path === ACTIVATION_PATH) data = { identity: fixture.complete, firstGameViewed: fixture.complete, customBuild: fixture.complete, checkIn: fixture.complete, overlayLive: fixture.complete, chatOn: fixture.complete, goals: [], levelUpDismissedAt: fixture.dismissed ? "2026-10-26T12:00:00.000Z" : null };
    else if (path === "/v1/games/game-one") data = { gameId: fixture.gameId, date: "2026-10-26T12:00:00Z", myRace: "Protoss", opponent: { displayName: "Synthetic opponent", race: "Terran" }, result: "Victory", map: "Synthetic map", durationSec: 420 };
    else if (path?.includes("/build-intent") && fixture.checkIn) data = fixture.checkIn;
    else if (path === "/v1/me") data = { agentPaired: true, games: { total: 2 } };
    else if (path?.includes("/scenes")) data = { items: [] };
    else if (path?.startsWith("/v1/games?")) data = { items: [] };
    else error = { status: 503, message: "Synthetic unavailable metric" };
    return { data, error, isLoading: false, isValidating: false, isPreviousData: path === "/v1/games/game-one" && fixture.previous, mutate: fixture.mutate, request: fixture.writes };
  },
}));

beforeAll(async () => { await Promise.all([import("@/components/analyzer/LadderPulse"), import("@/components/analyzer/game/GameMacroSection"), import("@/components/analyzer/game/GameBuildOrderColumns")]); });
beforeEach(() => {
  fixture.dismissed = false; fixture.complete = false; fixture.games = 2; fixture.firstRun = false; fixture.previous = false; fixture.gameId = "game-one"; fixture.checkIn = null; fixture.admissions = []; fixture.writes.mockReset(); fixture.mutate.mockReset(); localStorage.clear();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function mount(children: ReactNode) { return render(<SWRConfig value={{ provider: () => new Map() }}><ToastProvider><SettingsContextProvider><BuildCheckInProvider><FiltersContext.Provider value={{ filters: {}, setFilters: vi.fn(), dbRev: 0, bumpRev: vi.fn(), seasons: [] }}><AnalysisGamesProvider>{children}</AnalysisGamesProvider></FiltersContext.Provider></BuildCheckInProvider></SettingsContextProvider></ToastProvider></SWRConfig>); }
function targets(id: TourId) {
  for (const step of TOURS[id].steps) {
    const nodes = document.querySelectorAll('[data-tour="' + step.target + '"]'); expect(nodes).toHaveLength(1);
    const target = nodes[0]; expect(target.textContent?.trim()).not.toBe(""); expect(target.closest("[hidden],[aria-hidden='true'],[inert]")).toBeNull();
  }
  expect(fixture.writes).not.toHaveBeenCalled();
}

describe("each tour's real target owners", () => {
  it("renders all four Today targets around actual consumers and a real next-steps card", async () => {
    mount(<TodayView />); await screen.findByRole("heading", { name: "Get more out of SC2 Tools" });
    await waitFor(() => targets("today"));
    expect(document.querySelector('[data-tour="today-summary"] [data-testid="dashboard-kpi-strip"]')).not.toBeNull();
    expect(document.querySelector('[data-tour="today-daily-pulse"] [aria-label="Daily Pulse"]')).not.toBeNull();
    expect(document.querySelector('[data-tour="today-next-steps"]')?.tagName).toBe("SECTION");
    expect(screen.getByRole("link", { name: "Take the Today tour" }).getAttribute("href")).toBe("/app?tour=today");
  });
  it("uses the real compact card when complete and has no invented target when dismissed", async () => {
    fixture.complete = true; const view = mount(<LevelUpChecklist />);
    await screen.findByRole("link", { name: "see What's new" });
    expect(document.querySelector('[data-tour="today-next-steps"]')?.textContent).toContain("You're all set");
    view.unmount(); fixture.dismissed = true; mount(<LevelUpChecklist />);
    await waitFor(() => expect(document.querySelector('[data-tour="today-next-steps"]')).toBeNull());
  });
  it("renders the game's four actual visible section/navigation targets without opening a pane", async () => {
    mount(<GameDetailPage gameId="game-one" />); await screen.findByRole("heading", { name: "Map replay Help" });
    await waitFor(() => targets("game"));
    for (const id of ["replay", "macro", "builds"]) expect(document.getElementById(id)?.hasAttribute("data-tour")).toBe(true);
    const navigation = document.querySelector('[data-tour="game-navigation"]');
    expect(navigation).toBe(screen.getByRole("navigation", { name: "Game sections" }));
    expect(navigation?.parentElement?.classList.contains("contents")).toBe(true);
    const containingBlock = navigation?.parentElement?.parentElement;
    expect(containingBlock?.parentElement).toBe(document.querySelector("[data-game-workspace]"));
    expect(containingBlock?.contains(document.getElementById("builds"))).toBe(true);
    expect(fixture.admissions.some(admission => admission.id === "game" && admission.ready && admission.recordKey === "game-one")).toBe(true);
  });
  it("does not admit a retained or mismatched game body", () => {
    fixture.previous = true; const view = mount(<GameDetailPage gameId="game-one" />);
    expect(fixture.admissions.filter(admission => admission.id === "game").every(admission => !admission.ready)).toBe(true);
    view.unmount(); fixture.previous = false; fixture.gameId = "game-other"; fixture.admissions = []; mount(<GameDetailPage gameId="game-one" />);
    expect(fixture.admissions.filter(admission => admission.id === "game").every(admission => !admission.ready)).toBe(true);
  });
  it("renders the actual Overlay Setup, Widgets, Scenes and Theme Sections", async () => {
    mount(<SettingsOverlay origin="https://example.invalid" />); await screen.findByRole("heading", { name: "Overlay" });
    await waitFor(() => targets("overlay"));
    for (const id of ["setup", "widgets", "scenes", "theme"]) expect(document.getElementById(id)?.tagName).toBe("SECTION");
    expect(fixture.admissions.some(admission => admission.id === "overlay" && admission.ready && admission.recordKey === "1")).toBe(true);
  });
  it.each(["full", "collapsed", "confirmed"] as const)("marks the actual %s check-in variant for viewport suppression", async variant => {
    fixture.checkIn = variant === "confirmed" ? intent({ ...confirmedResponse("custom:fixture", "Fixture build"), gameId: "game-one" })
      : intent({ gameId: "game-one", ...(variant === "collapsed" ? { status: "none" as const, suggestion: null, randomizer: null } : {}) });
    mount(<BuildCheckInCard gameId="game-one" />);
    const testId = variant === "confirmed" ? "build-checkin-summary" : variant === "collapsed" ? "build-checkin-compact" : "build-checkin-card";
    const card = await screen.findByTestId(testId); expect(card.closest('[data-tour-blocker="check-in"]')).not.toBeNull();
    expect(fixture.writes).not.toHaveBeenCalled();
  });
});
