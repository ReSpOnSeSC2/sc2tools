/**
 * The thin Python glue between the worker and
 * `sc2tools_agent.instant_analysis`, and a typed JS wrapper around it.
 *
 * Bytes cross into Python as a `Uint8Array` (a JsProxy with `to_bytes()`),
 * results come back as JSON strings (no PyProxy is ever returned to JS, so
 * nothing leaks), and every call ends with `gc.collect()`, which keeps the
 * WASM heap flat across hundreds of parses. The only proxies held are the
 * glue functions themselves, destroyed by `dispose()`.
 *
 * Example:
 *   const runtime = createEngineRuntime(pyodide);
 *   const raw = runtime.parse(bytes, "Accounts/1/1-S2-1-1/x.SC2Replay", "1-S2-1-1", "", false);
 *   JSON.parse(raw).envelope.ok; // -> true
 */
import { isPyCallable, type PyCallableLike, type PyodideLike } from "./enginePyodide";

/** Python source installed into the interpreter's globals once per boot. */
export const ENGINE_GLUE_SOURCE = `
import gc as _sc2t_gc
import json as _sc2t_json

from sc2tools_agent import instant_analysis as _sc2t_ia

_sc2t_pending = []


def _sc2t_bytes(data):
    return data.to_bytes() if hasattr(data, "to_bytes") else bytes(data)


def _sc2t_players(data, filename):
    try:
        return _sc2t_json.dumps(_sc2t_ia.list_replay_players(_sc2t_bytes(data), filename=filename))
    finally:
        _sc2t_gc.collect()


def _sc2t_parse(data, filename, toon, handle, want_digests):
    blob = _sc2t_bytes(data)
    try:
        runtime = _sc2t_ia.RuntimeOptions(player_toon=toon or None, player_handle=handle or None)
        envelope = _sc2t_ia.parse_replay_bytes(blob, filename=filename, runtime=runtime)
        envelope.pop("payload", None)
        result = {"envelope": envelope}
        if want_digests and envelope.get("ok"):
            result["digests"] = _sc2t_ia.replay_digests(blob)
        return _sc2t_json.dumps(result)
    finally:
        del blob
        _sc2t_gc.collect()


def _sc2t_unzip(data):
    _sc2t_pending.clear()
    try:
        entries = _sc2t_ia.expand_replay_zip(_sc2t_bytes(data))
    except ValueError as exc:
        return _sc2t_json.dumps({"ok": False, "code": str(exc)})
    _sc2t_pending.extend(entry["data"] for entry in entries)
    return _sc2t_json.dumps({"ok": True, "names": [entry["name"] for entry in entries]})


def _sc2t_unzip_take(index):
    from pyodide.ffi import to_js

    data = _sc2t_pending[index]
    _sc2t_pending[index] = b""
    return to_js(data)


def _sc2t_unzip_done():
    _sc2t_pending.clear()
    _sc2t_gc.collect()
`;

const GLUE_FUNCTIONS = ["_sc2t_players", "_sc2t_parse", "_sc2t_unzip", "_sc2t_unzip_take", "_sc2t_unzip_done"] as const;
type GlueName = (typeof GLUE_FUNCTIONS)[number];

/** Result of `unzip`: entry names + bytes, or the Python guard code. */
export type UnzipResult =
  | { ok: true; entries: Array<{ name: string; bytes: ArrayBuffer }> }
  | { ok: false; code: string };

/** Typed calls into the glue. Raw JSON strings are narrowed by the caller. */
export interface EngineRuntime {
  players(bytes: Uint8Array, filename: string): string;
  parse(bytes: Uint8Array, filename: string, toon: string, handle: string, wantDigests: boolean): string;
  unzip(bytes: Uint8Array): UnzipResult;
  heapBytes(): number;
  dispose(): void;
}

function asString(value: unknown, what: string): string {
  if (typeof value !== "string") throw new TypeError(`${what} returned a non-string result`);
  return value;
}

/** Exact-size copy, so the buffer can be transferred without dragging extra bytes along. */
function ownBuffer(value: unknown): ArrayBuffer {
  if (!(value instanceof Uint8Array)) throw new TypeError("unzip entry is not a Uint8Array");
  const whole = value.byteOffset === 0 && value.byteLength === value.buffer.byteLength;
  return whole && value.buffer instanceof ArrayBuffer ? value.buffer : value.slice().buffer;
}

function parseUnzipHeader(raw: string): { ok: true; names: string[] } | { ok: false; code: string } {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed === "object" && parsed !== null && "ok" in parsed) {
    if (parsed.ok === true && "names" in parsed && Array.isArray(parsed.names)) {
      return { ok: true, names: parsed.names.map((name: unknown) => String(name)) };
    }
    if ("code" in parsed && typeof parsed.code === "string") return { ok: false, code: parsed.code };
  }
  throw new TypeError("unzip returned a malformed header");
}

/**
 * Install the glue into `pyodide` and return typed wrappers around it.
 *
 * Example:
 *   const runtime = createEngineRuntime(pyodide);
 *   runtime.heapBytes(); // -> 37748736
 */
export function createEngineRuntime(pyodide: PyodideLike): EngineRuntime {
  pyodide.runPython(ENGINE_GLUE_SOURCE);
  const fns = new Map<GlueName, PyCallableLike>();
  for (const name of GLUE_FUNCTIONS) {
    const fn = pyodide.globals.get(name);
    if (!isPyCallable(fn)) throw new TypeError(`engine glue function ${name} is missing`);
    fns.set(name, fn);
  }
  const call = (name: GlueName, ...args: unknown[]): unknown => {
    const fn = fns.get(name);
    if (!fn) throw new TypeError(`engine glue function ${name} was disposed`);
    return fn(...args);
  };
  const unzip = (bytes: Uint8Array): UnzipResult => {
    const header = parseUnzipHeader(asString(call("_sc2t_unzip", bytes), "unzip"));
    if (!header.ok) return header;
    try {
      const entries = header.names.map((name, index) => ({ name, bytes: ownBuffer(call("_sc2t_unzip_take", index)) }));
      return { ok: true, entries };
    } finally {
      call("_sc2t_unzip_done");
    }
  };
  return {
    players: (bytes, filename) => asString(call("_sc2t_players", bytes, filename), "players"),
    parse: (bytes, filename, toon, handle, wantDigests) =>
      asString(call("_sc2t_parse", bytes, filename, toon, handle, wantDigests), "parse"),
    unzip,
    heapBytes: () => pyodide._module.HEAP8.length,
    dispose: () => {
      fns.forEach((fn) => fn.destroy());
      fns.clear();
    },
  };
}
