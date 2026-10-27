import type { ReactNode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AnalyzerProvider } from "@/components/AnalyzerProvider";
import { RealtimeProvider } from "@/components/realtime/RealtimeProvider";
import { CurrentSessionCard } from "../CurrentSessionCard";
import { currentHistory } from "./sessionHistoryFixtures";
import { sessionSummary } from "./sessionCardFixtures";

const harness = vi.hoisted(() => ({ owner: "owner-a", paths: [] as string[], response: undefined as ReturnType<typeof currentHistory> | undefined, io: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: harness.owner, isLoaded: true, isSignedIn: true, getToken: async () => "synthetic-token" }) }));
vi.mock("@/lib/useSeasons", async original => ({ ...await original<typeof import("@/lib/useSeasons")>(), useSeasons: () => ({ data: undefined }) }));
vi.mock("@/components/analyzer/arcade/hooks/useAnalysisGames", () => ({ AnalysisGamesProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("socket.io-client", () => ({ io: (...args: unknown[]) => harness.io(...args) }));
vi.mock("@/lib/clientApi", async () => {
  const React = await import("react");
  return { API_BASE: "http://fixture.invalid", useApi: (path: string | null) => {
    const owner = harness.owner, [data, setData] = React.useState<ReturnType<typeof currentHistory>>();
    const read = () => { if (!path) return; harness.paths.push(`${owner} ${path}`); setData(harness.response ? { ...harness.response } : undefined); };
    React.useEffect(read, [owner, path]);
    return { data, error: undefined, isPreviousData: false, isValidating: false, mutate: read };
  } };
});
type FixtureSocket = { fire: (event: string, payload?: unknown) => void; disconnect: ReturnType<typeof vi.fn> };
let sockets: FixtureSocket[] = [];
beforeEach(() => {
  vi.useFakeTimers(); harness.owner = "owner-a"; harness.paths = []; harness.response = currentHistory(); harness.io.mockReset(); sockets = []; localStorage.clear();
  harness.io.mockImplementation(() => {
    const events = new Map<string, (payload?: unknown) => void>();
    const socket = { connected: false, on: (event: string, callback: (payload?: unknown) => void) => { events.set(event, callback); return socket; }, off: () => { events.clear(); }, connect: vi.fn(), disconnect: vi.fn(), fire: (event: string, value?: unknown) => { events.get(event)?.(value); } };
    sockets.push(socket); return socket;
  });
});
afterEach(() => { cleanup(); act(() => vi.runOnlyPendingTimers()); vi.useRealTimers(); });
function tree() { return <RealtimeProvider><AnalyzerProvider><CurrentSessionCard /></AnalyzerProvider></RealtimeProvider>; }

it("propagates shared ingest and zero-insert manual-reset invalidations through AnalyzerProvider to the current endpoint", async () => {
  render(tree()); await act(async () => { await Promise.resolve(); });
  expect(harness.paths).toHaveLength(1); expect(harness.paths[0]).toContain("/v1/sessions/current?"); expect(harness.paths[0]).toContain("#0");
  harness.response = currentHistory({ session: sessionSummary({ id: "fresh-after-ingest" }) });
  await act(async () => { sockets[0].fire("games:changed", { count: 1, inserted: 1, reason: "ingest" }); vi.advanceTimersByTime(1999); });
  expect(harness.paths).toHaveLength(1);
  await act(async () => vi.advanceTimersByTime(1));
  expect(harness.paths).toHaveLength(2); expect(harness.paths[1]).toContain("#1");
  expect(screen.getByRole("link", { name: "View this session" }).getAttribute("href")).toContain("fresh-after-ingest");
  harness.response = currentHistory({ session: null, activity: "empty", manualAnchorAt: "2026-10-27T04:20:00.000Z" });
  await act(async () => { sockets[0].fire("games:changed", { count: 0, inserted: 0, bulk: false, reason: "session-reset" }); vi.advanceTimersByTime(2000); });
  expect(harness.paths).toHaveLength(3); expect(harness.paths[2]).toContain("#2");
  expect(screen.getByText("No session in the current view")).toBeTruthy(); expect(screen.queryByRole("link", { name: "View this session" })).toBeNull();
  expect(harness.io).toHaveBeenCalledTimes(1);
});

it("does not let the retired owner's socket reset or refresh the new owner's current card", async () => {
  const view = render(tree()); await act(async () => { await Promise.resolve(); }); const old = sockets[0];
  harness.owner = "owner-b"; harness.response = currentHistory({ session: sessionSummary({ id: "owner-b-current" }) }); view.rerender(tree());
  await act(async () => { await Promise.resolve(); }); const before = harness.paths.length;
  await act(async () => { old.fire("games:changed", { count: 0, inserted: 0, bulk: false, reason: "session-reset" }); vi.advanceTimersByTime(2000); });
  expect(harness.paths).toHaveLength(before);
  expect(screen.getByRole("link", { name: "View this session" }).getAttribute("href")).toContain("owner-b-current");
  expect(harness.io).toHaveBeenCalledTimes(2);
});
