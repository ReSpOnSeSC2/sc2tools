import { afterEach, describe, expect, it } from "vitest";
import {
  FAILED_REQUESTS_KEPT,
  clearFailedRequests,
  recentFailedRequests,
  recordFailedRequest,
} from "../failedRequests";

afterEach(clearFailedRequests);

describe("failed request ring buffer", () => {
  it("keeps the last five, oldest first", () => {
    for (let i = 1; i <= 7; i++) recordFailedRequest({ path: `/v1/games/${i}`, status: 500 });
    const kept = recentFailedRequests();
    expect(kept).toHaveLength(FAILED_REQUESTS_KEPT);
    expect(kept.map((r) => r.path)).toEqual(["/v1/games/3", "/v1/games/4", "/v1/games/5", "/v1/games/6", "/v1/games/7"]);
  });

  it("stores credential-free paths with the status, code and request id", () => {
    recordFailedRequest({
      path: "/v1/overlay-tokens/tok_live_123/widgets?token=abc",
      status: 403,
      code: "forbidden",
      requestId: "req_9",
    });
    expect(recentFailedRequests()).toEqual([
      {
        path: "/v1/overlay-tokens/[redacted]/widgets?token=%5Bredacted%5D",
        status: 403,
        code: "forbidden",
        requestId: "req_9",
      },
    ]);
  });

  it("ignores the report endpoint and normalises odd statuses", () => {
    recordFailedRequest({ path: "/v1/messages", status: 429 });
    recordFailedRequest({ path: "/v1/me", status: 1234, code: "  " });
    expect(recentFailedRequests()).toEqual([{ path: "/v1/me", status: 0 }]);
  });

  it("retains only the fixed private-search route for diagnostics", () => {
    recordFailedRequest({ path: "/V1/search/quick/?q=secret-name&other=secret-build", status: 503,
      code: "private_search_busy", requestId: "req_search" });
    expect(recentFailedRequests()).toEqual([{ path: "/v1/search/quick", status: 503,
      code: "private_search_busy", requestId: "req_search" }]);
    expect(JSON.stringify(recentFailedRequests())).not.toContain("secret");
  });

  it("hands out copies, and clears", () => {
    recordFailedRequest({ path: "/v1/me", status: 500 });
    recentFailedRequests()[0].path = "/changed";
    expect(recentFailedRequests()[0].path).toBe("/v1/me");
    clearFailedRequests();
    expect(recentFailedRequests()).toEqual([]);
  });
});
