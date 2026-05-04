"use strict";

const { hmac, randomToken, randomDigits, sha256 } = require("../src/util/hash");

describe("util/hash", () => {
  const pepper = Buffer.alloc(32, 0x42);

  test("hmac is deterministic for same input", () => {
    const a = hmac(pepper, "ReSpOnSe#1234");
    const b = hmac(pepper, "ReSpOnSe#1234");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test("hmac differs across pepper", () => {
    const other = Buffer.alloc(32, 0x99);
    expect(hmac(pepper, "x")).not.toBe(hmac(other, "x"));
  });

  test("randomToken is base64url and configurable length", () => {
    const a = randomToken(32);
    const b = randomToken(32);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("randomDigits is fixed-width and zero-padded", () => {
    for (let i = 0; i < 50; i++) {
      const code = randomDigits(6);
      expect(code).toMatch(/^[0-9]{6}$/);
    }
  });

  test("sha256 is deterministic", () => {
    expect(sha256("abc")).toBe(sha256("abc"));
    expect(sha256("abc")).not.toBe(sha256("abd"));
  });
});
