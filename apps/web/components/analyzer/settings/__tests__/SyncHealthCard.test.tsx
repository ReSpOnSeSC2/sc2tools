import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";
import type { SyncHealthResponse } from "@/lib/syncHealth";
import { SyncHealthCard } from "../SyncHealthCard";

const h = vi.hoisted(() => ({ answer: undefined as SyncHealthResponse | Error | undefined, fetch: vi.fn(), options: {} as Record<string, unknown> }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: "owner", isLoaded: true, isSignedIn: true, getToken: async () => "synthetic" }) }));
vi.mock("@/lib/clientApi", async () => {
  const { default: useSWR } = await import("swr");
  return { ...await vi.importActual<typeof import("@/lib/clientApi")>("@/lib/clientApi"), useApi: (path: string, options: Record<string, unknown>) => {
    h.options = options;
    return useSWR(path, async () => { h.fetch(path); if (h.answer instanceof Error) throw h.answer; return h.answer; },
      { ...options, dedupingInterval: 0, shouldRetryOnError: false });
  } };
});
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: ({ children, slug, anchor }: { children: ReactNode; slug: string; anchor?: string }) =>
  <a href={`/help/${slug}${anchor ? `#${anchor}` : ""}`}>{children}</a> }));
vi.mock("@/components/feedback/LazyReportIssueModal", () => ({ LazyReportIssueModal: ({ open, onClose, prefill }: { open: boolean; onClose: () => void; prefill: { message: string } }) =>
  open ? <div role="dialog" aria-label="Report a problem"><pre>{prefill.message}</pre><button type="button" onClick={onClose}>Close report</button></div> : null }));

const CHECKED = "2026-11-01T12:00:00.000Z";
function answer(overrides: Partial<SyncHealthResponse> = {}): SyncHealthResponse {
  return { checkedAt: CHECKED, reported: true, rows: [], devices: [], rejections: null, ...overrides };
}
function mount() {
  const cache = new Map();
  return render(<SWRConfig value={{ provider: () => cache }}><SyncHealthCard /></SWRConfig>);
}
beforeEach(() => { h.fetch.mockReset(); h.options = {}; h.answer = undefined; });
afterEach(cleanup);

describe("Settings Sync health", () => {
  it("shows all six reasons with their fixes, privately lists unresolved names and reports only codes and counts", async () => {
    h.answer = answer({
      rows: [
        { code: "agent_no_folders", severity: "warn", count: 1, deviceId: "pc", helpSlug: "desktop-app-status", fix: "add_folder" },
        { code: "agent_paused", severity: "info", count: 2, deviceId: "pc", helpSlug: "desktop-app-status", fix: "resume" },
        { code: "agent_upload_failing", severity: "error", count: 4, deviceId: "pc", helpSlug: "desktop-app-status", fix: "retry" },
        { code: "agent_outdated_required", severity: "warn", count: 1, deviceId: "pc", helpSlug: "desktop-app-status", fix: "update_agent" },
        { code: "replays_skipped_unresolved", severity: "warn", count: 3, deviceId: "pc", helpSlug: "my-game-didnt-show-up", fix: "add_identity" },
        { code: "uploads_rejected", severity: "warn", count: 2, helpSlug: "my-game-didnt-show-up", fix: "report" },
      ],
      devices: [{ deviceId: "pc", label: "Synthetic PC", lastSeenAt: CHECKED, reported: true, syncReportedAt: CHECKED,
        sync: { filtered: 12, skipped: { ai_game: 2, parse_failed: 1 }, unresolvedNames: [{ name: "Synthetic Player", toonHandle: "1-S2-1-424242", count: 3 }] } }],
      rejections: { count: 2, byCode: { validation_failed: 2 }, since: CHECKED, lastRejectedAt: CHECKED },
    });
    mount();
    expect(await screen.findByRole("heading", { name: "5 things need attention" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Uploads are failing" }).closest("li")?.querySelector("svg")?.getAttribute("class")).toContain("text-danger");
    expect(screen.getByText("Open the desktop app and add your replay folder.")).toBeTruthy();
    expect(screen.getByText("Press Resume syncing in the desktop app.")).toBeTruthy();
    expect(screen.getByText("Open the desktop app and press Retry now.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Update agent" }).getAttribute("href")).toBe("/download");
    expect(screen.getByRole("link", { name: "Set up profile" }).getAttribute("href")).toBe("/settings?tab=profile");
    expect(screen.getByRole("link", { name: "Change sync window" }).getAttribute("href")).toBe("/help/desktop-app-sync-range#choose-range");
    expect(screen.getByRole("link", { name: "Learn more about player not recognized" }).getAttribute("href")).toBe("/help/my-game-didnt-show-up#sync-player-unresolved");
    expect(screen.getByText("Synthetic Player")).toBeTruthy();
    expect(screen.getByText("1-S2-1-424242")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add as my account: Synthetic Player" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry with latest agent: unrecognized players on Synthetic PC" })).toBeTruthy();
    fireEvent.click(screen.getByText("Other skipped replays"));
    expect(screen.getByText(/Skipped — game vs the AI\./)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Retry with latest agent/ })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Report" }));
    const dialog = screen.getByRole("dialog", { name: "Report a problem" });
    expect(dialog.textContent).toContain("- uploads_rejected: 2");
    expect(dialog.textContent).toContain("- rejected validation_failed: 2");
    expect(dialog.textContent).not.toMatch(/Synthetic Player|1-S2-1-424242|Synthetic PC/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Close report" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("reads once on mount, refreshes on request and preserves the last answer with a visible refresh error", async () => {
    h.answer = answer(); mount();
    expect(await screen.findByRole("heading", { name: "Syncing normally" })).toBeTruthy();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.options).toEqual({ revalidateOnFocus: false, revalidateOnReconnect: false });
    h.answer = new Error("synthetic network failure");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Check again" })); });
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Couldn't refresh sync health"));
    expect(screen.getByRole("heading", { name: "Syncing normally" })).toBeTruthy();
    h.answer = answer({ reported: false, devices: [] });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Check again" })); });
    expect(await screen.findByRole("heading", { name: "No desktop app linked" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(h.fetch).toHaveBeenCalledTimes(3);
  });

  it("recovers a first-read failure without pretending the desktop app is healthy", async () => {
    h.answer = new Error("synthetic network failure"); mount();
    const retry = await screen.findByRole("button", { name: /Retry/ });
    expect(screen.queryByRole("heading", { name: "Syncing normally" })).toBeNull();
    h.answer = answer({ reported: false, devices: [{ deviceId: "old", lastSeenAt: CHECKED, reported: false }] });
    await act(async () => { fireEvent.click(retry); });
    expect(await screen.findByText(/This desktop app version doesn't report sync health yet/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Why it isn't reported" }).getAttribute("href")).toBe("/help/my-game-didnt-show-up#sync-not-reported");
    expect(screen.getByRole("link", { name: "Update agent" }).getAttribute("href")).toBe("/download");
  });

  it("keeps the loading shape until an answer arrives", async () => {
    mount();
    expect(screen.getByRole("heading", { name: "Sync health" })).toBeTruthy();
    await waitFor(() => expect(h.fetch).toHaveBeenCalledWith("/v1/me/sync-health"));
    expect(screen.queryByText("Your desktop app reports no sync problems.")).toBeNull();
  });
});
