import { describe, expect, it } from "vitest";
import { IDLE_MS, PlayTracker, newSessionId, type PlayReport } from "../playTracker";

const session = "visit-0001";

function setup(progress = { chapter: 2, saved: true }) {
  const clock = { now: 0 };
  const sent: Array<[PlayReport, boolean]> = [];
  const tracker = new PlayTracker((report, keepalive) => { sent.push([report, keepalive]); }, () => progress, () => clock.now, session);
  return { clock, sent, tracker };
}

describe("Humdingers play time", () => {
  it("reports the load, then every five minutes of active play", () => {
    const { clock, sent, tracker } = setup();
    tracker.loaded();
    expect(sent).toEqual([[{ session, type: "load", chapter: 2, saved: true }, false]]);
    for (let second = 1; second <= 300; second += 1) {
      clock.now = second * 1_000;
      if (second % 60 === 0) tracker.input();
      tracker.tick(true);
    }
    expect(sent[1]).toEqual([{ session, type: "active", seconds: 300, longPlay: true, chapter: 2, saved: true }, false]);
    for (let second = 301; second <= 400; second += 1) {
      clock.now = second * 1_000;
      tracker.tick(true);
    }
    tracker.report(false);
    expect(sent[2]).toEqual([{ session, type: "active", seconds: 100, longPlay: false, chapter: 2, saved: true }, false]);
  });

  it("stops the clock while hidden or idle and sends the rest with keepalive on exit", () => {
    const { clock, sent, tracker } = setup({ chapter: 0, saved: false });
    tracker.input();
    clock.now = 1_000;
    tracker.tick(false);
    clock.now = 2_000;
    tracker.tick(true);
    clock.now = IDLE_MS + 1;
    tracker.tick(true);
    tracker.report(true);
    expect(sent).toEqual([[{ session, type: "active", seconds: 1, longPlay: false, chapter: 0, saved: false }, true]]);
    tracker.report(true);
    expect(sent).toHaveLength(1);
  });

  it("counts gamepad, key and touch input as activity", () => {
    const { clock, sent, tracker } = setup();
    clock.now = IDLE_MS * 3;
    tracker.tick(true);
    tracker.report(false);
    expect(sent).toHaveLength(0);
    tracker.input();
    tracker.tick(true);
    tracker.report(false);
    expect(sent).toEqual([[{ session, type: "active", seconds: 1, longPlay: false, chapter: 2, saved: true }, false]]);
  });

  it("gives each visit its own session id that the API accepts", () => {
    const ids = new Set(Array.from({ length: 20 }, () => new PlayTracker(() => undefined, () => ({ chapter: 0, saved: false })).session));
    expect(ids.size).toBe(20);
    for (const id of [...ids, newSessionId()]) expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });
});
