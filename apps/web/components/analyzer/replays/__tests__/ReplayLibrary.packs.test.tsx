import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Suspense, type ReactNode } from "react";
import { ReplayLibrary } from "../ReplayLibrary";
import type { ReplayListProps } from "../ReplayList";
import type { ReplayLibraryItem } from "../types";
import type { PackNameMetadata, PackNameTemplate } from "@/lib/exports/replayPacks/packNames";
import type { ReplayPackProgress, ReplayPackResult } from "@/lib/exports/replayPacks/downloadReplayPack";
import { deferred, jsonResponse } from "@/lib/exports/replayPacks/replayPackTestFixtures";
import { exportBusy, withExportAdmission } from "@/lib/exports/exportAdmission";

vi.hoisted(async () => { const codecs = await import("node:util"); Object.assign(globalThis, { TextEncoder: codecs.TextEncoder, TextDecoder: codecs.TextDecoder }); });
const state = vi.hoisted(() => ({ cursor: null as string | null, pending: false, previous: false, search: "", owner: "owner-a" }));
const mocks = vi.hoisted(() => ({ run: vi.fn(async (_rows: readonly PackNameMetadata[], _template: PackNameTemplate) => true), cancel: vi.fn(), clear: vi.fn(), scopes: [] as string[], targets: [] as string[][],
  token: vi.fn(async (): Promise<string | null> => "synthetic"), feedback: null as null | { message: string; result?: ReplayPackResult; progress?: ReplayPackProgress } }));
type PackControlsModule = typeof import("../ReplayPackControls");
vi.mock("next/dynamic", async () => { const react = await import("react"); return { default: (loader: () => Promise<PackControlsModule>) => react.lazy(loader) }; });
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: state.owner, getToken: mocks.token }) }));
vi.mock("@/lib/filterContext", async original => ({ ...await original<object>(), useFilters: () => ({ filters: { since: "2026-08-01" }, seasons: [], dbRev: 1, setFilters: vi.fn() }) }));
vi.mock("@/lib/useReplayListFilters", () => ({ useReplayListFilters: () => ({ search: state.search, setSearch: (value: string) => { state.search = value; state.pending = true; },
  result: "all", setResult: vi.fn(), matchup: "all", setMatchup: vi.fn(), sort: "date_asc", setSort: vi.fn(), before: "", setBefore: vi.fn(),
  committed: { search: "", result: "all", matchup: "all", sort: "date_asc", before: "", cursor: state.cursor }, pendingFilters: state.pending,
  reset: vi.fn(), clearCursor: () => { state.cursor = null; }, setCursor: (cursor: string | null) => { state.cursor = cursor; } }) }));
vi.mock("@/lib/clientApi", async original => ({ ...await original<typeof import("@/lib/clientApi")>(), useApi: () => ({
  data: { profile: { handle: "owner", displayName: "Owner" }, items: Array.from({ length: 25 }, (_, index) => ({ gameId: `id-${(state.cursor ? 100 : 0) + index}`, result: "Win" })), page: { hasMore: !state.cursor, nextCursor: state.cursor ? null : "next" }, total: 140 },
  isPreviousData: state.previous, isLoading: false, isValidating: false, mutate: vi.fn() }) }));
vi.mock("../ReplayShareControl", () => ({ ReplayShareControl: () => <span>Share</span> }));
vi.mock("../ReplayCsvExportButton", () => ({ ReplayCsvExportButton: () => <span>CSV</span> }));
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: ({ slug, children }: { slug: string; children: ReactNode }) => <a href={`/help/${slug}`}>{children}</a> }));
vi.mock("../ReplayList", () => ({ ReplayList: ({ items, selection }: ReplayListProps) => <div>{items.map(row => selection ? <input key={row.gameId} type="checkbox" aria-label={`${selection.label || "Select replay"} ${row.gameId}`}
  checked={selection.selectedIds.has(row.gameId)} disabled={selection.disabled || selection.isDisabled?.(row.gameId)} onChange={() => selection.onToggle(row.gameId)} /> : <span key={row.gameId}>{row.gameId}</span>)}</div> }));
vi.mock("../GameControlActions", () => ({ GameControlActions: ({ targets }: { targets: readonly ReplayLibraryItem[] }) => {
  mocks.targets.push(targets.map(row => row.gameId)); return <span>Manage targets: {targets.length}</span>;
} }));
vi.mock("@/lib/exports/replayPacks/useReplayPackDownload", async () => {
  const { exportBusy } = await import("@/lib/exports/exportAdmission");
  return { useReplayPackDownload: (scope: string) => {
    mocks.scopes.push(scope); return { owner: state.owner, busy: exportBusy(), feedback: mocks.feedback, run: mocks.run, cancel: mocks.cancel, clear: mocks.clear };
  } };
});

function show() { return <Suspense fallback={<p>Loading pack…</p>}><ReplayLibrary /></Suspense>; }
beforeEach(() => {
  state.cursor = null; state.pending = false; state.previous = false; state.search = ""; state.owner = "owner-a";
  mocks.run.mockReset().mockResolvedValue(true); mocks.cancel.mockClear(); mocks.clear.mockClear(); mocks.scopes.length = 0; mocks.targets.length = 0; mocks.feedback = null;
  window.localStorage.clear(); window.sessionStorage.clear(); window.requestAnimationFrame = callback => { callback(0); return 1; };
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); expect(exportBusy()).toBe(false); });

describe("separate ReplayLibrary pack mode", () => {
  it("uses the D2 hook's one reservation and keeps mode/row/close actions disabled through actual cleanup after cancel", async () => {
    const cleanupDone = deferred(); let actual: Promise<void> | undefined;
    mocks.run.mockImplementationOnce(async () => { actual = withExportAdmission(() => cleanupDone.promise); return false; });
    render(show()); fireEvent.click(screen.getByRole("button", { name: "Replay pack" })); await screen.findByRole("button", { name: "Download replay pack" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select replay for pack id-0" }));
    try {
      fireEvent.click(screen.getByRole("button", { name: "Download replay pack" })); await screen.findByRole("button", { name: "Cancel replay pack" });
      expect(mocks.run).toHaveBeenCalledOnce(); expect(exportBusy()).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "Cancel replay pack" })); expect(mocks.cancel).toHaveBeenCalledOnce();
      expect((screen.getByRole("button", { name: "Stopping replay pack…" }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole("button", { name: "Close replay pack" }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole("button", { name: "Select replays" }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole("checkbox", { name: "Select replay for pack id-0" }) as HTMLInputElement).disabled).toBe(true);
      await act(async () => { cleanupDone.resolve(); await actual; }); await waitFor(() => expect(exportBusy()).toBe(false));
    } finally { cleanupDone.resolve(); await actual; }
  });

  it("selects first100 atomically, keeps them across pages, calls D2 once and never supplies them to page25 destructive controls", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ items: Array.from({ length: 100 }, (_, index) => ({ gameId: `id-${index}`, result: "Win" })) })); vi.stubGlobal("fetch", fetch);
    const view = render(show()); fireEvent.click(screen.getByRole("button", { name: "Replay pack" }));
    await screen.findByRole("button", { name: "Select matching (up to 100)" });
    expect((screen.getByRole("button", { name: "Select replays" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Select matching (up to 100)" }));
    await screen.findByText("100 of 100 selected"); expect(fetch).toHaveBeenCalledOnce();
    const params = new URL(String(fetch.mock.calls[0][0]), "https://api.example.test").searchParams;
    expect(params.get("limit")).toBe("100"); expect(params.get("enrich")).toBe("none"); expect(params.get("sort")).toBe("date_asc"); expect(params.has("cursor")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Download replay pack" }));
    await waitFor(() => expect(mocks.run).toHaveBeenCalledOnce()); expect(mocks.run.mock.calls[0]).toHaveLength(2);
    expect(mocks.run).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ gameId: "id-99", result: "Win" })]), "descriptive");
    fireEvent.click(screen.getByRole("button", { name: "Older" })); view.rerender(show()); expect(screen.getByText("100 of 100 selected")).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "Select replay for pack id-100" }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Close replay pack" }));
    fireEvent.click(screen.getByRole("button", { name: "Select replays" })); fireEvent.click(screen.getByRole("button", { name: "Select this page" }));
    expect(screen.getByText("Manage targets: 25")).toBeTruthy(); expect(mocks.targets.every(targets => targets.length <= 25)).toBe(true);
    expect(mocks.targets.at(-1)).toEqual(Array.from({ length: 25 }, (_, index) => `id-${index + 100}`));
    expect((screen.getByRole("button", { name: "Replay pack" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("pending/previous list data is inert and result/progress use only the fixed D2 interface", async () => {
    const view = render(show()); fireEvent.click(screen.getByRole("button", { name: "Replay pack" })); await screen.findByRole("button", { name: "Download replay pack" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select replay for pack id-0" })); expect(screen.getByText("1 of 100 selected")).toBeTruthy();
    const ready = mocks.scopes.at(-1); state.pending = true; state.search = "uncommitted"; view.rerender(show());
    expect((screen.getByRole("button", { name: "Download replay pack" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Select replay for pack id-0" }) as HTMLInputElement).disabled).toBe(true); expect(mocks.scopes.at(-1)).not.toBe(ready);
    state.pending = false; state.search = ""; state.previous = true; view.rerender(show());
    expect((screen.getByRole("button", { name: "Select matching (up to 100)" }) as HTMLButtonElement).disabled).toBe(true); expect(mocks.run).not.toHaveBeenCalled();
    state.previous = false; mocks.feedback = { message: "Replay pack saved: 1 saved, 1 unavailable or failed.", result: { requested: 2, saved: 1, failed: 1, bytes: 1024 ** 2, items: [{ gameId: "one", filename: "one.SC2Replay", status: "saved" }, { gameId: "two", filename: "", status: "failed" }] }, progress: { phase: "finishing", completed: 2, total: 2, downloadedBytes: 4, archiveBytes: 1024 ** 2 } }; view.rerender(show());
    expect(screen.getByText(/1 original file saved; 1 unavailable or failed/u)).toBeTruthy(); expect(screen.getByText(/2 of 2 files checked/u)).toBeTruthy(); expect(screen.getByText(/Archive: 1.0 MiB/u)).toBeTruthy();
    expect(screen.getByText(/player and account identifiers, chat and team information/u)).toBeTruthy();
  });
});
