import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSessionRequest } from "../useSessionRequest";

const state = vi.hoisted(() => ({ owner: "owner-a", data: undefined as object | undefined, error: undefined as object | undefined, validating: false, mutate: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: state.owner, isLoaded: true, isSignedIn: true }) }));
vi.mock("@/lib/clientApi", () => ({ useApi: () => ({ data: state.data, error: state.error, isPreviousData: false, isValidating: state.validating, mutate: state.mutate }) }));
beforeEach(() => { state.owner = "owner-a"; state.data = undefined; state.error = undefined; state.validating = false; state.mutate.mockReset(); });
afterEach(cleanup);

it("admits a fresh same-value response rather than a warm initial object", () => {
  state.data = { games: 3 };
  const warm = state.data;
  const { result, rerender } = renderHook(() => useSessionRequest<object>("/v1/sessions?tz=UTC"));
  expect(result.current.data).toBeUndefined();
  rerender(); expect(result.current.data).toBeUndefined();
  state.data = { games: 3 }; rerender();
  expect(result.current.data).toBe(state.data); expect(result.current.data).not.toBe(warm);
});

it("hides warm success on stale 409 and all request failures", () => {
  const { result, rerender } = renderHook(() => useSessionRequest<object>("/v1/sessions"));
  state.data = { session: "old" }; rerender(); expect(result.current.data).toBe(state.data);
  state.error = { status: 409, code: "session_view_changed" }; rerender();
  expect(result.current.data).toBeUndefined(); expect(result.current.error).toBe(state.error);
  state.error = { status: 503 }; rerender(); expect(result.current.data).toBeUndefined();
});

it("retires owner A callbacks and refuses warm A→B→A re-entry", () => {
  const warmA = { owner: "owner-a" };
  const { result, rerender } = renderHook(() => useSessionRequest<object>("/v1/sessions"));
  state.data = warmA; rerender(); const oldRetry = result.current.mutate;
  state.owner = "owner-b"; state.data = { owner: "owner-b" }; rerender();
  expect(result.current.data).toBeUndefined(); oldRetry(); expect(state.mutate).not.toHaveBeenCalled();
  state.data = { owner: "owner-b" }; rerender(); expect(result.current.data).toBe(state.data);
  state.owner = "owner-a"; state.data = warmA; rerender(); expect(result.current.data).toBeUndefined();
  state.data = { owner: "owner-a" }; rerender(); expect(result.current.data).toBe(state.data);
});

it("retires cursor controls and keeps background revalidation unavailable until it settles", () => {
  const { result, rerender } = renderHook(({ path }) => useSessionRequest<object>(path), { initialProps: { path: "/v1/sessions?before=first" } });
  state.data = { page: 1 }; rerender({ path: "/v1/sessions?before=first" }); const firstRetry = result.current.mutate;
  rerender({ path: "/v1/sessions?before=next" }); firstRetry();
  expect(state.mutate).not.toHaveBeenCalled(); expect(result.current.data).toBeUndefined();
  state.data = { page: 2 }; state.validating = true; rerender({ path: "/v1/sessions?before=next" });
  expect(result.current.data).toBeUndefined(); state.validating = false; rerender({ path: "/v1/sessions?before=next" }); expect(result.current.data).toBe(state.data);
});
