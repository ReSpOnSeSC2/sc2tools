/**
 * Minimal local typing of the Pyodide API the engine worker uses.
 *
 * The self-hosted runtime is imported at run time from a verified `blob:`
 * URL, so there is no compile-time `pyodide` import (webpack must not
 * bundle it). These interfaces cover only what we call; the guards check the
 * runtime shape of dynamically imported modules before use.
 *
 * Example:
 *   const mod: unknown = await import(url);
 *   if (!isPyodideLoaderModule(mod)) throw new Error("not a Pyodide loader");
 *   const pyodide = await mod.loadPyodide(config);
 */

/** A Python object handle living in the WASM heap; must be destroyed. */
export interface PyProxyLike {
  destroy(): void;
}

/** A callable Python object (function) exposed to JS. */
export interface PyCallableLike extends PyProxyLike {
  (...args: unknown[]): unknown;
}

/** Pyodide lock file shape accepted by `lockFileContents`. */
export interface PyodideLockContents {
  info: Record<string, unknown>;
  packages: Record<string, never>;
}

/** Options we pass to `loadPyodide` (subset of Pyodide's `PyodideConfig`). */
export interface PyodideBootConfig {
  indexURL: string;
  createPyodideModule?: unknown;
  stdLibURL?: string;
  lockFileContents: PyodideLockContents;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  env: Record<string, string>;
  checkAPIVersion?: boolean;
}

/** The Pyodide API surface the engine uses. */
export interface PyodideLike {
  version: string;
  runPython(code: string): unknown;
  unpackArchive(
    buffer: ArrayBuffer | Uint8Array,
    format: string,
    options?: { extractDir?: string },
  ): void;
  globals: { get(name: string): unknown };
  /** Emscripten module; `HEAP8.length` is the current WASM heap size. */
  _module: { HEAP8: { length: number } };
}

export type LoadPyodide = (config: PyodideBootConfig) => Promise<PyodideLike>;

function hasFunction(value: unknown, name: string): boolean {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof Reflect.get(value, name) === "function"
  );
}

/**
 * True for the namespace of `pyodide.mjs` (exports `loadPyodide`).
 * The call signature itself cannot be checked at run time; the module
 * comes from a digest-verified asset of the pinned Pyodide release.
 *
 * Example:
 *   isPyodideLoaderModule({ loadPyodide: async () => ({}) }); // -> true
 */
export function isPyodideLoaderModule(value: unknown): value is { loadPyodide: LoadPyodide } {
  return hasFunction(value, "loadPyodide");
}

/**
 * True for the namespace of `pyodide.asm.mjs` (default-exports the
 * Emscripten module factory passed as `createPyodideModule`).
 *
 * Example:
 *   isPyodideAsmModule({ default: () => {} }); // -> true
 */
export function isPyodideAsmModule(value: unknown): value is { default: unknown } {
  return hasFunction(value, "default");
}

/**
 * True for a callable PyProxy (a Python function fetched from globals).
 *
 * Example:
 *   isPyCallable(pyodide.globals.get("_sc2t_parse")); // -> true after the glue ran
 */
export function isPyCallable(value: unknown): value is PyCallableLike {
  return typeof value === "function" && hasFunction(value, "destroy");
}
