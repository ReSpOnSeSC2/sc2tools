import { afterEach, expect, it, vi } from "vitest";
import { readBallot, readCrowdResult, saveBallot, submitCrowdBallot } from "../crowd";
import { dailyFightLink, readFightLink } from "../fightLink";

const day = 20_000;
const pack = "a".repeat(64);

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

it("keeps one same-day receipt and original choices across retries and reloads", async () => {
  const first = await saveBallot(localStorage, day, pack, [0, 1, 2, 3, 4]);
  expect(first).toMatchObject({ day, pack, answers: [0, 1, 2, 3, 4], attempt: expect.stringMatching(/^[0-9a-f]{32}$/) });
  await expect(saveBallot(localStorage, day, pack, [4, 3, 2, 1, 0])).resolves.toEqual(first);
  expect(readBallot(localStorage, day, pack)).toEqual(first);
  expect(readBallot(localStorage, day + 1, pack)).toBeNull();
  expect(readBallot(localStorage, day, "b".repeat(64))).toBeNull();
  expect((await saveBallot(null, day, pack, [4, 3, 2, 1, 0]))?.attempt).not.toBe(first?.attempt);
});

it("keeps the first ballot when two tabs finish the set together", async () => {
  let pending = Promise.resolve<unknown>(null);
  const request = vi.fn((_key: string, save: () => unknown) => {
    const next = pending.then(save);
    pending = next;
    return next;
  });
  vi.stubGlobal("navigator", { locks: { request } });
  const [first, second] = await Promise.all([
    saveBallot(localStorage, day, pack, [0, 1, 2, 3, 4]),
    saveBallot(localStorage, day, pack, [4, 3, 2, 1, 0]),
  ]);
  expect(request).toHaveBeenCalledTimes(2);
  expect(first?.answers).toEqual([0, 1, 2, 3, 4]);
  expect(second).toEqual(first);
});

it("only accepts complete fixed-size aggregate rows that match the total above the privacy floor", () => {
  const fights = Array.from({ length: 5 }, () => [10, 5, 3, 1, 1]);
  const ready = { state: "ready", total: 20, fights };
  expect(readCrowdResult(ready)).toEqual(ready);
  expect(readCrowdResult({ ...ready, total: 19 })).toBeNull();
  expect(readCrowdResult({ ...ready, fights: fights.slice(1) })).toBeNull();
  expect(readCrowdResult({ ...ready, fights: [[10, 5, 3, 1, -1], ...fights.slice(1)] })).toBeNull();
  expect(readCrowdResult({ state: "waiting", total: 19 })).toEqual({ state: "waiting" });
});

it("posts just the ballot without credentials and treats older or closed APIs as unavailable", async () => {
  const vote = (await saveBallot(null, day, pack, [0, 1, 2, 3, 4]))!;
  const request = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ state: "waiting" })))
    .mockResolvedValueOnce(new Response(null, { status: 404 }));
  vi.stubGlobal("fetch", request);
  const signal = new AbortController().signal;
  await expect(submitCrowdBallot(vote, signal)).resolves.toEqual({ state: "waiting" });
  expect(request).toHaveBeenCalledWith(expect.stringMatching(/\/v1\/daily\/calls$/),
    { credentials: "omit", redirect: "error", method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(vote) });
  await expect(submitCrowdBallot(vote, signal)).resolves.toBeNull();
});

it("carries only an allowed UTC day and one-based slot in a fragment", () => {
  const link = dailyFightLink(day, 4);
  expect(link).toBe("/arcade#fight=20000-5");
  expect(readFightLink(link.slice(7), day)).toEqual({ day, slot: 4 });
  for (const invalid of ["#fight=20000-0", "#fight=20000-6", "#fight=20000-1&call=0", "#fight=20001-1", "#fight=020000-1"]) {
    expect(readFightLink(invalid, day)).toBeNull();
  }
});
