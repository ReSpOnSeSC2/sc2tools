// @ts-nocheck
"use strict";

/**
 * ``jest.mock("@clerk/backend", () => require("./helpers/clerkMock")())``.
 * Bearer ``u:<name>`` verifies as Clerk user ``clerk_<name>``. Kept in its
 * own module: the mock factory must not require the harness, which loads
 * the app (and therefore this mock) itself.
 */
module.exports = function clerkMock() {
  return {
    verifyToken: jest.fn(async (token) => {
      if (typeof token === "string" && token.startsWith("u:")) {
        return { sub: `clerk_${token.slice(2)}` };
      }
      throw new Error("invalid");
    }),
  };
};
