import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";
import { DockPresenceStrip } from "../DockPresenceStrip";
const fetchSpy = vi.fn();
function Fixture({ token }: { token: string }) { return <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}><DockPresenceStrip token={token} /></SWRConfig>; }
beforeEach(() => { fetchSpy.mockReset(); vi.stubGlobal("fetch", fetchSpy); vi.stubGlobal("IntersectionObserver", undefined); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it("reads the counts-only bearer route without Clerk credentials or private details", async () => {
  fetchSpy.mockResolvedValue(new Response(JSON.stringify({ surfaces: { "all-in-one": 1, widget: 2, scene: 0, dock: 1, unknown: 1 }, totalSources: 5, sampledAt: new Date().toISOString() }), { status: 200 }));
  render(<Fixture token="local-token" />); expect(await screen.findByText("Widgets 2")).toBeTruthy();
  expect(screen.getByText("Unknown 1")).toBeTruthy(); expect(document.body.textContent).not.toContain("local-token");
  expect(fetchSpy.mock.calls[0][0]).toContain("/v1/multichat/local-token/presence"); expect(fetchSpy.mock.calls[0][1].headers).toBeUndefined();
});
it("withholds a previous token's counts while a new token is still loading", async () => {
  fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ surfaces: { widget: 7 }, totalSources: 7, sampledAt: new Date().toISOString() }), { status: 200 }));
  const view = render(<Fixture token="token-a" />); await screen.findByText("Widgets 7");
  fetchSpy.mockImplementationOnce(() => new Promise(() => {})); view.rerender(<Fixture token="token-b" />);
  expect(screen.queryByText("Widgets 7")).toBeNull();
});
it("bounds a stalled response body and reports unavailable rather than zero", async () => {
  vi.useFakeTimers(); fetchSpy.mockResolvedValue({ ok: true, json: () => new Promise(() => {}) });
  render(<Fixture token="held-token" />); await act(async () => {});
  await act(async () => vi.advanceTimersByTimeAsync(8001)); expect(screen.getByText("Source counts unavailable")).toBeTruthy();
  expect(screen.queryByText("Widgets 0")).toBeNull();
});
