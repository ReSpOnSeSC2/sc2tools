import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { auth } = vi.hoisted(() => ({
  auth: { isLoaded: true, isSignedIn: false, userId: null as string | null, getToken: vi.fn() },
}));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => auth }));

import { SitePresence } from "./SitePresence";

describe("SitePresence", () => {
  const fetchMock = vi.fn();
  let visibility: DocumentVisibilityState;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T12:00:00.000Z"));
    visibility = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    auth.isLoaded = true;
    auth.isSignedIn = false;
    auth.userId = null;
    auth.getToken.mockReset();
    auth.getToken.mockResolvedValue("clerk.jwt.signature");
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("waits for Clerk before anonymously checking in and never sends page details", async () => {
    auth.isLoaded = false;
    const view = render(<SitePresence />);
    expect(fetchMock).not.toHaveBeenCalled();
    auth.isLoaded = true;
    await act(async () => view.rerender(<SitePresence />));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("/api/site/presence", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: "{}",
      cache: "no-store",
      signal: expect.any(AbortSignal),
    });
  });

  it("checks in every minute, stops when idle, and resumes on interaction", async () => {
    await act(async () => { render(<SitePresence />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await act(async () => { fireEvent.pointerDown(window); });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("suppresses hidden-tab heartbeats and resumes when visible", async () => {
    await act(async () => { render(<SitePresence />); });
    visibility = "hidden";
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => { await vi.advanceTimersByTimeAsync(240_000); });
    expect(fetchMock).toHaveBeenCalledOnce();
    visibility = "visible";
    await act(async () => { fireEvent(document, new Event("visibilitychange")); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("updates the same cookie identity promptly on sign-in and sign-out", async () => {
    const view = render(<SitePresence />);
    await act(async () => {});
    auth.isSignedIn = true;
    auth.userId = "user_123";
    await act(async () => view.rerender(<SitePresence />));
    expect(fetchMock.mock.calls[1][1].headers.authorization).toBe("Bearer clerk.jwt.signature");
    auth.isSignedIn = false;
    auth.userId = null;
    await act(async () => view.rerender(<SitePresence />));
    expect(fetchMock.mock.calls[2][1].headers.authorization).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not downgrade signed-in visitors if their token is temporarily unavailable", async () => {
    auth.isSignedIn = true;
    auth.userId = "user_123";
    auth.getToken.mockResolvedValue(null);
    await act(async () => { render(<SitePresence />); });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts in-flight requests and removes all heartbeat triggers on unmount", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const view = render(<SitePresence />);
    await act(async () => {});
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
      fireEvent.pointerDown(window);
      fireEvent(document, new Event("visibilitychange"));
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("serializes cookie initialization through browser locks when available", async () => {
    const lock = vi.fn(async (_name: string, _options: unknown, callback: () => Promise<void>) => callback());
    const previous = Object.getOwnPropertyDescriptor(navigator, "locks");
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request: lock } });
    try {
      await act(async () => { render(<SitePresence />); });
      expect(lock).toHaveBeenCalledWith("sc2tools-site-presence", { signal: expect.any(AbortSignal) }, expect.any(Function));
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      if (previous) Object.defineProperty(navigator, "locks", previous);
      else Reflect.deleteProperty(navigator, "locks");
    }
  });
});
