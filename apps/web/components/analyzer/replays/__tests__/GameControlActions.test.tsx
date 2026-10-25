import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameControlActions } from "../GameControlActions";
const auth = vi.hoisted(() => ({ userId: "owner-a" as string | null, isLoaded: true, isSignedIn: true, getToken: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => auth }));
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const one = [{ gameId: "first", map: "Synthetic map", date: "2026-10-25T10:00:00Z" }];
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  Object.assign(auth, { userId: "owner-a", isLoaded: true, isSignedIn: true }); auth.getToken.mockReset().mockResolvedValue("token-a");
  fetcher = vi.fn(async (url: string, init: RequestInit) => ({ ok: true, status: 200, json: async () => ({ gameId: new URL(url).pathname.split("/").pop(), ...(init.method === "DELETE" ? { deleted: true } : JSON.parse(String(init.body))) }) }));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const confirm = () => screen.getByRole("button", { name: "Delete permanently" }) as HTMLButtonElement;
function startDelete(count = 1) {
  fireEvent.click(screen.getByRole("button", { name: count > 1 ? "Delete selected games…" : "Delete game…" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: count > 1 ? `DELETE ${count} GAMES` : "DELETE GAME" } });
  fireEvent.click(confirm());
}

describe("owner-fenced replay controls", () => {
  it("focuses Cancel, lists the exact game, and sends no delete until the exact typed phrase", async () => {
    const done = vi.fn(); render(<GameControlActions targets={one} scopeKey="list" onComplete={done} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete game…" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("dialog").textContent).toContain("first");
    expect(screen.getByRole("dialog").textContent).toContain("Local replay files are retained");
    expect(confirm().disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "delete game" } }); expect(confirm().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" })); expect(fetcher).not.toHaveBeenCalled();
    startDelete(); await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ confirmation: "DELETE GAME" });
    expect(done).toHaveBeenCalledWith([{ gameId: "first", deleted: true }]);
  });
  it("chooses a reason and serially applies a bounded bulk Hide", async () => {
    const first = deferred<unknown>(); fetcher.mockImplementationOnce(() => first.promise);
    const done = vi.fn(); render(<GameControlActions targets={[...one, { gameId: "second" }]} scopeKey="list" onComplete={done} />);
    fireEvent.click(screen.getByRole("button", { name: "Hide from stats" }));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.click(dialog.getByRole("button", { name: "Friend played" })); fireEvent.click(dialog.getByRole("button", { name: "Hide from stats" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ excluded: true, reason: "friend_played" });
    fireEvent.click(dialog.getByRole("button", { name: "Hide from stats" })); expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { first.resolve({ ok: true, status: 200, json: async () => ({ gameId: "first", excluded: true }) }); });
    await waitFor(() => expect(done).toHaveBeenCalledWith([{ gameId: "first", excluded: true }, { gameId: "second", excluded: true, reason: "friend_played" }]));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("keeps only unfinished games after a partial deletion and requires a fresh phrase", async () => {
    fetcher.mockImplementationOnce(async () => ({ ok: true, status: 200, json: async () => ({ gameId: "first", deleted: true }) }));
    fetcher.mockRejectedValueOnce(new Error("Cloud cleanup needs retry"));
    const done = vi.fn(); render(<GameControlActions targets={[...one, { gameId: "second" }]} scopeKey="list" onComplete={done} />); startDelete(2);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("1 completed."));
    expect(within(screen.getByRole("dialog")).queryByText("first")).toBeNull();
    expect(screen.getByRole("textbox").getAttribute("aria-label")).toContain("DELETE GAME"); expect(confirm().disabled).toBe(true);
    expect(done).toHaveBeenCalledWith([{ gameId: "first", deleted: true }]);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "DELETE GAME" } }); fireEvent.click(confirm());
    await waitFor(() => expect(done).toHaveBeenLastCalledWith([{ gameId: "second", deleted: true }]));
  });
  it.each(["owner", "loading", "signout", "scope"])("drops late tokens across %s changes", async boundary => {
    const token = deferred<string | null>(); auth.getToken.mockReturnValueOnce(token.promise);
    const done = vi.fn(); const view = render(<GameControlActions targets={one} scopeKey="list" onComplete={done} />); startDelete();
    if (boundary === "owner") auth.userId = "owner-b";
    if (boundary === "loading") auth.isLoaded = false;
    if (boundary === "signout") Object.assign(auth, { isSignedIn: false, userId: null });
    view.rerender(<GameControlActions targets={one} scopeKey={boundary === "scope" ? "new-query" : "list"} onComplete={done} />);
    await act(async () => { token.resolve("old-token"); await token.promise; });
    expect(fetcher).not.toHaveBeenCalled(); expect(done).not.toHaveBeenCalled(); expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("ignores an old-owner response body that finishes after cancellation", async () => {
    const body = deferred<unknown>(); fetcher.mockResolvedValueOnce({ ok: true, status: 200, json: () => body.promise });
    const done = vi.fn(); const view = render(<GameControlActions targets={one} scopeKey="game" onComplete={done} />); startDelete();
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1)); auth.userId = "owner-b";
    view.rerender(<GameControlActions targets={one} scopeKey="game" onComplete={done} />);
    await act(async () => { body.resolve({ gameId: "first", deleted: true }); await body.promise; });
    expect(done).not.toHaveBeenCalled(); expect(screen.queryByRole("status")).toBeNull();
  });
  it.each(["token", "body"])("settles a stalled %s after the deadline and enables retry", async boundary => {
    vi.useFakeTimers(); const pending = deferred<never>();
    try {
      if (boundary === "token") auth.getToken.mockReturnValueOnce(pending.promise);
      else fetcher.mockResolvedValueOnce({ ok: true, status: 200, json: () => pending.promise });
      render(<GameControlActions targets={one} scopeKey="game" />); startDelete();
      await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
      expect(screen.getByRole("alert").textContent).toContain("took too long"); expect(confirm().disabled).toBe(true);
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "DELETE GAME" } }); expect(confirm().disabled).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it("unhides with PATCH, while pending deletion exposes only typed Retry deletion", async () => {
    const done = vi.fn(); const view = render(<GameControlActions targets={[{ ...one[0], excluded: true }]} scopeKey="hidden" onComplete={done} />);
    fireEvent.click(screen.getByRole("button", { name: "Unhide" })); await waitFor(() => expect(done).toHaveBeenCalled());
    expect(fetcher.mock.calls[0][1].method).toBe("PATCH"); expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ excluded: false });
    view.rerender(<GameControlActions targets={[{ ...one[0], excluded: true, pendingDeletion: true }]} scopeKey="pending" />);
    expect(screen.queryByRole("button", { name: "Unhide" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry deletion…" })); expect(confirm().disabled).toBe(true);
  });
});
