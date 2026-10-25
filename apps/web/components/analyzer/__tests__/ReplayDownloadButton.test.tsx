import { StrictMode, type ComponentProps, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplayDownloadButton } from "../ReplayDownloadButton";

const h = vi.hoisted(() => ({
  auth: { userId: "owner-a" as string | null, isLoaded: true, isSignedIn: true, getToken: vi.fn<() => Promise<string | null>>() },
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
}));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => h.auth }));
vi.mock("@/components/ui/Toast", () => ({ useToastOptional: () => ({ toast: h.toast }) }));

type SignedReplay = { url: string; filename: string; expiresIn: number };
const signed = (id = "current"): SignedReplay => ({ url: `https://replays.example.test/${id}?signature=synthetic`, filename: `${id}.SC2Replay`, expiresIn: 60 });
const response = (value: SignedReplay = signed()) => new Response(JSON.stringify(value));
const fetcher = vi.fn();
let clickedAnchors: HTMLAnchorElement[];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function clickDownload() { fireEvent.click(screen.getByRole("button", { name: "Download replay" })); }
function expectNoDelivery() {
  expect(clickedAnchors).toHaveLength(0);
  expect(h.toast.success).not.toHaveBeenCalled();
  expect(h.toast.error).not.toHaveBeenCalled();
}

beforeEach(() => {
  h.auth.userId = "owner-a"; h.auth.isLoaded = true; h.auth.isSignedIn = true;
  h.auth.getToken.mockReset().mockImplementation(async () => `${h.auth.userId}-token`);
  for (const toast of Object.values(h.toast)) toast.mockReset();
  fetcher.mockReset().mockImplementation(async () => response());
  vi.stubGlobal("fetch", fetcher);
  clickedAnchors = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function capture(this: HTMLAnchorElement) { clickedAnchors.push(this); });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("ReplayDownloadButton actual authenticated requests", () => {
  it("uses the supplied authorized path for delegated replay access", async () => {
    const path = "/v1/coaching/assignments/plan-1/games/game%2F42/replay-download";
    render(<ReplayDownloadButton gameId="game/42" available downloadPath={path} />);
    clickDownload();
    await waitFor(() => expect(clickedAnchors).toHaveLength(1));
    expect(fetcher.mock.calls[0][0]).toMatch(new RegExp(`${path}$`));
    expect(fetcher.mock.calls[0][1]).toMatchObject({ cache: "no-store", headers: { authorization: "Bearer owner-a-token" } });
    expect(fetcher.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("requests only on click and sanitizes the native download without opening its row", async () => {
    fetcher.mockResolvedValue(response({ ...signed(), filename: "2026-08-11 - Crimson Court - vs Rival/Name.SC2Replay" }));
    const openRow = vi.fn();
    render(<div onClick={openRow}><ReplayDownloadButton gameId="game/42" available filename="fallback.SC2Replay" sizeBytes={1536} /></div>);
    expect(fetcher).not.toHaveBeenCalled(); expect(h.auth.getToken).not.toHaveBeenCalled();
    clickDownload();
    await waitFor(() => expect(clickedAnchors).toHaveLength(1));
    expect(fetcher.mock.calls[0][0]).toMatch(/\/v1\/games\/game%2F42\/replay-download$/);
    const [anchor] = clickedAnchors;
    expect(anchor.href).toBe(signed().url);
    expect(anchor.download).toBe("2026-08-11 - Crimson Court - vs Rival-Name.SC2Replay");
    expect(anchor.rel).toBe("noopener noreferrer"); expect(anchor.referrerPolicy).toBe("no-referrer");
    expect(anchor.isConnected).toBe(false); expect(openRow).not.toHaveBeenCalled();
    expect(h.toast.success).toHaveBeenCalledOnce();
  });

  it("locks duplicate clicks while a signed URL is loading", async () => {
    const pending = deferred<Response>(); fetcher.mockReturnValue(pending.promise);
    render(<ReplayDownloadButton gameId="g1" available />); clickDownload();
    const loading = screen.getByRole("button", { name: "Downloading replay" }) as HTMLButtonElement;
    expect(loading.disabled).toBe(true); expect(loading.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(loading);
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    await act(async () => pending.resolve(response()));
    expect(screen.getByRole("button", { name: "Download replay" }).getAttribute("aria-busy")).toBeNull();
    expect(clickedAnchors).toHaveLength(1);
  });

  it("offers unavailable guidance without token lookup or a request", () => {
    render(<ReplayDownloadButton gameId="g1" available={false} mobile />);
    const button = screen.getByRole("button", { name: "Replay unavailable" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false); expect(button.getAttribute("aria-disabled")).toBe("true");
    button.focus(); expect(document.activeElement).toBe(button);
    expect(screen.getByText(/Update to the latest desktop agent, then run Re-sync/i)).toBeTruthy();
    fireEvent.click(button);
    expect(fetcher).not.toHaveBeenCalled(); expect(h.auth.getToken).not.toHaveBeenCalled();
    expect(h.toast.info).toHaveBeenCalledOnce();
  });

  it("surfaces a missing archived replay as a retryable error", async () => {
    fetcher.mockResolvedValue(new Response(JSON.stringify({ error: { code: "replay_unavailable", message: "Not found." } }), { status: 404 }));
    render(<ReplayDownloadButton gameId="g1" available />); clickDownload();
    expect(await screen.findByRole("button", { name: "Retry replay download" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Update to the latest desktop agent, then run Re-sync");
    expect(clickedAnchors).toHaveLength(0);
  });

  it.each([false, true])("withholds private replay metadata and requests when auth loaded=%s has no owner", loaded => {
    h.auth.isLoaded = loaded; h.auth.isSignedIn = false; h.auth.userId = null;
    render(<ReplayDownloadButton gameId="g1" available filename="private filename.SC2Replay" contextLabel="private rival" sizeBytes={1000} showLabel />);
    const button = screen.getByRole("button") as HTMLButtonElement;
    expect(button.disabled).toBe(true); expect(button.title).not.toContain("private");
    expect(button.getAttribute("aria-label")).not.toContain("private");
    fireEvent.click(button); expect(fetcher).not.toHaveBeenCalled(); expect(h.auth.getToken).not.toHaveBeenCalled();
  });

  it("keeps StrictMode mount passive and downloads once on explicit intent", async () => {
    render(<StrictMode><ReplayDownloadButton gameId="g1" available /></StrictMode>);
    expect(fetcher).not.toHaveBeenCalled(); expect(h.auth.getToken).not.toHaveBeenCalled();
    clickDownload(); await waitFor(() => expect(clickedAnchors).toHaveLength(1));
    expect(fetcher).toHaveBeenCalledOnce(); expect(h.auth.getToken).toHaveBeenCalledOnce();
  });

  it("does not leave a stale success notification when native delivery unmounts its owner", async () => {
    const view = render(<ReplayDownloadButton gameId="g1" available />);
    vi.mocked(HTMLAnchorElement.prototype.click).mockImplementation(function deliver(this: HTMLAnchorElement) {
      clickedAnchors.push(this);
      view.unmount();
    });
    clickDownload();
    await waitFor(() => expect(clickedAnchors).toHaveLength(1));
    expect(h.toast.success).not.toHaveBeenCalled(); expect(h.toast.error).not.toHaveBeenCalled();
  });

  it.each(["javascript:alert(1)", "http://replays.example.test/plain"])("rejects unsafe signed link %s", async url => {
    fetcher.mockResolvedValue(response({ ...signed(), url }));
    render(<ReplayDownloadButton gameId="g1" available />); clickDownload();
    expect(await screen.findByRole("button", { name: "Retry replay download" })).toBeTruthy();
    expect(clickedAnchors).toHaveLength(0);
  });
});

type ScopeBoundary = "owner" | "auth loading" | "game" | "path" | "availability" | "filename";
function crossScopeTwice(boundary: ScopeBoundary, props: ComponentProps<typeof ReplayDownloadButton>, rerender: (ui: ReactNode) => void) {
  if (boundary === "owner") h.auth.userId = "owner-b";
  if (boundary === "auth loading") h.auth.isLoaded = false;
  const other = boundary === "game" ? { gameId: "g2" } : boundary === "path" ? { downloadPath: "/v1/coaching/assignments/other/games/g1/replay-download" }
    : boundary === "availability" ? { available: false } : boundary === "filename" ? { filename: "changed.SC2Replay" } : {};
  rerender(<ReplayDownloadButton {...props} {...other} />);
  h.auth.userId = "owner-a"; h.auth.isLoaded = true;
  rerender(<ReplayDownloadButton {...props} />);
}

describe.each(["JWT", "body"] as const)("download retirement while %s is held", stage => {
  it.each(["owner", "auth loading", "game", "path", "availability", "filename"] as const)("rejects %s ABA and cannot reset a newer in-flight download", async boundary => {
    const token = deferred<string>(), body = deferred<SignedReplay>(), newer = deferred<Response>();
    if (stage === "JWT") h.auth.getToken.mockReturnValueOnce(token.promise);
    if (stage === "body") fetcher.mockResolvedValueOnce({ ok: true, status: 200, json: () => body.promise });
    fetcher.mockImplementation(() => newer.promise);
    const props = { gameId: "g1", available: true, filename: "original.SC2Replay" };
    const view = render(<ReplayDownloadButton {...props} />); clickDownload();
    await waitFor(() => expect(stage === "JWT" ? h.auth.getToken : fetcher).toHaveBeenCalledOnce());
    const oldSignal = stage === "body" ? fetcher.mock.calls[0][1].signal as AbortSignal : null;
    crossScopeTwice(boundary, props, view.rerender);
    expect(oldSignal?.aborted ?? true).toBe(true);
    clickDownload();
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(stage === "JWT" ? 1 : 2));
    await act(async () => { token.resolve("retired-token"); body.resolve(signed("retired")); });
    expect(screen.getByRole("button", { name: "Downloading replay" }).getAttribute("aria-busy")).toBe("true");
    expectNoDelivery();
    await act(async () => newer.resolve(response(signed("newer"))));
    await waitFor(() => expect(clickedAnchors).toHaveLength(1));
    expect(clickedAnchors[0].href).toBe(signed("newer").url);
    expect(fetcher).toHaveBeenCalledTimes(stage === "JWT" ? 1 : 2);
  });

  it("aborts on unmount and ignores a late adapter that does not support abort", async () => {
    const token = deferred<string>(), body = deferred<SignedReplay>();
    if (stage === "JWT") h.auth.getToken.mockReturnValueOnce(token.promise);
    fetcher.mockResolvedValue({ ok: true, status: 200, json: () => body.promise });
    const view = render(<ReplayDownloadButton gameId="g1" available />); clickDownload();
    await waitFor(() => expect(stage === "JWT" ? h.auth.getToken : fetcher).toHaveBeenCalledOnce());
    const oldSignal = stage === "body" ? fetcher.mock.calls[0][1].signal as AbortSignal : null;
    view.unmount();
    await act(async () => { token.resolve("late-token"); body.resolve(signed("retired")); });
    expect(oldSignal?.aborted ?? true).toBe(true); expectNoDelivery();
    if (stage === "JWT") expect(fetcher).not.toHaveBeenCalled();
  });

  it("times out after 20 seconds, suppresses late delivery and permits an explicit retry", async () => {
    vi.useFakeTimers();
    const token = deferred<string>(), body = deferred<SignedReplay>();
    if (stage === "JWT") h.auth.getToken.mockReturnValueOnce(token.promise);
    if (stage === "body") fetcher.mockResolvedValueOnce({ ok: true, status: 200, json: () => body.promise });
    render(<ReplayDownloadButton gameId="g1" available />); clickDownload();
    await act(async () => { await vi.advanceTimersByTimeAsync(20_001); });
    expect(screen.getByRole("button", { name: "Retry replay download" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("took too long");
    if (stage === "body") expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    await act(async () => { token.resolve("retired-token"); body.resolve(signed("retired")); });
    expect(clickedAnchors).toHaveLength(0); expect(h.toast.error).toHaveBeenCalledOnce();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry replay download" })); });
    expect(clickedAnchors).toHaveLength(1); expect(clickedAnchors[0].href).toBe(signed().url);
    expect(h.toast.success).toHaveBeenCalledOnce();
  });
});
