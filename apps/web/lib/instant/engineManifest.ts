/**
 * Pure validation and URL helpers for the engine pointer
 * (`/engine/current.json`) and the immutable bundle manifest
 * (`/engine/<version>/<bundleId>/manifest.json`). Nothing here fetches or
 * touches Pyodide, so it is unit-tested directly.
 *
 * A pointer or manifest from another engine release is refused with
 * `engine_unavailable` ("engine updated"): the page JS and the engine
 * bundle must come from the same deploy.
 *
 * Example:
 *   const pointer = checkPointer(await res.json());
 *   const manifest = checkManifest(await (await fetch(pointer.manifest)).json());
 *   assetUrl(assetFor(manifest, "engine-bundle"), pointerUrl);
 */
import { EngineError } from "./engineErrors";
import { ENGINE_PROTOCOL, INSTANT_ENGINE_VERSION, PYODIDE_VERSION } from "./engineVersion";
import { isSha256Hex } from "./integrity";
import type { EngineAsset, EngineAssetRole, EngineManifest, EnginePointer } from "./types";

/** Every role a manifest must list exactly once. */
export const ENGINE_ASSET_ROLES: readonly EngineAssetRole[] = [
  "pyodide-loader",
  "pyodide-asm",
  "pyodide-wasm",
  "python-stdlib",
  "engine-bundle",
];

/** File name Pyodide requests relative to its `indexURL`. */
export const PYODIDE_WASM_FILE = "pyodide.asm.wasm";

const ENGINE_UPDATED = "engine updated; reload the page";
const SAME_ORIGIN_PATH_RE = /^\/(?!\/)[\w.\-/]+$/;
const PY_MODULE_RE = /^[A-Za-z_][\w]*(\.[A-Za-z_][\w]*)*$/;
const BUNDLE_ID_RE = /^[0-9a-f]{16}$/;
const PY_PATH_RE = /^\/[\w.\-/]+$/;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRole(value: unknown): value is EngineAssetRole {
  return typeof value === "string" && ENGINE_ASSET_ROLES.some((role) => role === value);
}

/**
 * Structural guard for `EnginePointer`.
 *
 * Example:
 *   isEnginePointer({ protocol: 1, engineVersion: "1.6.3", manifest: "/engine/1.6.3/x/manifest.json" }); // -> true
 */
export function isEnginePointer(value: unknown): value is EnginePointer {
  return (
    isRecord(value) &&
    Number.isInteger(value.protocol) &&
    isString(value.engineVersion) &&
    isString(value.manifest) &&
    SAME_ORIGIN_PATH_RE.test(value.manifest)
  );
}

/**
 * Structural guard for one `EngineAsset`.
 *
 * Example:
 *   isEngineAsset({ role: "engine-bundle", path: "/engine/1/x/engine.zip", sha256: "ab".repeat(32), bytes: 10 }); // -> true
 */
export function isEngineAsset(value: unknown): value is EngineAsset {
  return (
    isRecord(value) &&
    isRole(value.role) &&
    isString(value.path) &&
    SAME_ORIGIN_PATH_RE.test(value.path) &&
    isSha256Hex(value.sha256) &&
    Number.isInteger(value.bytes) &&
    Number(value.bytes) > 0
  );
}

function hasValidPython(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.sysPath)) return false;
  const pathsOk = value.sysPath.every((entry: unknown) => typeof entry === "string" && PY_PATH_RE.test(entry));
  return pathsOk && typeof value.module === "string" && PY_MODULE_RE.test(value.module);
}

function hasValidBuiltFrom(value: unknown): boolean {
  if (!isRecord(value) || !isString(value.agentVersion) || !Array.isArray(value.wheels)) return false;
  return value.wheels.every((wheel: unknown) => isRecord(wheel) && isString(wheel.file) && isSha256Hex(wheel.sha256));
}

function hasValidHeader(value: Json): boolean {
  const versionsOk = isString(value.engineVersion) && isString(value.pyodideVersion) && isString(value.pythonVersion);
  const bundleOk = typeof value.bundleId === "string" && BUNDLE_ID_RE.test(value.bundleId);
  return Number.isInteger(value.protocol) && versionsOk && bundleOk && isRecord(value.lockInfo);
}

function hasEveryRoleOnce(assets: unknown[]): boolean {
  if (!assets.every(isEngineAsset)) return false;
  return ENGINE_ASSET_ROLES.every((role) => assets.filter((asset) => asset.role === role).length === 1);
}

/**
 * Structural guard for `EngineManifest` (every role exactly once).
 *
 * Example:
 *   isEngineManifest(JSON.parse(text)); // -> true for a built manifest
 */
export function isEngineManifest(value: unknown): value is EngineManifest {
  return (
    isRecord(value) &&
    hasValidHeader(value) &&
    Array.isArray(value.assets) &&
    hasEveryRoleOnce(value.assets) &&
    hasValidPython(value.python) &&
    hasValidBuiltFrom(value.builtFrom)
  );
}

/**
 * Validate a fetched pointer against this client's pins.
 *
 * Example:
 *   checkPointer({ protocol: 1, engineVersion: "0.0.1", manifest: "/x" }); // throws engine_unavailable
 */
export function checkPointer(value: unknown): EnginePointer {
  if (!isEnginePointer(value)) throw new EngineError("engine_unavailable", "malformed engine pointer");
  if (value.protocol !== ENGINE_PROTOCOL || value.engineVersion !== INSTANT_ENGINE_VERSION) {
    throw new EngineError("engine_unavailable", ENGINE_UPDATED);
  }
  return value;
}

/**
 * Validate a fetched manifest against this client's pins.
 *
 * Example:
 *   const manifest = checkManifest(json); // throws EngineError("engine_unavailable", ...) when invalid
 */
export function checkManifest(value: unknown): EngineManifest {
  if (!isEngineManifest(value)) throw new EngineError("engine_unavailable", "malformed engine manifest");
  const pinned =
    value.protocol === ENGINE_PROTOCOL &&
    value.engineVersion === INSTANT_ENGINE_VERSION &&
    value.pyodideVersion === PYODIDE_VERSION;
  if (!pinned) throw new EngineError("engine_unavailable", ENGINE_UPDATED);
  if (!assetFor(value, "pyodide-wasm").path.endsWith(`/${PYODIDE_WASM_FILE}`)) {
    throw new EngineError("engine_unavailable", "manifest wasm path is not pyodide.asm.wasm");
  }
  return value;
}

/**
 * The manifest entry for one role (validated manifests have each once).
 *
 * Example:
 *   assetFor(manifest, "python-stdlib").path; // -> "/pyodide/314.0.7/python_stdlib.zip"
 */
export function assetFor(manifest: EngineManifest, role: EngineAssetRole): EngineAsset {
  const asset = manifest.assets.find((entry) => entry.role === role);
  if (!asset) throw new EngineError("engine_unavailable", `manifest lacks ${role}`);
  return asset;
}

/**
 * Absolute URL of a same-origin manifest path.
 *
 * Example:
 *   resolveEngineUrl("/engine/current.json", "https://sc2tools.app/try"); // -> "https://sc2tools.app/engine/current.json"
 */
export function resolveEngineUrl(path: string, baseUrl: string): string {
  return new URL(path, baseUrl).href;
}

/**
 * Pyodide `indexURL`: the directory holding `pyodide.asm.wasm`, with a
 * trailing slash (Pyodide appends file names to it).
 *
 * Example:
 *   pyodideIndexUrl(manifest, "https://sc2tools.app/engine/current.json"); // -> "https://sc2tools.app/pyodide/314.0.7/"
 */
export function pyodideIndexUrl(manifest: EngineManifest, baseUrl: string): string {
  return new URL("./", resolveEngineUrl(assetFor(manifest, "pyodide-wasm").path, baseUrl)).href;
}
