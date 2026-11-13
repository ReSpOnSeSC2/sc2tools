import { act, renderHook } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { readMatchReplay } from "@/lib/matchRoomReplay";
import { useRoomReplay } from "../useRoomReplay";

vi.mock("@/lib/matchRoomReplay", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/matchRoomReplay")>(),
  readMatchReplay: vi.fn(),
}));

test("keeps the parsed replay available for explicit retry after a failed write", async () => {
  const replay = { mapKey: "alpha", endedAt: 10, durationSec: 100,
    digests: { Win: "a".repeat(64), Loss: "b".repeat(64) } };
  vi.mocked(readMatchReplay).mockResolvedValueOnce(replay);
  const send = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const { result } = renderHook(() => useRoomReplay({ roomId: "room", seat: "a", send }));
  const file = new File(["file"], "private.SC2Replay");
  const files: FileList = { 0: file, length: 1, item: index => index === 0 ? file : null,
    [Symbol.iterator]: () => [file][Symbol.iterator]() };
  await act(() => result.current.read(files));

  await act(() => result.current.report("Win"));
  expect(result.current.state).toEqual({ kind: "ready", replay, failed: true });
  expect(send).toHaveBeenCalledTimes(1);
  await act(() => result.current.report("Win"));
  expect(result.current.state.kind).toBe("idle");
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[0]).toEqual(send.mock.calls[1]);
  expect(readMatchReplay).toHaveBeenCalledTimes(1);
});
