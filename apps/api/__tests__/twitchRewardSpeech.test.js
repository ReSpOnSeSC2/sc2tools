"use strict";

const { TwitchRewardActions } = require("../src/services/twitchRewardActions");

const owner = "fixture-owner", token = "fixture-token";
const cue = { redemptionId: "fixture-redemption", name: "Fixture viewer", input: "Try a new opening" };

/** @param {boolean|string|Promise<string>} ready @param {() => Promise<boolean>} speech */
function source(ready, speech) {
  const emitWithAck = jest.fn().mockImplementation(event =>
    event === "overlay:rewardSpeechReady" ? Promise.resolve(ready) : speech());
  return {
    data: { kind: "overlay", overlayToken: token, overlayUserId: owner, overlayPresence: { surface: "widget", widget: "multichat" } },
    timeout: jest.fn(() => ({ emitWithAck })),
    emitWithAck,
  };
}

/** @param {ReturnType<typeof source>[]} sockets */
function adapter(...sockets) {
  const deps = /** @type {ConstructorParameters<typeof TwitchRewardActions>[0]} */ (/** @type {unknown} */ ({
    io: { in: () => ({ fetchSockets: async () => sockets }) },
  }));
  return new TwitchRewardActions(deps);
}

test("skips cached enqueue-only overlays and speaks through one start-aware source", async () => {
  const cached = source(true, () => Promise.resolve(true));
  const busy = source(false, () => Promise.resolve(true));
  const current = source("start-ack-v1", () => Promise.resolve(true));
  const other = source("start-ack-v1", () => Promise.resolve(true));
  await expect(adapter(cached, busy, current, other).speak(owner, token, cue)).resolves.toBeUndefined();
  expect(cached.emitWithAck.mock.calls).toEqual([["overlay:rewardSpeechReady", cue.redemptionId]]);
  expect(busy.emitWithAck.mock.calls).toEqual([["overlay:rewardSpeechReady", cue.redemptionId]]);
  expect(current.emitWithAck.mock.calls).toEqual([
    ["overlay:rewardSpeechReady", cue.redemptionId], ["overlay:rewardSpeech", { id: cue.redemptionId, name: cue.name, text: cue.input }],
  ]);
  expect(current.timeout.mock.calls).toEqual([[800], [1500]]);
  expect(other.emitWithAck).not.toHaveBeenCalled();
});

const unsuccessfulAcks = /** @type {[string, () => Promise<boolean>, string][]} */ ([
  ["negative", () => Promise.resolve(false), "reward_audio_unavailable"],
  ["lost", () => Promise.reject(new Error("socket ACK timed out")), "reward_action_unconfirmed"],
]);

test.each(unsuccessfulAcks)("does not dispatch a second copy after a %s speech ACK", async (_outcome, result, code) => {
  const selected = source("start-ack-v1", result);
  const other = source("start-ack-v1", () => Promise.resolve(true));
  await expect(adapter(selected, other).speak(owner, token, cue)).rejects.toMatchObject({ code });
  expect(selected.emitWithAck).toHaveBeenCalledTimes(2);
  expect(other.emitWithAck).not.toHaveBeenCalled();
});

test("rechecks the redemption deadline after the asynchronous readiness probe", async () => {
  let ready = /** @type {(value: string) => void} */ (() => {});
  const selected = source(new Promise(resolve => { ready = resolve; }), () => Promise.resolve(true));
  const assertDispatch = jest.fn(() => { throw Object.assign(new Error("Expired"), { code: "reward_redemption_expired" }); });
  const result = adapter(selected).speak(owner, token, { ...cue, assertDispatch });
  await Promise.resolve();
  expect(selected.emitWithAck.mock.calls).toEqual([["overlay:rewardSpeechReady", cue.redemptionId]]);
  expect(assertDispatch).not.toHaveBeenCalled();
  ready("start-ack-v1");
  await expect(result).rejects.toMatchObject({ code: "reward_redemption_expired" });
  expect(assertDispatch).toHaveBeenCalledTimes(1);
  expect(selected.emitWithAck).toHaveBeenCalledTimes(1);
});
