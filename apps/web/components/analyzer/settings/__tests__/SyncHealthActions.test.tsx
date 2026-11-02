import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";
import { SyncHealthActionButton, SyncHealthActionsProvider } from "../SyncHealthActions";

const h = vi.hoisted(() => ({
  auth: { userId: "owner-a" as string | null, isLoaded: true, isSignedIn: true, getToken: vi.fn<() => Promise<string | null>>() },
  mutate: vi.fn(),
}));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => h.auth }));
vi.mock("swr", async () => ({ ...await vi.importActual<typeof import("swr")>("swr"), useSWRConfig: () => ({ mutate: h.mutate }) }));
const DEVICE = "a".repeat(24);
const fetcher = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }
function Fixture() {
  return <SWRConfig value={{ provider: () => new Map() }}><SyncHealthActionsProvider>
    <SyncHealthActionButton action={{ kind: "identity", toonHandle: "1-S2-1-42" }} contextLabel="Synthetic player" />
    <SyncHealthActionButton action={{ kind: "retry", deviceId: DEVICE, reason: "player_unresolved" }} contextLabel="unrecognized players on PC" />
  </SyncHealthActionsProvider></SWRConfig>;
}
const add = () => screen.getByRole("button", { name: "Add as my account: Synthetic player" });
const retry = () => screen.getByRole("button", { name: "Retry with latest agent: unrecognized players on PC" });
beforeEach(() => {
  h.auth.userId = "owner-a"; h.auth.isLoaded = true; h.auth.isSignedIn = true;
  h.auth.getToken.mockReset().mockResolvedValue("owner-a-token");
  h.mutate.mockReset().mockResolvedValue(undefined);
  fetcher.mockReset().mockImplementation(async () => json({ code: "added", count: 2 }));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("private Sync health action requests", () => {
  it("stays passive on StrictMode mount; Add posts one owner-scoped handle and refreshes only that owner's profile/health", async () => {
    render(<StrictMode><Fixture /></StrictMode>);
    expect(fetcher).not.toHaveBeenCalled(); expect(h.auth.getToken).not.toHaveBeenCalled();
    fireEvent.click(add());
    expect(await screen.findByRole("status")).toHaveProperty("textContent", expect.stringContaining("Account added."));
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).toMatch(/\/v1\/me\/sync-health\/identity$/);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "POST", cache: "no-store", body: JSON.stringify({ toonHandle: "1-S2-1-42" }), headers: { authorization: "Bearer owner-a-token" } });
    expect(fetcher.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect((screen.getByRole("button", { name: "Added: Synthetic player" }) as HTMLButtonElement).disabled).toBe(true);
    const predicate = h.mutate.mock.calls[0][0] as (key: unknown) => boolean;
    for (const path of ["/v1/me/profile", "/v1/me/sync-health"]) {
      expect(predicate(["authenticated-api", "owner-a", path])).toBe(true);
      expect(predicate(["authenticated-api", "owner-b", path])).toBe(false);
    }
    expect(predicate(["authenticated-api", "owner-a", "/v1/me"])).toBe(false);
    expect(predicate("/v1/me/profile")).toBe(false);
  });

  it("deduplicates a held Add and disables Retry until the current action settles", async () => {
    const held = deferred<Response>(); fetcher.mockReturnValue(held.promise); render(<Fixture />);
    fireEvent.click(add()); fireEvent.click(add()); fireEvent.click(retry());
    expect((add() as HTMLButtonElement).disabled).toBe(true); expect((retry() as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    await act(async () => held.resolve(json({ code: "already_present", count: 2 })));
    expect(screen.getByRole("status").textContent).toContain("Already in your account.");
    expect((retry() as HTMLButtonElement).disabled).toBe(false);
  });

  it("Retry sends only the chosen device/reason, reports queued work and keeps the date window", async () => {
    fetcher.mockResolvedValue(json({ code: "accepted", count: 3, requestId: "opaque", deviceId: DEVICE }));
    render(<Fixture />); fireEvent.click(retry());
    expect(await screen.findByRole("status")).toHaveProperty("textContent", expect.stringContaining("3 replays queued for retry. This keeps your sync date range."));
    expect(fetcher.mock.calls[0][0]).toMatch(/\/v1\/me\/sync-health\/retry$/);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ deviceId: DEVICE, reason: "player_unresolved" });
    expect(fetcher.mock.calls[0][1].body).not.toMatch(/Synthetic|toonHandle|paths|full/);
    expect(h.mutate).toHaveBeenCalledOnce();
    expect(screen.getByRole("status").textContent).not.toMatch(/complete|finished|opaque/);
  });

  it.each([
    ["sync_agent_offline", 409, "Open the desktop app", "Open Devices", "/devices"],
    ["sync_agent_unsupported", 409, "Update and restart", "Update agent", "/download"],
    ["sync_retry_pending", 409, "A retry is already running", null, null],
    ["sync_owner_changed", 409, "account or PC connection changed", null, null],
    ["sync_retry_expired", 504, "Couldn't confirm the retry", null, null],
    ["sync_retry_unknown", 504, "Couldn't confirm the retry", null, null],
    ["rate_limited", 429, "Wait a minute", null, null],
  ])("%s has visible recovery without automatic retries or raw error text", async (code, status, text, link, href) => {
    fetcher.mockResolvedValue(json({ error: { code, message: "PRIVATE name 1-S2-1-42 C:/private" } }, status as number));
    render(<Fixture />); fireEvent.click(retry());
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining(text as string));
    expect(screen.getByRole("alert").textContent).not.toMatch(/PRIVATE|1-S2-1-42|C:\/private/);
    if (link) expect(screen.getByRole("link", { name: link as string }).getAttribute("href")).toBe(href);
    expect(fetcher).toHaveBeenCalledOnce(); expect(h.mutate).not.toHaveBeenCalled();
    expect((retry() as HTMLButtonElement).disabled).toBe(false);
  });

  it("capacity has profile recovery; Add remains available after a failure", async () => {
    fetcher.mockResolvedValueOnce(json({ error: { code: "sync_identity_capacity" } }, 409)).mockResolvedValueOnce(json({ code: "already_present", count: 20 }));
    render(<Fixture />); fireEvent.click(add());
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("20 accounts"));
    expect(screen.getByRole("link", { name: "Manage accounts in profile" }).getAttribute("href")).toBe("/settings?tab=profile");
    fireEvent.click(add());
    expect(await screen.findByRole("status")).toHaveProperty("textContent", expect.stringContaining("Already in your account."));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each(["busy", "expired", "owner_changed", "unsupported", "invalid_request", "local_error"])("agent advisory %s stays an error and never refreshes as completed work", async code => {
    fetcher.mockResolvedValue(json({ code, count: 0 })); render(<Fixture />); fireEvent.click(retry());
    expect(await screen.findByRole("alert")).toBeTruthy(); expect(h.mutate).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull(); expect(fetcher).toHaveBeenCalledOnce();
  });

  it("no_matches refreshes counts without claiming retries occurred", async () => {
    fetcher.mockResolvedValue(json({ code: "no_matches", count: 0 })); render(<Fixture />); fireEvent.click(retry());
    expect(await screen.findByRole("status")).toHaveProperty("textContent", expect.stringContaining("No matching local replays"));
    expect(h.mutate).toHaveBeenCalledOnce();
  });

  it("a held JWT cannot send after account changes; ABA does not revive it", async () => {
    const held = deferred<string | null>(); h.auth.getToken.mockReturnValue(held.promise);
    const view = render(<Fixture />); fireEvent.click(add());
    h.auth.userId = "owner-b"; view.rerender(<Fixture />);
    h.auth.userId = "owner-a"; view.rerender(<Fixture />);
    await act(async () => held.resolve("old-owner-a-token"));
    expect(fetcher).not.toHaveBeenCalled(); expect(screen.queryByRole("status")).toBeNull(); expect(screen.queryByRole("alert")).toBeNull();
    expect((add() as HTMLButtonElement).disabled).toBe(false); expect(h.mutate).not.toHaveBeenCalled();
  });

  it.each(["owner", "unmount"])("a held response body cannot refresh caches or show feedback after %s retirement", async retirement => {
    const held = deferred<unknown>(); const body = vi.fn(() => held.promise);
    fetcher.mockResolvedValue({ ok: true, status: 200, json: body });
    const view = render(<Fixture />); fireEvent.click(retry()); await waitFor(() => expect(body).toHaveBeenCalledOnce());
    const signal = fetcher.mock.calls[0][1].signal as AbortSignal;
    if (retirement === "owner") { h.auth.userId = "owner-b"; view.rerender(<Fixture />); } else view.unmount();
    await act(async () => held.resolve({ code: "accepted", count: 3 }));
    expect(signal.aborted).toBe(true); expect(h.mutate).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull(); expect(screen.queryByRole("alert")).toBeNull();
  });

  it("deadline recovers a stuck authentication request without sending it later", async () => {
    vi.useFakeTimers(); const held = deferred<string | null>(); h.auth.getToken.mockReturnValue(held.promise);
    render(<Fixture />); fireEvent.click(retry());
    await act(async () => vi.advanceTimersByTimeAsync(20_001));
    expect(screen.getByRole("alert").textContent).toContain("Couldn't confirm the retry");
    expect((retry() as HTMLButtonElement).disabled).toBe(false);
    await act(async () => held.resolve("stale-token")); expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([false, true])("auth loaded=%s without a signed-in owner cannot initiate actions", loaded => {
    h.auth.userId = null; h.auth.isSignedIn = false; h.auth.isLoaded = loaded;
    render(<Fixture />); expect((add() as HTMLButtonElement).disabled).toBe(true); expect((retry() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(add()); fireEvent.click(retry()); expect(fetcher).not.toHaveBeenCalled(); expect(h.auth.getToken).not.toHaveBeenCalled();
  });
});
