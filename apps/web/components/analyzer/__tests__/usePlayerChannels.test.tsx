import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import { channelIdentity, usePlayerChannels } from "../usePlayerChannels";

vi.mock("@/lib/clientApi", () => ({ API_BASE: "https://api.example.test" }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const wrapper = ({ children }: { children: ReactNode }) => <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>;

describe("shared player channel lookup", () => {
  it("does not borrow channels from a valid row for a contradictory toon/Pulse pair", async () => {
    const valid = { pulseCharacterId: "1", toonHandle: "1-S2-1-42" };
    const contradictory = { pulseCharacterId: "1", toonHandle: "1-S2-1-99" };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ players: [
      { ...contradictory, channels: {} },
      { ...valid, channels: { youtube: "https://www.youtube.com/@Harstem" } },
    ] }) })));
    const { result } = renderHook(() => usePlayerChannels([valid, contradictory]), { wrapper });
    await waitFor(() => expect(result.current(valid)?.youtube).toBeTruthy());
    expect(result.current(contradictory)).toBeUndefined();
  });
  it("matches stable Pulse/toon identities and never turns a display name into an identity", () => {
    expect(channelIdentity({ pulseId: "Harstem" })).toEqual({});
    expect(channelIdentity({ pulseId: "1-s2-1-42" })).toEqual({ toonHandle: "1-S2-1-42" });
    expect(channelIdentity({ pulseId: "12345" })).toEqual({ pulseCharacterId: "12345" });
  });
  it("deduplicates requests, batches large lists, and leaves unknown players without links", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const { players } = JSON.parse(String(init.body)) as { players: { pulseCharacterId: string }[] };
      return { ok: true, json: async () => ({ players: players.map((player) => ({ ...player, channels: player.pulseCharacterId === "1" ? { youtube: "https://www.youtube.com/@Harstem" } : {} })) }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const players = Array.from({ length: 405 }, (_, index) => ({ pulseCharacterId: String(index + 1) }));
    const { result } = renderHook(() => usePlayerChannels([...players, players[0]]), { wrapper });
    await waitFor(() => expect(result.current(players[0])?.youtube).toBe("https://www.youtube.com/@Harstem"));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchMock.mock.calls) expect(JSON.parse(String(init.body)).players.length).toBeLessThanOrEqual(200);
    expect(result.current({ pulseCharacterId: "2" })).toBeUndefined();
  });
});
