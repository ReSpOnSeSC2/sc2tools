/**
 * Boot sequence of the in-browser engine (runs inside the module worker):
 *
 *   pointer (no-cache) -> manifest -> fetch + SHA-256-verify every asset
 *   -> import pyodide.mjs / pyodide.asm.mjs from verified blob: URLs
 *   -> loadPyodide with the verified stdlib (blob:) and wasm (fetch shim)
 *   -> unpack engine.zip at "/" -> sys.path -> import the engine module.
 *
 * Nothing unverified is ever executed: the only network reads Pyodide would
 * make itself (lock file, wasm, stdlib, glue) are replaced by
 * `lockFileContents`, the fetch shim, `stdLibURL` and `createPyodideModule`,
 * and the shim refuses any other non-`blob:` request while Pyodide starts.
 *
 * Example:
 *   const { pyodide, manifest, info } = await bootEngine("https://sc2tools.app/engine/current.json");
 */
import { EngineError, isOutOfMemory, safeDetail } from "./engineErrors";
import {
  PYODIDE_WASM_FILE,
  assetFor,
  checkManifest,
  checkPointer,
  pyodideIndexUrl,
  resolveEngineUrl,
} from "./engineManifest";
import {
  isPyodideAsmModule,
  isPyodideLoaderModule,
  type PyodideLike,
} from "./enginePyodide";
import { AssetFetchError, IntegrityError, fetchVerified, type FetchLike } from "./integrity";
import type { BootErrorEvent } from "./protocol";
import type { EngineAssetRole, EngineInfo, EngineManifest, EnginePointer } from "./types";

/** Verified bytes of every manifest asset, by role. */
export type VerifiedAssets = Record<EngineAssetRole, ArrayBuffer>;

/** A global whose `fetch` can be shimmed (the worker's `self`). */
export interface FetchScope {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

/** Injectable platform hooks (defaults use the worker globals). */
export interface BootDeps {
  fetchImpl?: FetchLike;
  scope?: FetchScope;
  importModule?: (url: string) => Promise<unknown>;
  now?: () => number;
}

export interface BootedEngine {
  pyodide: PyodideLike;
  manifest: EngineManifest;
  info: EngineInfo;
}

type BootErrorKind = BootErrorEvent["errorKind"];

const JS_MIME = "text/javascript";
const ZIP_MIME = "application/zip";
const WASM_MIME = "application/wasm";
const NO_OUTPUT = (): void => undefined;
const IMPORT_SCRIPTS = "importScripts";
const BLOB_SCHEME = "blob:";
const BLOCKED_FETCH = "the engine boot refused an unverified request";

function defaultFetch(): FetchLike {
  return (input, init) => fetch(input, init);
}

function defaultImport(url: string): Promise<unknown> {
  return import(/* webpackIgnore: true */ /* @vite-ignore */ url);
}

async function fetchJson(url: string, fetchImpl: FetchLike, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch {
    throw new AssetFetchError(url, null);
  }
  if (!response.ok) throw new AssetFetchError(url, response.status);
  try {
    return await response.json();
  } catch {
    throw new EngineError("engine_unavailable", "engine metadata is not valid JSON");
  }
}

/**
 * Fetch and validate `/engine/current.json` (always revalidated).
 *
 * Example:
 *   const pointer = await loadPointer("https://sc2tools.app/engine/current.json", fetch);
 */
export async function loadPointer(pointerUrl: string, fetchImpl: FetchLike = defaultFetch()): Promise<EnginePointer> {
  return checkPointer(await fetchJson(pointerUrl, fetchImpl, { cache: "no-cache" }));
}

/**
 * Fetch and validate an immutable bundle manifest.
 *
 * Example:
 *   const manifest = await loadManifest(resolveEngineUrl(pointer.manifest, pointerUrl), fetch);
 */
export async function loadManifest(manifestUrl: string, fetchImpl: FetchLike = defaultFetch()): Promise<EngineManifest> {
  return checkManifest(await fetchJson(manifestUrl, fetchImpl));
}

/**
 * Download every manifest asset in parallel and verify each SHA-256.
 *
 * Example:
 *   const assets = await fetchAllVerified(manifest, pointerUrl, fetch);
 *   assets["pyodide-wasm"].byteLength; // -> 9598218
 */
export async function fetchAllVerified(
  manifest: EngineManifest,
  baseUrl: string,
  fetchImpl: FetchLike = defaultFetch(),
): Promise<VerifiedAssets> {
  const fetchRole = (role: EngineAssetRole): Promise<ArrayBuffer> => {
    const asset = assetFor(manifest, role);
    return fetchVerified(resolveEngineUrl(asset.path, baseUrl), asset.sha256, fetchImpl);
  };
  const [loader, asm, wasm, stdlib, bundle] = await Promise.all([
    fetchRole("pyodide-loader"),
    fetchRole("pyodide-asm"),
    fetchRole("pyodide-wasm"),
    fetchRole("python-stdlib"),
    fetchRole("engine-bundle"),
  ]);
  return {
    "pyodide-loader": loader,
    "pyodide-asm": asm,
    "pyodide-wasm": wasm,
    "python-stdlib": stdlib,
    "engine-bundle": bundle,
  };
}

function requestUrl(input: RequestInfo | URL, base: string): string {
  if (typeof input === "string") return new URL(input, base).href;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Replace `scope.fetch` while Pyodide boots, failing closed:
 *
 * - exactly `wasmUrl` gets the verified `bytes` (so Pyodide's
 *   `instantiateStreaming` compiles the verified module);
 * - `blob:` URLs (the verified stdlib this module created) pass through;
 * - every other request is refused, so a Pyodide code path we did not
 *   anticipate can never pull an unverified file from the network.
 *
 * Returns a function that restores the original `fetch`.
 *
 * Example:
 *   const restore = installWasmFetchShim(self, "https://x/pyodide/314.0.7/pyodide.asm.wasm", wasm);
 *   try { await loadPyodide(config); } finally { restore(); }
 */
export function installWasmFetchShim(scope: FetchScope, wasmUrl: string, bytes: ArrayBuffer): () => void {
  const original = scope.fetch;
  scope.fetch = (input, init) => {
    const url = requestUrl(input, wasmUrl);
    if (url === wasmUrl) return Promise.resolve(new Response(bytes, { headers: { "Content-Type": WASM_MIME } }));
    if (url.startsWith(BLOB_SCHEME)) return original.call(scope, input, init);
    return Promise.reject(new TypeError(BLOCKED_FETCH));
  };
  return () => {
    scope.fetch = original;
  };
}

/**
 * Python run after unpacking: sys.path, fresh import caches, a silent
 * sc2reader logger, then the engine import (fails the boot early).
 *
 * Example:
 *   pyodide.runPython(activationCode(manifest));
 */
export function activationCode(manifest: EngineManifest): string {
  const sysPath = JSON.stringify(JSON.stringify(manifest.python.sysPath));
  return [
    "import importlib, json, logging, sys",
    `for _sc2t_entry in reversed(json.loads(${sysPath})):`,
    "    if _sc2t_entry not in sys.path:",
    "        sys.path.insert(0, _sc2t_entry)",
    "importlib.invalidate_caches()",
    'logging.getLogger("sc2reader").setLevel(logging.CRITICAL)',
    `importlib.import_module(${JSON.stringify(manifest.python.module)})`,
  ].join("\n");
}

function blobUrl(bytes: ArrayBuffer, type: string, created: string[]): string {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  created.push(url);
  return url;
}

/**
 * Run `run` with `scope.importScripts` hidden, then restore it.
 *
 * Next.js' webpack only emits MODULE workers when `output.module` is on, so
 * it rewrites `new Worker(url, { type: "module" })` to a classic worker.
 * Pyodide's ESM files refuse to start in a classic worker by probing
 * `importScripts`, although everything they need (dynamic `import()`, fetch,
 * WebAssembly) works there in every browser with module-worker support.
 * Hiding the probe target during boot makes both worker kinds work; nothing
 * calls `importScripts` while Pyodide starts.
 *
 * Example:
 *   const pyodide = await withImportScriptsHidden(globalThis, () => loadPyodide(config));
 */
export async function withImportScriptsHidden<T>(scope: object, run: () => Promise<T>): Promise<T> {
  if (typeof Reflect.get(scope, IMPORT_SCRIPTS) !== "function") return run();
  const hadOwn = Object.prototype.hasOwnProperty.call(scope, IMPORT_SCRIPTS);
  const original: unknown = Reflect.get(scope, IMPORT_SCRIPTS);
  Object.defineProperty(scope, IMPORT_SCRIPTS, { value: undefined, configurable: true, writable: true });
  try {
    return await run();
  } finally {
    if (hadOwn) Object.defineProperty(scope, IMPORT_SCRIPTS, { value: original, configurable: true, writable: true });
    else Reflect.deleteProperty(scope, IMPORT_SCRIPTS);
  }
}

async function importPyodideModules(assets: VerifiedAssets, importModule: (url: string) => Promise<unknown>, created: string[]) {
  const loader = await importModule(blobUrl(assets["pyodide-loader"], JS_MIME, created));
  const asm = await importModule(blobUrl(assets["pyodide-asm"], JS_MIME, created));
  if (!isPyodideLoaderModule(loader) || !isPyodideAsmModule(asm)) {
    throw new EngineError("engine_boot_failed", "verified Pyodide modules have an unexpected shape");
  }
  return { loadPyodide: loader.loadPyodide, createPyodideModule: asm.default };
}

async function startPyodide(input: { assets: VerifiedAssets; manifest: EngineManifest; indexURL: string }, deps: BootDeps, created: string[]): Promise<PyodideLike> {
  const { assets, manifest, indexURL } = input;
  const modules = await importPyodideModules(assets, deps.importModule ?? defaultImport, created);
  const scope = deps.scope ?? globalThis;
  const restore = installWasmFetchShim(scope, new URL(PYODIDE_WASM_FILE, indexURL).href, assets["pyodide-wasm"]);
  try {
    return await modules.loadPyodide({
      indexURL,
      createPyodideModule: modules.createPyodideModule,
      stdLibURL: blobUrl(assets["python-stdlib"], ZIP_MIME, created),
      lockFileContents: { info: manifest.lockInfo, packages: {} },
      stdout: NO_OUTPUT,
      stderr: NO_OUTPUT,
      env: {},
    });
  } finally {
    restore();
  }
}

/**
 * Start Pyodide from already-verified bytes and activate the engine.
 *
 * Example:
 *   const pyodide = await bootPyodideFromVerified({ assets, manifest, baseUrl: pointerUrl });
 */
export async function bootPyodideFromVerified(
  input: { assets: VerifiedAssets; manifest: EngineManifest; baseUrl: string },
  deps: BootDeps = {},
): Promise<PyodideLike> {
  const { assets, manifest, baseUrl } = input;
  const indexURL = pyodideIndexUrl(manifest, baseUrl);
  const created: string[] = [];
  let pyodide: PyodideLike;
  try {
    pyodide = await withImportScriptsHidden(globalThis, () => startPyodide({ assets, manifest, indexURL }, deps, created));
  } finally {
    created.forEach((url) => URL.revokeObjectURL(url));
  }
  pyodide.unpackArchive(new Uint8Array(assets["engine-bundle"]), "zip", { extractDir: "/" });
  pyodide.runPython(activationCode(manifest));
  return pyodide;
}

/**
 * Full boot: pointer -> manifest -> verified assets -> Pyodide -> engine.
 *
 * Example:
 *   const { info } = await bootEngine(new URL("/engine/current.json", location.href).href);
 */
export async function bootEngine(pointerUrl: string, deps: BootDeps = {}): Promise<BootedEngine> {
  const now = deps.now ?? (() => performance.now());
  const started = now();
  const fetchImpl = deps.fetchImpl ?? defaultFetch();
  const pointer = await loadPointer(pointerUrl, fetchImpl);
  const manifestUrl = resolveEngineUrl(pointer.manifest, pointerUrl);
  const manifest = await loadManifest(manifestUrl, fetchImpl);
  const assets = await fetchAllVerified(manifest, manifestUrl, fetchImpl);
  const pyodide = await bootPyodideFromVerified({ assets, manifest, baseUrl: manifestUrl }, deps);
  const info: EngineInfo = {
    engineVersion: manifest.engineVersion,
    pyodideVersion: manifest.pyodideVersion,
    pythonVersion: manifest.pythonVersion,
    bundleId: manifest.bundleId,
    bootMs: Math.round(now() - started),
  };
  return { pyodide, manifest, info };
}

const BOOT_ERROR_KINDS: readonly BootErrorKind[] = [
  "integrity_failed",
  "engine_boot_failed",
  "engine_unavailable",
  "out_of_memory",
];

/**
 * Classify a boot failure for the `boot-error` event (kind + safe detail).
 *
 * Example:
 *   describeBootError(new IntegrityError(url, a, b)); // -> { errorKind: "integrity_failed", detail: "..." }
 */
export function describeBootError(error: unknown): { errorKind: BootErrorKind; detail: string } {
  if (error instanceof IntegrityError || error instanceof AssetFetchError) {
    return { errorKind: error.kind, detail: error.message };
  }
  if (error instanceof EngineError) {
    const known = BOOT_ERROR_KINDS.find((kind) => kind === error.kind);
    return { errorKind: known ?? "engine_boot_failed", detail: error.detail };
  }
  if (isOutOfMemory(error)) return { errorKind: "out_of_memory", detail: safeDetail(error, "not enough memory to start the engine") };
  return { errorKind: "engine_boot_failed", detail: safeDetail(error, "the engine runtime failed to start") };
}
