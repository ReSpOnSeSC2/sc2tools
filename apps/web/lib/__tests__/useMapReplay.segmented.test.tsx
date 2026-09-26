import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeSegmentFixture } from "./segmentedPlayback.fixture";
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: "admin", isLoaded: true, isSignedIn: true, getToken: async () => "test-token" }) }));
import { useMapReplay } from "../useMapReplay";

const wrapper = ({ children }: PropsWithChildren) => <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>{children}</SWRConfig>;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("manifest-first authenticated replay loading", () => {
  it("loads a lightweight index without downloading legacy playback or any segments", async () => {
    const { raw } = makeSegmentFixture();
    const fetcher = vi.fn(async (url: string) => Response.json(url.endsWith("/manifest") ? raw : { rebuild: null }));
    vi.stubGlobal("fetch", fetcher);
    const hook = renderHook(() => useMapReplay("g1"), { wrapper });
    await waitFor(() => expect(hook.result.current.manifest?.artifactId).toBe(raw.artifactId));
    expect(hook.result.current.playback).toBeNull();
    expect(fetcher.mock.calls.map(([url]) => url.replace(/^https?:\/\/[^/]+/, ""))).toEqual([
      "/v1/games/g1/map-playback/manifest", "/v1/games/g1/map-playback/status",
    ]);
  });
  it("falls back to the legacy endpoint once on a missing artifact", async () => {
    const { playback } = makeSegmentFixture();
    const fetcher = vi.fn(async (url: string) => url.endsWith("/manifest")
      ? Response.json({ error: { code: "playback_artifact_not_found", message: "No artifact" } }, { status: 404 })
      : Response.json(url.endsWith("/status") ? { rebuild: null } : playback));
    vi.stubGlobal("fetch", fetcher);
    const hook = renderHook(() => useMapReplay("g1"), { wrapper });
    await waitFor(() => expect(hook.result.current.playback?.v).toBe(7));
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/map-playback"))).toHaveLength(1);
    expect(hook.result.current.error).toBeUndefined();
  });
  it("does not hide an invalid artifact index behind a legacy response", async () => {
    const fetcher = vi.fn(async (url: string) => Response.json(url.endsWith("/manifest") ? { ok: true, manifest: {} } : { rebuild: null }));
    vi.stubGlobal("fetch", fetcher);
    const hook = renderHook(() => useMapReplay("g1"), { wrapper });
    await waitFor(() => expect(hook.result.current.error?.code).toBe("invalid_playback_manifest"));
    expect(fetcher.mock.calls.some(([url]) => url.endsWith("/map-playback"))).toBe(false);
  });
});
