/**
 * Subresource integrity for the in-browser engine: every asset the worker
 * executes (Pyodide loader, glue, WebAssembly, stdlib, engine bundle) is
 * fetched as bytes and checked against the SHA-256 in the manifest BEFORE
 * it is imported or instantiated. Uses SubtleCrypto (available in module
 * workers and on the main thread of secure contexts).
 *
 * Example:
 *   const wasm = await fetchVerified("/pyodide/314.0.7/pyodide.asm.wasm", asset.sha256);
 */
import type { ErrorKind } from "./types";

/** Minimal `fetch` shape (injectable in tests). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const HEX_RADIX = 16;
const HEX_BYTE_WIDTH = 2;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** A fetched asset whose bytes do not match the manifest digest. */
export class IntegrityError extends Error {
  readonly kind: Extract<ErrorKind, "integrity_failed"> = "integrity_failed";

  /**
   * Example:
   *   throw new IntegrityError("/engine/x/engine.zip", expected, actual);
   */
  constructor(
    readonly url: string,
    readonly expectedSha256: string,
    readonly actualSha256: string,
  ) {
    super(`integrity check failed for ${url}`);
    this.name = "IntegrityError";
  }
}

/** An asset that could not be downloaded at all (network error or HTTP status). */
export class AssetFetchError extends Error {
  readonly kind: Extract<ErrorKind, "engine_unavailable"> = "engine_unavailable";

  /**
   * Example:
   *   throw new AssetFetchError("/engine/current.json", 404);
   */
  constructor(
    readonly url: string,
    readonly status: number | null,
  ) {
    super(status === null ? `could not fetch ${url}` : `could not fetch ${url} (HTTP ${status})`);
    this.name = "AssetFetchError";
  }
}

/**
 * True for a lower-case 64-character hex SHA-256 digest.
 *
 * Example:
 *   isSha256Hex("ab".repeat(32)); // -> true
 */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX_RE.test(value);
}

/**
 * Lower-case hex SHA-256 of the given bytes.
 *
 * Example:
 *   await sha256Hex(new TextEncoder().encode("abc"));
 *   // -> "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
 */
export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(HEX_RADIX).padStart(HEX_BYTE_WIDTH, "0");
  return hex;
}

/**
 * Fetch `url` and return its bytes only if their SHA-256 equals
 * `expectedSha256`; otherwise throw `IntegrityError`. Network failures and
 * non-2xx responses throw `AssetFetchError`.
 *
 * Example:
 *   const bytes = await fetchVerified(url, manifestAsset.sha256, fetch);
 */
export async function fetchVerified(
  url: string,
  expectedSha256: string,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
  init?: RequestInit,
): Promise<ArrayBuffer> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch {
    throw new AssetFetchError(url, null);
  }
  if (!response.ok) throw new AssetFetchError(url, response.status);
  let bytes: ArrayBuffer;
  try {
    bytes = await response.arrayBuffer();
  } catch {
    throw new AssetFetchError(url, response.status);
  }
  const actual = await sha256Hex(bytes);
  if (actual !== expectedSha256.toLowerCase()) throw new IntegrityError(url, expectedSha256, actual);
  return bytes;
}
