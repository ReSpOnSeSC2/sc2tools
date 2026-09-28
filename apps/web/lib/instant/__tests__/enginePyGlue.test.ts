/**
 * createEngineRuntime — the typed JS side of the worker's Python glue,
 * driven by a MOCK Pyodide whose glue functions return canned JSON (the
 * real Python glue runs in tests/engine/pyodide-parity.test.mjs).
 */
import { describe, expect, it, vi } from "vitest";

import { createEngineRuntime } from "../enginePyGlue";
import type { PyodideLike } from "../enginePyodide";

type Glue = Record<string, (...args: unknown[]) => unknown>;

/** MOCK Pyodide: `globals.get(name)` returns the given function with a `destroy()`. */
function fakePyodide(glue: Glue): PyodideLike {
  const callables = new Map(
    Object.entries(glue).map(([name, fn]) => [name, Object.assign((...args: unknown[]) => fn(...args), { destroy: vi.fn() })]),
  );
  return {
    version: "314.0.7",
    runPython: vi.fn(),
    unpackArchive: vi.fn(),
    globals: { get: (name: string) => callables.get(name) },
    _module: { HEAP8: { length: 1024 } },
  };
}

function baseGlue(header: unknown): Glue {
  return {
    _sc2t_players: () => "{}",
    _sc2t_parse: () => "{}",
    _sc2t_unzip: () => JSON.stringify(header),
    _sc2t_unzip_take: (index) => new Uint8Array([Number(index) + 1, 2, 3]),
    _sc2t_unzip_done: () => undefined,
  };
}

describe("createEngineRuntime unzip", () => {
  it("returns each entry with its stored modification time when valid", () => {
    const runtime = createEngineRuntime(fakePyodide(baseGlue({ ok: true, names: ["a.SC2Replay", "b.SC2Replay"], lastModified: [1788264000000, null] })));
    const result = runtime.unzip(new Uint8Array([1]));
    if (!result.ok) throw new Error("expected entries");
    expect(result.entries.map((entry) => [entry.name, entry.lastModified, entry.bytes.byteLength])).toEqual([
      ["a.SC2Replay", 1788264000000, 3],
      ["b.SC2Replay", undefined, 3],
    ]);
  });

  it("accepts a header without times (older bundle) and passes guard codes through", () => {
    const noTimes = createEngineRuntime(fakePyodide(baseGlue({ ok: true, names: ["a.SC2Replay"] })));
    const result = noTimes.unzip(new Uint8Array([1]));
    expect(result.ok && result.entries[0]?.lastModified).toBeUndefined();
    const guarded = createEngineRuntime(fakePyodide(baseGlue({ ok: false, code: "zip_too_large" })));
    expect(guarded.unzip(new Uint8Array([1]))).toEqual({ ok: false, code: "zip_too_large" });
  });
});
