import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGamesRefresh, gamesChanged } from "./gamesRefresh";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100000); });
afterEach(() => vi.useRealTimers());

describe("shared chart refresh clock", () => {
  it("trails by two seconds, aggregates inserts and preserves mixed reasons", () => {
    const deliver = vi.fn();
    const clock = createGamesRefresh(deliver, vi.fn());
    clock.receive(gamesChanged({ count: 5, inserted: 2, reason: "ingest" }));
    vi.advanceTimersByTime(1500);
    clock.receive(gamesChanged({ count: 4, inserted: 0, reason: "reclassify" }));
    vi.advanceTimersByTime(1999);
    expect(deliver).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(deliver).toHaveBeenCalledTimes(1); expect(deliver).toHaveBeenCalledWith({ count: 9, inserted: 2, bulk: false, reason: "mixed" });
    clock.dispose();
  });

  it.each([true, false])("caps bulk or a four-event burst at one refresh per 30 seconds (bulk=%s)", (explicitBulk) => {
    const deliver = vi.fn(); const mode = vi.fn();
    const clock = createGamesRefresh(deliver, mode);
    for (let i = 0; i < 4; i += 1) {
      clock.receive(gamesChanged({ count: 25, inserted: 20, bulk: explicitBulk, reason: "ingest" }));
      vi.advanceTimersByTime(1000);
    }
    expect(mode).toHaveBeenCalledWith(true);
    vi.advanceTimersByTime(25999);
    expect(deliver).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(deliver).toHaveBeenCalledTimes(1); expect(deliver).toHaveBeenCalledWith({ count: 100, inserted: 80, bulk: true, reason: "ingest" });
    expect(mode).toHaveBeenLastCalledWith(false);
    clock.receive(gamesChanged({ inserted: 1 }));
    vi.advanceTimersByTime(2000);
    expect(deliver).toHaveBeenCalledTimes(2);
    clock.dispose();
  });

  it("does not let a continuous backfill postpone the 30-second flush", () => {
    const deliver = vi.fn(); const clock = createGamesRefresh(deliver, vi.fn());
    for (let i = 0; i < 31; i += 1) {
      clock.receive(gamesChanged({ count: 1, inserted: 1, bulk: true }));
      vi.advanceTimersByTime(1000);
    }
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0].inserted).toBe(30);
    clock.dispose(); vi.advanceTimersByTime(60000);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("never infers inserted from count in a legacy or malformed event", () => {
    expect(gamesChanged({ count: 12 })).toEqual({ count: 12, inserted: 0, bulk: false, reason: "unknown" });
    expect(gamesChanged({ count: -1, inserted: Infinity, bulk: "true" })).toEqual({ count: 0, inserted: 0, bulk: false, reason: "unknown" });
  });
});
