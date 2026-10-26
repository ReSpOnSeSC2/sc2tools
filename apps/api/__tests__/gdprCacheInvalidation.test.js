// @ts-nocheck
"use strict";
const { GdprService } = require("../src/services/gdpr");
test("game mutations retire both cache scopes, while publication-only changes leave private game caches alone", async () => {
  const onCommunityChanged = jest.fn(), onGamesChanged = jest.fn();
  const gdpr = new GdprService({}, { onCommunityChanged, onGamesChanged });
  await gdpr.communityMutation("owner", async () => 1, count => count > 0);
  expect(onCommunityChanged).toHaveBeenCalledTimes(1); expect(onGamesChanged).not.toHaveBeenCalled();
  await gdpr.communityMutation("owner", async () => 1, count => count > 0, true);
  expect(onCommunityChanged).toHaveBeenCalledTimes(2); expect(onGamesChanged).toHaveBeenCalledWith("owner");
  await gdpr.communityMutation("owner", async () => 0, count => count > 0, true);
  expect(onGamesChanged).toHaveBeenCalledTimes(1);
});
test("unknown game outcomes invalidate private consumers without changing the mutation rejection", async () => {
  const onGamesChanged = jest.fn(), gdpr = new GdprService({}, { onGamesChanged });
  const unknown = new Error("unknown commit");
  await expect(gdpr.communityMutation("owner", async () => { throw unknown; }, () => false, true)).rejects.toBe(unknown);
  expect(onGamesChanged).toHaveBeenCalledWith("owner");
});
test("an advisory invalidator cannot change a committed or unknown mutation outcome", async () => {
  const fail = () => { throw new Error("advisory unavailable"); };
  const gdpr = new GdprService({}, { onGamesChanged: fail, onCommunityChanged: fail });
  await expect(gdpr.communityMutation("owner", async () => 3, () => true, true)).resolves.toBe(3);
});
