import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useEngagementState } from "../useEngagementState";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("marks a clip summary ready only after that token's full snapshot arrives", async () => {
  const pending: Array<(value: unknown) => void> = [];
  vi.stubGlobal("fetch", vi.fn(() => new Promise(resolve => pending.push(resolve))));
  const view = renderHook(({ token }) => useEngagementState(token, null), { initialProps: { token: "first" } });
  expect(view.result.current.loaded).toBe(false);
  await act(async () => { pending[0]({ ok: true, json: async () => ({ clipMoments: [] }) }); });
  expect(view.result.current.loaded).toBe(true);
  view.rerender({ token: "second" });
  expect(view.result.current.loaded).toBe(false);
  await act(async () => { pending[1]({ ok: false }); });
  expect(view.result.current.loaded).toBe(false);
});
