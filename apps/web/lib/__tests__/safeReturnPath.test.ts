import { describe, expect, it } from "vitest";
import { returnPathLabel, safeReturnPath } from "../safeReturnPath";

describe("safeReturnPath", () => {
  it.each(["/community", "/community/builds/proxy-gate", "/guides/PvZ/forge-expand", "/reviews/example", "/p/example", "/players/example", "/try", "/try?resume=1", "/stream-studio/learn", "/download", "/donate", "/help/getting-started", "/settings?tab=overlay", "/settings?tab=profile", "/community?race=P&sort=newest"])("retains allowlisted context %s", path => {
    expect(safeReturnPath(path)).toBe(path);
  });
  it.each([null, undefined, "", "/", "/app", "/admin", "/settings", "/settings?tab=security", "/settings?tab=overlay&tab=profile", "/settings?tab=overlay&secret=x",
    "https://example.com/help", "//evil.test/help", "/\\evil.test/help", "javascript:alert(1)", " /help", "/help ", "/help\n", "/help#section", "/help?x=%23section", "/help/%20entry", "/help/%09entry", "/help/%00entry", "/help/%7fentry",
    "/help/../donate", "/help/%2e%2e/donate", "/help/.%2e/donate", "/help/%252e%252e/donate", "/help/%2f%2fevil.test", "/help/%5cevil.test", "/help/%3fevil", "/help//evil", "/helpers/fake", "/community-evil/fake", "%252Fhelp", "%2F%2Fevil.test", "/help/%E0%A4%A", "/help/%", "/try?resume=0", "/try?resume=1&x=//evil.test", "/help/" + "a".repeat(513)])("rejects unsafe or unrelated context %s", path => {
    expect(safeReturnPath(path)).toBeNull();
  });
  it("keeps the once-encoded try claim and rejects double encoding", () => {
    expect(safeReturnPath("%2Ftry%3Fresume%3D1")).toBe("/try?resume=1");
    expect(safeReturnPath("%2ftry%3fresume%3d1")).toBe("/try?resume=1");
    expect(safeReturnPath(encodeURIComponent(encodeURIComponent("/try?resume=1")))).toBeNull();
  });
  it("keeps canonical player and archive context without changing the redirect policy", () => {
    for (const path of ["/players/fixture-player-0123456789?tab=builds", "/players/fixture-player-0123456789/replays?race=P&result=win"]) {
      expect(safeReturnPath(path)).toBe(path);
    }
    expect(returnPathLabel("/players/fixture-player-0123456789?tab=builds")).toBe("Player page");
  });
  it("uses a friendly page label without publishing a private query or slug", () => {
    expect(returnPathLabel("/guides/PvZ/private-name?secret=value")).toBe("Build guide");
  });
  it("preserves one known public build variant without allowing the private library", () => {
    expect(safeReturnPath("/definitions?variant=zerg-12-pool")).toBe("/definitions?variant=zerg-12-pool");
    expect(returnPathLabel("/definitions?variant=zerg-12-pool")).toBe("Build variant");
  });
  it.each(["/builds", "/builds?create=1", "/definitions", "/definitions/private?variant=zerg-12-pool", "/definitions?variant=unknown", "/definitions?variant=zerg-12-pool&next=/app", "/definitions?variant=zerg-12-pool&variant=zerg-12-pool", "/definitions?variant=zerg-12-pool&race=Z", "/definitions?Variant=zerg-12-pool"])("rejects expanded or unknown variant continuations %s", path => {
    expect(safeReturnPath(path)).toBeNull();
  });
});
