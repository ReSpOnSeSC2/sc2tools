import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatusChecks } from "./StatusChecks";
import { STATUS_CHECK_TIMEOUT_MS } from "./reachability";

const fetcher = vi.fn();
const ok = () => new Response('{"status":"ok"}');
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_API_BASE", "https://api.sc2tools.test");
  fetcher.mockReset().mockImplementation(async () => ok());
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("public status checks", () => {
  it("checks each fixed endpoint once on initial StrictMode mount and refreshes only on intent", async () => {
    render(<StrictMode><StatusChecks /></StrictMode>);
    await waitFor(() => expect(screen.getAllByText("Reachable")).toHaveLength(2));
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/api/ping", "https://api.sc2tools.test/v1/ping"]);
    expect(screen.getByRole("status").textContent).toBe("Website: Reachable. API: Reachable");
    const refresh = screen.getByRole("button", { name: "Refresh checks" });
    refresh.focus(); expect(document.activeElement).toBe(refresh);
    fireEvent.click(refresh);
    await waitFor(() => expect(screen.getAllByText("Reachable")).toHaveLength(2));
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(screen.getByRole("region", { name: "Website" }).querySelector("time")?.dateTime).toBeTruthy();
    expect(screen.getByRole("region", { name: "API" }).querySelector("time")?.dateTime).toBeTruthy();
  });
  it("keeps website success and API failure independent without claiming every feature is healthy", async () => {
    fetcher.mockImplementation(async url => url === "/api/ping" ? ok() : new Response("temporarily unavailable", { status: 503 }));
    render(<StatusChecks />);
    expect(await within(screen.getByRole("region", { name: "Website" })).findByText("Reachable")).toBeTruthy();
    expect(await within(screen.getByRole("region", { name: "API" })).findByText("Unavailable")).toBeTruthy();
    expect(screen.getByText(/replay processing and other features can have separate issues/)).toBeTruthy();
  });
  it("does not poll or refresh on focus, online or elapsed time", async () => {
    vi.useFakeTimers(); render(<StatusChecks />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getAllByText("Reachable")).toHaveLength(2);
    await act(async () => { window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("online")); await vi.advanceTimersByTimeAsync(120_000); });
    expect(fetcher).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });
  it("retires held response bodies on unmount and a remount gets its own results", async () => {
    const body = deferred<unknown>();
    fetcher.mockResolvedValue({ ok: true, json: () => body.promise });
    const view = render(<StatusChecks />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    const signals = fetcher.mock.calls.map(([, init]) => init.signal as AbortSignal);
    view.unmount(); expect(signals.every(signal => signal.aborted)).toBe(true);
    fetcher.mockImplementation(async () => new Response("down", { status: 503 }));
    render(<StatusChecks />);
    await waitFor(() => expect(screen.getAllByText("Unavailable")).toHaveLength(2));
    await act(async () => body.resolve({ status: "ok" }));
    expect(screen.queryByText("Reachable")).toBeNull();
    expect(screen.getAllByText("Unavailable")).toHaveLength(2);
  });
  it("does not replace manual refresh results when a timed-out old body finally arrives", async () => {
    vi.useFakeTimers();
    const old = deferred<unknown>(); fetcher.mockResolvedValue({ ok: true, json: () => old.promise });
    render(<StatusChecks />);
    await act(async () => { await vi.advanceTimersByTimeAsync(STATUS_CHECK_TIMEOUT_MS + 1); });
    expect(screen.getAllByText("Unknown")).toHaveLength(2);
    fetcher.mockImplementation(async () => new Response("unavailable", { status: 503 }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Refresh checks" })); });
    expect(screen.getAllByText("Unavailable")).toHaveLength(2);
    await act(async () => old.resolve({ status: "ok" }));
    expect(screen.queryByText("Reachable")).toBeNull(); expect(fetcher).toHaveBeenCalledTimes(4);
  });
});
