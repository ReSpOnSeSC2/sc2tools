import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { useSort, usePersistentSort } from "@/components/ui/SortableTh";
import { OPPONENT_COMPARATORS } from "../opponentListSort";

it("sorts names naturally, numbers numerically and nulls last in both directions", () => {
  const { result } = renderHook(() => useSort("name", "asc", OPPONENT_COMPARATORS));
  const rows = [{ name: "Bob", pulseId: "1234567", mmr: null }, { name: "alice", pulseId: "994428", mmr: 4000 }, { name: "Émile", pulseId: "TOON:1-1-1", mmr: 5000 }, { name: "Emile", pulseId: "TOON:1-1-2", mmr: 4500 }];
  const sort = () => result.current.sortRows(rows, (row, col) => row[col as keyof typeof row]);
  expect(sort().map((row) => row.name)).toEqual(["alice", "Bob", "Émile", "Emile"]);
  act(() => result.current.setSortExplicit("pulseId", "asc")); expect(sort().map((row) => row.pulseId)).toEqual(["994428", "1234567", "TOON:1-1-1", "TOON:1-1-2"]);
  for (const dir of ["asc", "desc"] as const) { act(() => result.current.setSortExplicit("mmr", dir)); expect(sort().at(-1)?.name).toBe("Bob"); }
});
it("breaks win-rate ties by games descending then by name in either direction", () => {
  const { result } = renderHook(() => useSort("winRate", "asc", OPPONENT_COMPARATORS));
  const rows = [{ name: "Bob", games: 3, winRate: .5 }, { name: "alice", games: 10, winRate: .5 }, { name: "Claire", games: 10, winRate: .5 }];
  for (const dir of ["asc", "desc"] as const) { act(() => result.current.setSortExplicit("winRate", dir)); expect(result.current.sortRows(rows, (row) => row.winRate).map((row) => row.name)).toEqual(["alice", "Claire", "Bob"]); }
});
it("lets an explicit URL choice take precedence over a stored preference", () => {
  localStorage.setItem("test-opponent-sort", JSON.stringify({ sortBy: "games", sortDir: "asc" }));
  const { result, unmount } = renderHook(() => usePersistentSort("test-opponent-sort", "name", "desc", OPPONENT_COMPARATORS, { preferInitial: true }));
  expect(result.current.sortBy).toBe("name"); expect(result.current.sortDir).toBe("desc");
  act(() => result.current.setSortExplicit("lastPlayed", "desc")); expect(result.current.sortBy).toBe("lastPlayed"); unmount(); localStorage.removeItem("test-opponent-sort");
});
