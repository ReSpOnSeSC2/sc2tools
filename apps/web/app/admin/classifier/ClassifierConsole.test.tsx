import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClassifierConsoleResp, ClassifierSamplesResp } from "./classifierTypes";
import { navigation } from "../components/__tests__/navigationFixture";
vi.mock("next/navigation", () => import("../components/__tests__/navigationFixture"));

const { useApiMock, apiCallMock, mutate } = vi.hoisted(() => ({ useApiMock: vi.fn(), apiCallMock: vi.fn(), mutate: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: vi.fn(async () => "token") }) }));
vi.mock("@/lib/clientApi", () => ({ useApi: (...args: unknown[]) => useApiMock(...args), apiCall: (...args: unknown[]) => apiCallMock(...args) }));
import ClassifierPage from "./page";

const PAIR = { axis: "build" as const, matchup: "PvZ", detected: "PvZ - 2 Stargate Void Ray", declared: "PvZ - 2 Stargate Phoenix", count: 4, users: 3,
  origins: { pregame: 1, postgame: 2, web: 1, other: 0 }, lastConfirmedAt: null, engines: [{ engine: "agent", count: 3 }, { engine: "browser:1.6.3", count: 1 }] };
const OTHER = { ...PAIR, declared: "Custom build", count: 3 };
const CONSOLE: ClassifierConsoleResp = {
  snapshot: { generatedAt: "2026-11-10T03:00:00Z", windowStart: "2026-08-12T03:00:00Z", windowDays: 90, kFloor: 3,
    totals: { checkIns: 15, disagreements: 10, users: 6, suppressedPairs: 1, suppressedCheckIns: 2, truncated: false },
    engines: [{ engine: "agent", checkIns: 14, disagreements: 9, users: 6 }], origins: { pregame: 1, postgame: 12, web: 2, other: 0 }, matchups: ["PvZ", "ZvP"] },
  pairs: [PAIR, OTHER], pairsTotal: 2,
  labels: [{ axis: "build", label: "PvZ - 2 Stargate Phoenix", agree: 2, missed: 4, mislabeled: 0, users: 5 }], kFloor: 3, windowDays: 90, sampleLimit: 20,
};
const SAMPLES: ClassifierSamplesResp = {
  pair: PAIR, windowStart: "2026-08-12T03:00:00Z", sampleLimit: 20, sampleSeconds: 360,
  rules: { declared: { name: PAIR.declared, description: "Detected if two Stargates start before 5:00.", surfaces: ["you"], implementation: "procedural", policy: null }, detected: null },
  samples: [{ sample: 1, day: "2026-11-09", map: "Alcyone LE", durationSec: 600, gameVersion: "5.0.15", engine: "agent", origin: "postgame",
    race: "Protoss", opponentRace: "Zerg", buildLog: ["[0:00] Nexus", "[2:05] Stargate"], buildLogAvailable: true, buildLogTruncated: true }],
};
let consoleData: ClassifierConsoleResp = CONSOLE;
const paths = () => useApiMock.mock.calls.map(([path]) => path as string | null);

beforeEach(() => {
  navigation.url = "/admin/classifier";
  consoleData = CONSOLE;
  vi.clearAllMocks();
  mutate.mockResolvedValue(undefined);
  apiCallMock.mockResolvedValue({ ok: true });
  useApiMock.mockImplementation((path: string | null) => {
    if (path?.startsWith("/v1/admin/classifier/samples")) return { data: SAMPLES, error: null, isLoading: false, mutate };
    if (path?.startsWith("/v1/admin/classifier")) return { data: consoleData, error: null, isLoading: false, mutate };
    return { data: undefined, error: null, isLoading: false, mutate };
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("admin classifier console", () => {
  it("frames counts as disagreement volume with the k-floor, window and human-edited rules", () => {
    render(<ClassifierPage />);
    expect(screen.getByText(/disagreement volume from players who checked in, not an accuracy score/)).toBeTruthy();
    expect(screen.getByText(/at least 3 different players; 1 smaller pair \(2 check-ins\) is withheld/)).toBeTruthy();
    expect(screen.getByText(/last 90 days/)).toBeTruthy();
    expect(screen.getByText(/nothing here changes a detector rule/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Build Studio" }).getAttribute("href")).toBe("/admin/build-studio");
    expect(screen.getByText(/4 check-ins from 3 players · Pre-game plan 1, Post-game check-in 2, Website 1/)).toBeTruthy();
    expect(screen.getByText("9 of 14 check-ins disagree")).toBeTruthy();
  });

  it("keeps the axis, matchup, engine and view in the URL and the API query", () => {
    render(<ClassifierPage />);
    fireEvent.change(screen.getByRole("combobox", { name: "Axis" }), { target: { value: "opponent" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Matchup" }), { target: { value: "ZvP" } });
    fireEvent.click(screen.getByRole("button", { name: "Filter by Desktop agent" }));
    expect(new URL(navigation.url, "https://x.invalid").search).toBe("?axis=opponent&matchup=ZvP&engine=agent");
    expect(paths().at(-1)).toBe("/v1/admin/classifier?axis=opponent&matchup=ZvP&engine=agent");
    fireEvent.click(screen.getByRole("radio", { name: "Confusion" }));
    expect(navigation.url).toContain("tab=confusion");
    const group = screen.getByRole("heading", { name: PAIR.detected }).closest("div") as HTMLElement;
    expect(within(group).getAllByRole("button", { name: /^Samples/ })).toHaveLength(2);
    fireEvent.click(screen.getByRole("radio", { name: "Labels" }));
    expect(screen.getByText(/matches 2 · missed 4 · mislabeled 0 · 5 players/)).toBeTruthy();
  });

  it("drills into identity-free samples next to the declared rule and copies a test fixture", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<ClassifierPage />);
    fireEvent.click(screen.getByRole("button", { name: `Samples for ${PAIR.detected} → ${PAIR.declared} in PvZ` }));
    const dialog = screen.getByRole("dialog", { name: "Disagreement samples" });
    expect(paths()).toContain(`/v1/admin/classifier/samples?${new URLSearchParams({ axis: "build", matchup: "PvZ", detected: PAIR.detected, declared: PAIR.declared })}`);
    expect(within(dialog).getByText("Detected if two Stargates start before 5:00.")).toBeTruthy();
    expect(within(dialog).getByText(/No released rule/)).toBeTruthy();
    expect(within(dialog).getByLabelText("Build log up to 6:00 for sample 1").textContent).toBe("[0:00] Nexus\n[2:05] Stargate\n…");
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Copy as test fixture for sample 1" })); });
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    const fixture = JSON.parse(writeText.mock.calls[0][0] as string);
    expect(fixture).toMatchObject({ axis: "build", matchup: "PvZ", detected: PAIR.detected, declared: PAIR.declared, engine: "agent", buildLog: ["[0:00] Nexus", "[2:05] Stargate"] });
    expect(Object.keys(fixture)).not.toEqual(expect.arrayContaining(["userId"]));
    expect(JSON.stringify(fixture)).not.toMatch(/userId|gameId|opponentName/);
  });

  it("Recompute now runs the audited job and shows a retryable error on failure", async () => {
    apiCallMock.mockRejectedValueOnce({ status: 503, code: "job_failed", message: "Job failed. Check its last error and retry." });
    render(<ClassifierPage />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Recompute now" })); });
    expect(apiCallMock).toHaveBeenCalledWith(expect.any(Function), "/v1/admin/jobs/classifier-quality/run", { method: "POST" });
    expect(screen.getByRole("button", { name: /Retry/ })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Retry/ })); });
    expect(apiCallMock).toHaveBeenCalledTimes(2);
    expect(mutate).toHaveBeenCalled();
  });

  it("explains an empty first run", () => {
    consoleData = { snapshot: null, kFloor: 3, windowDays: 90, sampleLimit: 20 };
    render(<ClassifierPage />);
    expect(screen.getByText("No classifier snapshot yet")).toBeTruthy();
  });
});
