import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplayCsvExportButton } from "../ReplayCsvExportButton";
import { replayCsvPath } from "@/lib/replayCsvDownload";
const auth = vi.hoisted(() => ({ userId: "owner-a" as string | null, isLoaded: true, isSignedIn: true, getToken: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => auth }));
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const body = new Blob(["\uFEFFdate,opponent\r\n2026-10-25,'=1+1\r\n"], { type: "text/csv;charset=utf-8" });
const response = (truncated = false) => ({ ok: true, headers: new Headers({ "X-Export-Truncated": String(truncated) }), blob: async () => body });
let create: ReturnType<typeof vi.fn>, revoke: ReturnType<typeof vi.fn>, fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  Object.assign(auth, { userId: "owner-a", isLoaded: true, isSignedIn: true }); auth.getToken.mockReset().mockResolvedValue("token-a");
  fetcher = vi.fn().mockResolvedValue(response()); vi.stubGlobal("fetch", fetcher);
  create = vi.fn(() => "blob:download"); revoke = vi.fn();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: create }); Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("private CSV export", () => {
  it("keeps actual filters/search/result/matchup and removes paging, credentials and unknown keys", async () => {
    const query = "race=P&accounts=2-s2-1-2,1-S2-1-1&search=Rival&result=loss&matchup=PvZ&sort=date_asc&cursor=old&limit=10&token=secret&owner=other";
    render(<ReplayCsvExportButton query={query} />);
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("CSV download started."));
    const [url, init] = fetcher.mock.calls[0], params = new URL(url).searchParams;
    expect(params.get("accounts")).toBe("1-S2-1-1,2-S2-1-2"); expect(params.get("search")).toBe("Rival");
    expect(params.get("result")).toBe("loss"); expect(params.get("matchup")).toBe("PvZ");
    expect(params.get("sort")).toBe("date_asc");
    expect(url).not.toMatch(/cursor|limit|secret|owner/); expect(init).toMatchObject({ cache: "no-store", headers: { authorization: "Bearer token-a" } });
    expect(create).toHaveBeenCalledWith(body); expect(revoke).toHaveBeenCalledWith("blob:download");
    expect(screen.getByText(/up to 50,000 games/)).toBeTruthy();
  });
  it("announces server truncation and allows a retry after rate limiting", async () => {
    fetcher.mockResolvedValueOnce({ ok: false, status: 429 }).mockResolvedValueOnce(response(true));
    render(<ReplayCsvExportButton query="" />);
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("one per minute"));
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("first 50,000 matching games in the selected sort order"));
    expect(create).toHaveBeenCalledTimes(1);
  });
  it.each(["owner", "loading", "signout", "query"])("cancels late token work across %s changes", async boundary => {
    const token = deferred<string | null>(); auth.getToken.mockReturnValueOnce(token.promise);
    const view = render(<ReplayCsvExportButton query="race=P" />);
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    if (boundary === "owner") auth.userId = "owner-b";
    if (boundary === "loading") auth.isLoaded = false;
    if (boundary === "signout") Object.assign(auth, { isSignedIn: false, userId: null });
    view.rerender(<ReplayCsvExportButton query={boundary === "query" ? "race=T" : "race=P"} />);
    await act(async () => { token.resolve("stale-token"); await token.promise; });
    expect(fetcher).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled(); expect(screen.queryByRole("status")).toBeNull();
  });
  it("discards an old-owner body even if an underlying fetch ignores abort", async () => {
    const pending = deferred<Blob>(); fetcher.mockResolvedValueOnce({ ...response(), blob: () => pending.promise });
    const view = render(<ReplayCsvExportButton query="" />);
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" })); await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    auth.userId = "owner-b"; view.rerender(<ReplayCsvExportButton query="" />);
    await act(async () => { pending.resolve(body); await pending.promise; });
    expect(create).not.toHaveBeenCalled(); expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  });
  it("refuses missing authentication and malformed account cohorts before fetching", async () => {
    expect(() => replayCsvPath("accounts=1-S2-1-1,wrong")).toThrow();
    auth.getToken.mockResolvedValue(null); render(<ReplayCsvExportButton query="" />);
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Sign in again")); expect(fetcher).not.toHaveBeenCalled();
  });
  it("reports a connection failure and retries without a stale download", async () => {
    fetcher.mockRejectedValueOnce(new TypeError("Failed to fetch")); render(<ReplayCsvExportButton query="" />);
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Check your connection"));
    expect(create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  });
  it.each(["token", "body"])("deadline releases the button even if the %s promise never settles", async boundary => {
    vi.useFakeTimers(); const pending = deferred<never>();
    try {
      if (boundary === "token") auth.getToken.mockReturnValueOnce(pending.promise);
      else fetcher.mockResolvedValueOnce({ ...response(), blob: () => pending.promise });
      render(<ReplayCsvExportButton query="" />); fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
      await act(async () => { await vi.advanceTimersByTimeAsync(120000); });
      expect(screen.getByRole("status").textContent).toContain("Export timed out");
      expect((screen.getByRole("button", { name: "Export CSV" }) as HTMLButtonElement).disabled).toBe(false);
      expect(create).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
