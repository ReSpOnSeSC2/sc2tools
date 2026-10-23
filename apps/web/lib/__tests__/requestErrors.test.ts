import { describe, expect, it } from "vitest";
import {
  isConnectivityError,
  isNotFoundError,
  networkUnavailableError,
  requestErrorCopy,
  requestErrorKind,
  toClientApiError,
} from "../requestErrors";

describe("requestErrorKind", () => {
  it.each([
    [{ status: 0, code: "network_unavailable", message: "" }, "network"],
    [new TypeError("Failed to fetch"), "network"],
    [{ status: 502, message: "" }, "network"],
    [{ status: 504, message: "" }, "network"],
    [{ status: 503, message: "" }, "network"],
    [{ status: 0, code: "request_timeout", message: "" }, "timeout"],
    [{ status: 503, code: "opponent_profile_busy", message: "" }, "busy"],
    [{ status: 503, code: "trends_busy", message: "" }, "busy"],
    [{ status: 503, code: "replay_storage_unavailable", message: "" }, "server"],
    [{ status: 500, code: "internal_error", message: "" }, "server"],
    [{ status: 401, message: "" }, "signed_out"],
    [{ status: 403, code: "forbidden", message: "" }, "forbidden"],
    [{ status: 404, code: "not_found", message: "" }, "not_found"],
    [{ status: 429, message: "" }, "rate_limited"],
    [{ status: 400, message: "name is required" }, "other"],
    [new Error("boom"), "other"],
  ])("sorts %o as %s", (error, kind) => {
    expect(requestErrorKind(error)).toBe(kind);
  });
});

describe("requestErrorCopy", () => {
  it("explains a dropped connection without blaming the player", () => {
    expect(requestErrorCopy(networkUnavailableError())).toEqual({
      title: "Can't reach SC2 Tools",
      body: expect.stringContaining("restarting or being updated"),
    });
  });

  it("uses the API's own words for other 4xx answers", () => {
    expect(requestErrorCopy({ status: 400, message: "Name must be 3–40 characters." }).body)
      .toBe("Name must be 3–40 characters.");
  });

  it("never shows a bare HTTP status as the explanation", () => {
    expect(requestErrorCopy({ status: 418, message: "HTTP 418" }).body).toBe("Something went wrong. Try again.");
  });
});

describe("toClientApiError", () => {
  it("keeps the request id for support", () => {
    expect(toClientApiError({ status: 500, message: "x", requestId: "abc" }).requestId).toBe("abc");
  });

  it("does not mistake a status-less Error for a dropped connection", () => {
    expect(toClientApiError(new Error("offline")).status).toBe(-1);
    expect(isConnectivityError(new Error("offline"))).toBe(false);
  });
});

describe("predicates", () => {
  it("treats only no-answer and gateway failures as connectivity", () => {
    expect(isConnectivityError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isConnectivityError({ status: 502, message: "" })).toBe(true);
    expect(isConnectivityError({ status: 404, message: "" })).toBe(false);
    expect(isConnectivityError({ status: 503, code: "trends_busy", message: "" })).toBe(false);
  });

  it("recognises a 404 by status or code", () => {
    expect(isNotFoundError({ status: 404, message: "" })).toBe(true);
    expect(isNotFoundError({ status: 0, code: "not_found", message: "" })).toBe(false);
    expect(isNotFoundError({ status: 410, code: "not_found", message: "" })).toBe(true);
  });
});
