/**
 * Version pins for the in-browser replay engine (Instant Analysis).
 *
 * `INSTANT_ENGINE_VERSION` must equal `apps/replay-engine/VERSION` and
 * `PYODIDE_VERSION` must equal the exact `pyodide` pin in
 * `apps/web/package.json`. The version-check workflow and
 * `scripts/build-browser-engine.mjs` both fail on drift, so a deploy can
 * never serve an engine bundle this client does not expect.
 *
 * Example:
 *   fetch(ENGINE_POINTER_URL) -> { protocol: ENGINE_PROTOCOL, manifest: "/engine/1.6.3/<id>/manifest.json" }
 */

/** Replay-engine release the browser bundle is built from. */
export const INSTANT_ENGINE_VERSION = "1.6.9";

/** Self-hosted Pyodide release (CPython compiled to WebAssembly). */
export const PYODIDE_VERSION = "314.0.7";

/**
 * Wire contract between `engineWorker.ts` and the Python entry points in
 * `sc2tools_agent.instant_analysis`. Bump both sides together.
 */
export const ENGINE_PROTOCOL = 1;

/**
 * Tiny, revalidated pointer to the current immutable manifest. Everything
 * it points at lives under a content-addressed path and is cached forever.
 */
export const ENGINE_POINTER_URL = "/engine/current.json";
