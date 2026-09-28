/**
 * Error plumbing shared by the engine worker and its client: the typed
 * `EngineError` (an `ErrorKind` + a short, name-free detail) and the
 * heuristics that tell an out-of-memory or a dead interpreter apart from an
 * ordinary Python exception.
 *
 * Details never carry file names, player names or exception messages from
 * the replay (those can contain local paths); only class names and fixed
 * text.
 *
 * Example:
 *   try { await client.boot(); }
 *   catch (e) { if (e instanceof EngineError) show(e.kind); }
 */
import type { ErrorKind } from "./types";

/** A whole-call engine failure (boot, unzip, cancellation). */
export class EngineError extends Error {
  /**
   * Example:
   *   throw new EngineError("engine_unavailable", "engine updated; reload the page");
   */
  constructor(
    readonly kind: ErrorKind,
    readonly detail: string,
  ) {
    super(`${kind}: ${detail}`);
    this.name = "EngineError";
  }
}

const OUT_OF_MEMORY_RE =
  /out of memory|MemoryError|could not allocate memory|Array buffer allocation failed|Cannot enlarge memory/i;
const PYTHON_ERROR_NAME = "PythonError";

function stringField(value: unknown, field: string): string | null {
  if (typeof value !== "object" || value === null || !(field in value)) return null;
  const found: unknown = Reflect.get(value, field);
  return typeof found === "string" ? found : null;
}

/**
 * Class-ish name of a thrown value: the Python exception type for a
 * Pyodide `PythonError`, else the JS error name.
 *
 * Example:
 *   errorName(new RangeError("x")); // -> "RangeError"
 */
export function errorName(error: unknown): string {
  if (isPythonError(error)) return stringField(error, "type") ?? PYTHON_ERROR_NAME;
  return stringField(error, "name") ?? typeof error;
}

/**
 * True for a Pyodide `PythonError` (a Python exception that reached JS;
 * the interpreter itself is still usable).
 *
 * Example:
 *   isPythonError(new Error("x")); // -> false
 */
export function isPythonError(error: unknown): boolean {
  const constructorName =
    typeof error === "object" && error !== null ? error.constructor?.name : undefined;
  return constructorName === PYTHON_ERROR_NAME || stringField(error, "name") === PYTHON_ERROR_NAME;
}

/**
 * True when a thrown value or an error message means the WASM heap or the
 * JS engine ran out of memory.
 *
 * Example:
 *   isOutOfMemory(new RangeError("WebAssembly.Memory(): could not allocate memory")); // -> true
 */
export function isOutOfMemory(error: unknown): boolean {
  if (typeof error === "string") return OUT_OF_MEMORY_RE.test(error);
  if (stringField(error, "type") === "MemoryError") return true;
  const message = stringField(error, "message") ?? "";
  return OUT_OF_MEMORY_RE.test(message) || OUT_OF_MEMORY_RE.test(errorName(error));
}

/**
 * Map an exception thrown while handling ONE request to an `ErrorKind`.
 * Python exceptions keep the interpreter usable (`fallback`); any other
 * JS error means Pyodide itself failed (`worker_crashed`).
 *
 * Example:
 *   requestErrorKind(pythonValueError, "analysis_failed"); // -> "analysis_failed"
 */
export function requestErrorKind(error: unknown, fallback: ErrorKind): ErrorKind {
  if (isOutOfMemory(error)) return "out_of_memory";
  return isPythonError(error) ? fallback : "worker_crashed";
}

/**
 * Kinds after which the worker must not be reused.
 *
 * Example:
 *   isFatalKind("out_of_memory"); // -> true
 */
export function isFatalKind(kind: ErrorKind): boolean {
  return kind === "out_of_memory" || kind === "worker_crashed" || kind === "timeout";
}

/**
 * Safe one-line detail: error class + fixed text (never the message).
 *
 * Example:
 *   safeDetail(new TypeError("C:\\Users\\me\\x"), "the engine failed"); // -> "TypeError: the engine failed"
 */
export function safeDetail(error: unknown, text: string): string {
  return `${errorName(error)}: ${text}`;
}
