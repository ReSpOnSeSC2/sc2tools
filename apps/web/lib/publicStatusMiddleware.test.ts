// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, type NextFetchEvent } from "next/server";

const authBoundary = vi.hoisted(() => ({
  wrapped: vi.fn(),
  protect: vi.fn<() => Promise<void>>(),
  unavailable: false,
}));

// Preserve Clerk's actual route-pattern matcher. Only its authenticated
// request boundary is synthetic, so no key, account or service is contacted.
vi.mock("@clerk/nextjs/server", async () => {
  const actual = await vi.importActual<typeof import("@clerk/nextjs/server")>("@clerk/nextjs/server");
  return {
    ...actual,
    clerkMiddleware: (handler: (auth: { protect: () => Promise<void> }, request: NextRequest) => unknown) => async (request: NextRequest) => {
      authBoundary.wrapped(request);
      if (authBoundary.unavailable) throw new Error("synthetic_auth_unavailable");
      const result = await handler({ protect: authBoundary.protect }, request);
      return result ?? new Response(null, { headers: { "x-fixture-auth-wrapper": "visited" } });
    },
  };
});

import middleware from "../middleware";

beforeEach(() => {
  authBoundary.wrapped.mockClear();
  authBoundary.protect.mockReset().mockResolvedValue(undefined);
  authBoundary.unavailable = false;
});

async function request(pathname: string, origin = "https://sc2tools.com", headers?: HeadersInit) {
  const result = await middleware(new NextRequest(new URL(pathname, origin), { headers }), {} as NextFetchEvent);
  if (!(result instanceof Response)) throw new Error("Expected a middleware response.");
  return result;
}

describe("public status middleware auth independence", () => {
  it.each(["/status", "/status?token=ignored&next=%2Fadmin", "/api/ping", "/api/ping?nocache=1"])("serves exact %s even when the auth service is unavailable", async pathname => {
    authBoundary.unavailable = true;
    const response = await request(pathname);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("location")).toBeNull();
    expect(authBoundary.wrapped).not.toHaveBeenCalled();
    expect(authBoundary.protect).not.toHaveBeenCalled();
  });

  it.each(["/status-private", "/status/private", "/status/", "/Status", "/api/ping/private", "/api/ping-private", "/api/ping/", "/api/ping.json"])("keeps lookalike path %s inside Clerk", async pathname => {
    authBoundary.unavailable = true;
    await expect(request(pathname)).rejects.toThrow("synthetic_auth_unavailable");
    expect(authBoundary.wrapped).toHaveBeenCalledTimes(1);
  });
});

describe("existing private request protection", () => {
  it.each([
    "/app", "/app/opponents", "/app/game/private-game", "/admin", "/admin/users", "/settings", "/settings/overlay",
    "/notifications", "/devices", "/streaming", "/welcome", "/builds/new", "/builds/private-build/edit",
    "/players/person/replays/game.one", "/p/person/replays/game.one/",
  ])("retains auth.protect for %s", async pathname => {
    const response = await request(pathname);
    expect(response.headers.get("x-fixture-auth-wrapper")).toBe("visited");
    expect(authBoundary.wrapped).toHaveBeenCalledTimes(1);
    expect(authBoundary.protect).toHaveBeenCalledTimes(1);
  });

  it("does not admit a private page when the protection boundary rejects", async () => {
    authBoundary.protect.mockRejectedValueOnce(new Error("synthetic_sign_in_required"));
    await expect(request("/settings")).rejects.toThrow("synthetic_sign_in_required");
  });

  it.each(["/players/person/replays", "/players/person/replays/", "/p/person/replays", "/players/person/replays/opengraph-image.png", "/p/person/replays/twitter-image"])("preserves public replay listing/asset %s without granting an auth bypass", async pathname => {
    await request(pathname);
    expect(authBoundary.wrapped).toHaveBeenCalledTimes(1);
    expect(authBoundary.protect).not.toHaveBeenCalled();
  });
});

describe("dedicated status alias", () => {
  it.each(["/", "/status?token=private", "/app/game/private-game?owner=private&next=https://evil.test/"])("redirects %s permanently to one clean destination before auth", async pathname => {
    authBoundary.unavailable = true;
    const response = await request(pathname, "https://status.sc2tools.com");
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://sc2tools.com/status");
    expect(authBoundary.wrapped).not.toHaveBeenCalled();
    expect(authBoundary.protect).not.toHaveBeenCalled();
  });

  it.each(["https://status.sc2tools.com.evil.test", "https://status-sc2tools.com", "https://notstatus.sc2tools.com"])("does not bypass private protection on lookalike origin %s", async origin => {
    const response = await request("/admin?token=private", origin);
    expect(response.headers.get("location")).toBeNull();
    expect(authBoundary.wrapped).toHaveBeenCalledTimes(1);
    expect(authBoundary.protect).toHaveBeenCalledTimes(1);
  });

  it("does not trust host-like forwarding headers as the status alias", async () => {
    const response = await request("/app/opponents", "https://sc2tools.com", { "x-forwarded-host": "status.sc2tools.com", host: "status.sc2tools.com" });
    expect(response.headers.get("location")).toBeNull();
    expect(authBoundary.protect).toHaveBeenCalledTimes(1);
  });
});
