import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { Room, RoomInvite } from "@/lib/matchRoom";
import { readRoom, RoomRequestError, writeRoom } from "@/lib/matchRoomClient";
import { useMatchRoom } from "../useMatchRoom";

vi.mock("@/lib/matchRoomClient", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/matchRoomClient")>(),
  readRoom: vi.fn(),
  writeRoom: vi.fn(),
}));

const host = { id: "r".repeat(32), role: "host", key: "k".repeat(32) } satisfies RoomInvite;
const watch = { id: host.id, role: "watch" } satisfies RoomInvite;

function game(rev: number): Room {
  return {
    config: { format: 3, preset: "standard", maps: ["Alpha", "Bravo", "Charlie"], practice: false },
    rev, expiresAt: 30_000, serverTime: rev, phase: "play",
    names: { a: "", b: "" }, ready: { a: true, b: true }, score: { a: rev - 1, b: 0 },
    first: "a", turn: null, deadline: null, moves: [], order: [0, 1, 2], winners: rev === 1 ? [] : ["a"],
  };
}

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.resetAllMocks(); });

test("a queued score click sends the revision of its displayed game", async () => {
  vi.mocked(readRoom).mockResolvedValueOnce(game(1)).mockResolvedValueOnce(game(2)).mockResolvedValue(null);
  vi.mocked(writeRoom).mockRejectedValueOnce(new RoomRequestError(409));
  const { result } = renderHook(() => useMatchRoom(host));
  await waitFor(() => expect(result.current.frame?.room.rev).toBe(1));
  const displayed = result.current;
  act(() => displayed.retry());
  await waitFor(() => expect(result.current.frame?.room.rev).toBe(2));

  await act(async () => {
    expect(await displayed.mutate({ type: "score", winner: "a" }, 1)).toBe(false);
  });
  expect(writeRoom).toHaveBeenCalledWith(host, 1, { type: "score", winner: "a" }, expect.any(AbortSignal));
  expect(result.current.actionError).toMatch(/room changed/i);
});

test("a generic 404 offers recovery, while a missing room stops polling", async () => {
  vi.mocked(readRoom).mockRejectedValueOnce(new RoomRequestError(404)).mockResolvedValueOnce(game(1))
    .mockRejectedValueOnce(new RoomRequestError(404, 0, "match_room_missing"));
  const { result } = renderHook(() => useMatchRoom(host));
  await waitFor(() => expect(result.current.reading).toEqual({ error: "The room could not be reached.", gone: false }));
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.frame?.room.rev).toBe(1));
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.reading.gone).toBe(true));
  act(() => result.current.retry());
  expect(readRoom).toHaveBeenCalledTimes(3);
});

async function advance(ms: number) {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}

test("OBS polls every five seconds with the last accepted revision and ignores stale snapshots", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.mocked(readRoom).mockResolvedValueOnce(game(2)).mockResolvedValueOnce(game(1)).mockResolvedValue(null);
  const { result } = renderHook(() => useMatchRoom(watch, "obs"));
  await advance(0);
  await advance(4999);
  expect(readRoom).toHaveBeenCalledTimes(1);
  await advance(1);
  expect(readRoom).toHaveBeenLastCalledWith(watch.id, 2, expect.any(AbortSignal));
  expect(result.current.frame?.room.rev).toBe(2);
  await advance(5000);
  expect(readRoom).toHaveBeenCalledTimes(3);
  expect(readRoom).toHaveBeenLastCalledWith(watch.id, 2, expect.any(AbortSignal));
  expect(writeRoom).not.toHaveBeenCalled();
});

test("OBS respects the server retry delay and refreshes when a hidden tab returns", async () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  vi.mocked(readRoom).mockRejectedValueOnce(new RoomRequestError(429, 10_000)).mockResolvedValueOnce(game(1)).mockResolvedValue(null);
  const { result } = renderHook(() => useMatchRoom(watch, "obs"));
  await advance(0);
  expect(readRoom).toHaveBeenCalledTimes(1);
  act(() => result.current.retry());
  await advance(9_999);
  expect(readRoom).toHaveBeenCalledTimes(1);
  visibility.mockReturnValue("visible");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  await advance(1);
  expect(readRoom).toHaveBeenCalledTimes(1);
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  await advance(0);
  expect(readRoom).toHaveBeenCalledTimes(2);
  expect(result.current.frame?.room.rev).toBe(1);
});

test("a hidden OBS source polls every 30 seconds until it returns to view", async () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  vi.mocked(readRoom).mockResolvedValueOnce({ ...game(1), expiresAt: 300_000 }).mockResolvedValue(null);
  renderHook(() => useMatchRoom(watch, "obs"));
  await advance(29_999);
  expect(readRoom).toHaveBeenCalledTimes(1);
  await advance(1);
  expect(readRoom).toHaveBeenCalledTimes(2);
  visibility.mockReturnValue("visible");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  await advance(0);
  expect(readRoom).toHaveBeenCalledTimes(3);
  await advance(5_000);
  expect(readRoom).toHaveBeenCalledTimes(4);
});

test("OBS retires the last score and cancels retries at the room's server-clock expiry", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.mocked(readRoom).mockResolvedValue({ ...game(2), serverTime: 100_000, expiresAt: 103_000 });
  const { result } = renderHook(() => useMatchRoom(watch, "obs"));
  await advance(0);
  expect(result.current.frame?.room.rev).toBe(2);
  await advance(2_999);
  expect(result.current.reading.gone).toBe(false);
  await advance(1);
  expect(result.current.reading.gone).toBe(true);
  expect(result.current.frame).toBeNull();
  act(() => result.current.retry());
  await advance(30_000);
  expect(readRoom).toHaveBeenCalledTimes(1);
});
