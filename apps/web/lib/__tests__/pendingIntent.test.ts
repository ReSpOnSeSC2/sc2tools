import { beforeEach, describe, expect, it, vi } from "vitest";
import { claimPendingIntent, PENDING_INTENT_KEY, PENDING_INTENT_TTL, queuePendingIntent, readPendingIntent } from "../pendingIntent";
const event = vi.hoisted(() => vi.fn());
vi.mock("../analytics/gtag", () => ({ gaEvent: event }));
beforeEach(() => { sessionStorage.clear(); event.mockClear(); vi.restoreAllMocks(); });
describe("pending authentication intents", () => {
  it("binds one explicit action to its exact safe path and claims it only once", () => {
    expect(queuePendingIntent("vote", { slug: "build-one", delta: 1 }, "/community/builds/build-one?view=all")).toBe(true);
    expect(readPendingIntent("/community/builds/other", "vote")).toBeNull();
    expect(readPendingIntent("/community/builds/build-one?view=all", "save-build")).toBeNull();
    expect(claimPendingIntent("/community/builds/build-one?view=all", "vote")?.payload).toEqual({ slug: "build-one", delta: 1 });
    expect(claimPendingIntent("/community/builds/build-one?view=all", "vote")).toBeNull();
    expect(event).toHaveBeenCalledWith("auth_intent_started", { kind: "vote" });
  });
  it("expires after15minutes and rejects forged longer lifetimes", () => {
    const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now);
    queuePendingIntent("save-build", { slug: "build-one" }, "/community/builds/build-one");
    const valid = JSON.parse(sessionStorage.getItem(PENDING_INTENT_KEY)!);
    sessionStorage.setItem(PENDING_INTENT_KEY, JSON.stringify({ ...valid, expiresAt: valid.expiresAt + 1 }));
    expect(readPendingIntent(valid.path, "save-build")).toBeNull();
    sessionStorage.setItem(PENDING_INTENT_KEY, JSON.stringify(valid)); vi.spyOn(Date, "now").mockReturnValue(now + PENDING_INTENT_TTL);
    expect(readPendingIntent(valid.path, "save-build")).toBeNull(); expect(sessionStorage.getItem(PENDING_INTENT_KEY)).toBeNull();
  });
  it("rejects unsupported destinations and private-source practice payloads", () => {
    expect(queuePendingIntent("save-build", { slug: "build-one" }, "//evil.test")).toBe(false);
    expect(queuePendingIntent("arm-ghost", { matchup: "PvZ", input: { privateBuild: true, build: { name: "Secret", sourceGameId: "private-id" } } }, "/guides/pvz/opener")).toBe(false);
    expect(queuePendingIntent("arm-ghost", { matchup: "PvZ", input: { build: { name: "Guide" }, guideHref: "/guides/pvz/opener" } }, "/guides/pvz/opener")).toBe(true);
  });
  it("discards malformed storage without executing or leaking its payload", () => {
    sessionStorage.setItem(PENDING_INTENT_KEY, "{broken"); expect(readPendingIntent("/help", "vote")).toBeNull();
    sessionStorage.setItem(PENDING_INTENT_KEY, "x".repeat(20_000)); expect(readPendingIntent("/help", "vote")).toBeNull();
    expect(sessionStorage.getItem(PENDING_INTENT_KEY)).toBeNull();
  });
});
