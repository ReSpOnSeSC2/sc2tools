import { describe, expect, it } from "vitest";
import { guideSignInHref } from "../guideAuthLinks";

describe("guide sign-in return links", () => {
  it.each([null, "//evil.com", "https://x", "/guides/../app", "/guides/pvz?x=1", "/guides/pvz#a", "%2F%2Fevil", "/guides/%2e%2e/app"])("rejects unsafe or non-guide contexts: %s", (path) => {
    expect(guideSignInHref(path)).toBe("/sign-in");
  });
  it("returns to the current guide after existing-account sign-in", () => {
    expect(guideSignInHref("/guides/pvz/stargate-into-glaives")).toBe("/sign-in?redirect_url=%2Fguides%2Fpvz%2Fstargate-into-glaives");
  });
});
