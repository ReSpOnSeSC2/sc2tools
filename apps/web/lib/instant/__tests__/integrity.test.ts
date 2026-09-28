import { describe, expect, it, vi } from "vitest";

import {
  AssetFetchError,
  IntegrityError,
  fetchVerified,
  isSha256Hex,
  sha256Hex,
  type FetchLike,
} from "../integrity";

// FIPS 180-2 test vectors.
const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const HTTP_NOT_FOUND = 404;

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function fetchReturning(body: Uint8Array, status = 200): FetchLike {
  return vi.fn(async () => new Response(body, { status }));
}

describe("sha256Hex", () => {
  it("matches the FIPS 180-2 'abc' vector", async () => {
    expect(await sha256Hex(encode("abc"))).toBe(ABC_SHA256);
  });

  it("hashes an ArrayBuffer and an empty input", async () => {
    expect(await sha256Hex(new ArrayBuffer(0))).toBe(EMPTY_SHA256);
  });

  it("respects the view window of a Uint8Array subarray", async () => {
    const padded = encode("xxabcxx").subarray(2, 5);
    expect(await sha256Hex(padded)).toBe(ABC_SHA256);
  });
});

describe("isSha256Hex", () => {
  it("accepts lower-case 64-char hex only", () => {
    expect(isSha256Hex(ABC_SHA256)).toBe(true);
    expect(isSha256Hex(ABC_SHA256.toUpperCase())).toBe(false);
    expect(isSha256Hex("abc")).toBe(false);
    expect(isSha256Hex(42)).toBe(false);
  });
});

describe("fetchVerified", () => {
  it("returns the bytes when the digest matches", async () => {
    const bytes = await fetchVerified("/engine/x/engine.zip", ABC_SHA256, fetchReturning(encode("abc")));
    expect(new TextDecoder().decode(bytes)).toBe("abc");
  });

  it("accepts an upper-case expected digest", async () => {
    await expect(
      fetchVerified("/a", ABC_SHA256.toUpperCase(), fetchReturning(encode("abc"))),
    ).resolves.toBeInstanceOf(ArrayBuffer);
  });

  it("throws IntegrityError (kind integrity_failed) on a mismatch", async () => {
    const error = await fetchVerified("/pyodide/314.0.7/pyodide.asm.wasm", ABC_SHA256, fetchReturning(encode("abd")))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(IntegrityError);
    if (!(error instanceof IntegrityError)) return;
    expect(error.kind).toBe("integrity_failed");
    expect(error.expectedSha256).toBe(ABC_SHA256);
    expect(error.actualSha256).not.toBe(ABC_SHA256);
  });

  it("throws AssetFetchError for HTTP errors and network failures", async () => {
    const notFound = await fetchVerified("/a", ABC_SHA256, fetchReturning(encode(""), HTTP_NOT_FOUND))
      .catch((caught: unknown) => caught);
    expect(notFound).toBeInstanceOf(AssetFetchError);
    const offline: FetchLike = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const network = await fetchVerified("/a", ABC_SHA256, offline).catch((caught: unknown) => caught);
    expect(network).toBeInstanceOf(AssetFetchError);
    if (network instanceof AssetFetchError) expect(network.kind).toBe("engine_unavailable");
  });
});
