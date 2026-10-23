import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_SESSION_COOKIE, markAppSession } from "./appSession";

afterEach(() => {
  vi.restoreAllMocks();
  document.cookie = `${APP_SESSION_COOKIE}=; Max-Age=0; Path=/`;
});

describe("markAppSession", () => {
  it("sets a browser-session cookie for the whole site", () => {
    const writes: string[] = [];
    vi.spyOn(document, "cookie", "set").mockImplementation((value: string) => {
      writes.push(value);
    });
    markAppSession();
    expect(writes).toEqual(["sc2_app_session=1; Path=/; SameSite=Lax"]);
    // No Max-Age or Expires: it ends with the browser session.
    expect(writes[0]).not.toMatch(/max-age|expires/i);
  });

  it("is readable afterwards", () => {
    markAppSession();
    expect(document.cookie).toContain(`${APP_SESSION_COOKIE}=1`);
  });

  it("never throws when cookies are blocked", () => {
    vi.spyOn(document, "cookie", "set").mockImplementation(() => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    });
    expect(() => markAppSession()).not.toThrow();
  });
});
