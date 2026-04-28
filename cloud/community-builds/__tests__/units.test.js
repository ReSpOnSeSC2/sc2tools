"use strict";

const crypto = require("crypto");
const { signHmac, verifyHmac, safeHexEqual } = require("../src/util/hmac");
const { encodeCursor, decodeCursor } = require("../src/util/cursor");
const { isValidBuildId, isValidClientId } = require("../src/util/ids");
const { validate } = require("../src/validation/validator");
const { loadConfig } = require("../src/config");

describe("util/hmac", () => {
  const pepper = crypto.randomBytes(32);

  test("signHmac is deterministic and verifyHmac round-trips", () => {
    const body = Buffer.from("hello");
    const sig = signHmac(pepper, body);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyHmac({ pepper, body, signature: sig })).toBe(true);
  });

  test("verifyHmac rejects tampered body", () => {
    const sig = signHmac(pepper, Buffer.from("hello"));
    expect(verifyHmac({ pepper, body: Buffer.from("hellp"), signature: sig })).toBe(false);
  });

  test("safeHexEqual handles type/length mismatches gracefully", () => {
    expect(safeHexEqual("aa", "aabb")).toBe(false);
    expect(safeHexEqual("zz", "zz")).toBe(false);
    expect(safeHexEqual("aabb", "aabb")).toBe(true);
  });
});

describe("util/cursor", () => {
  test("round-trips a payload", () => {
    const enc = encodeCursor({ updatedAt: 1, id: "x" });
    expect(decodeCursor(enc)).toEqual({ updatedAt: 1, id: "x" });
  });

  test("decodeCursor returns null on garbage", () => {
    expect(decodeCursor("not-base64-{{{")).toBeNull();
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor("")).toBeNull();
  });
});

describe("util/ids", () => {
  test("isValidBuildId enforces kebab-case length range", () => {
    expect(isValidBuildId("ab")).toBe(false);
    expect(isValidBuildId("ABC")).toBe(false);
    expect(isValidBuildId("good-id")).toBe(true);
  });

  test("isValidClientId enforces hex range", () => {
    expect(isValidClientId("xyz")).toBe(false);
    expect(isValidClientId("a".repeat(32))).toBe(true);
  });
});

describe("validation/validator", () => {
  test("validate('build') accepts a minimal valid body", () => {
    const r = validate("build", {
      id: "abc",
      name: "Abc",
      race: "Protoss",
      vsRace: "Random",
      signature: [
        { t: 0, what: "Probe", weight: 0.1 },
        { t: 1, what: "Pylon", weight: 0.1 },
        { t: 2, what: "Gateway", weight: 0.1 },
        { t: 3, what: "Assimilator", weight: 0.1 },
      ],
    });
    expect(r.ok).toBe(true);
  });

  test("validate('vote') rejects out-of-range value", () => {
    const r = validate("vote", { vote: 0 });
    expect(r.ok).toBe(false);
  });

  test("validate throws for unknown name", () => {
    expect(() => validate("nope", {})).toThrow(/Unknown validator/);
  });
});

describe("config/loadConfig", () => {
  const goodPepper = "a".repeat(64);
  const baseEnv = {
    MONGODB_URI: "mongodb://localhost:27017",
    SERVER_PEPPER_HEX: goodPepper,
  };

  test("loads defaults when only required env present", () => {
    const cfg = loadConfig({ ...baseEnv });
    expect(cfg.port).toBe(8080);
    expect(cfg.nodeEnv).toBe("development");
    expect(cfg.serverPepper.length).toBe(32);
  });

  test("rejects bad pepper", () => {
    expect(() => loadConfig({ ...baseEnv, SERVER_PEPPER_HEX: "short" })).toThrow();
  });

  test("rejects non-integer port", () => {
    expect(() => loadConfig({ ...baseEnv, PORT: "abc" })).toThrow();
  });

  test("parses csv allowed origins", () => {
    const cfg = loadConfig({ ...baseEnv, CORS_ALLOWED_ORIGINS: "http://a, http://b" });
    expect(cfg.corsAllowedOrigins).toEqual(["http://a", "http://b"]);
  });
});
