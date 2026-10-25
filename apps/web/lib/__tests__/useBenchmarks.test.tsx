import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => vi.fn<(path: string | null, config: unknown) => object>(() => ({})));
vi.mock("../clientApi", () => ({ useApi: api }));
import { useBenchmarks } from "../useBenchmarks";
afterEach(() => { cleanup(); api.mockClear(); });
it("uses the existing cached league endpoint with 24-hour dedupe and no retry on a missing band", () => {
  renderHook(() => useBenchmarks(4, "PvZ"));
  expect(api).toHaveBeenCalledWith("/v1/benchmarks?leagueId=4&matchup=PvZ", expect.objectContaining({ dedupingInterval: 86_400_000, shouldRetryOnError: false, revalidateOnFocus: false }));
});
it("does not request an unresolved matchup or league", () => {
  renderHook(() => useBenchmarks(null, "PvZ")); expect(api.mock.calls[0][0]).toBeNull();
});
