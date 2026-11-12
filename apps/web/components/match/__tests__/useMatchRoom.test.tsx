import { act, renderHook, waitFor } from "@testing-library/react";
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

function game(rev: number): Room {
  return {
    config: { format: 3, preset: "standard", maps: ["Alpha", "Bravo", "Charlie"], practice: false },
    rev, expiresAt: 30_000, serverTime: rev, phase: "play",
    names: { a: "", b: "" }, ready: { a: true, b: true }, score: { a: rev - 1, b: 0 },
    first: "a", turn: null, deadline: null, moves: [], order: [0, 1, 2], winners: rev === 1 ? [] : ["a"],
  };
}

afterEach(() => vi.resetAllMocks());

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
