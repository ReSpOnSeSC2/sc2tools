"use strict";

const v8 = require("v8");

const RUNTIME_CAPACITY_INTERVAL_MS = 30_000;
const MAX_SNAPSHOT_DEPTH = 3;
const MAX_KEYS_PER_OBJECT = 32;
const SAFE_SOURCE_NAME = /^[a-z][a-zA-Z0-9]{0,39}$/;
const ALLOWED_SOURCE_NAMES = new Set([
  "pulse",
  "session",
  "customReclassification",
  "overlayTokens",
  "multichatViewers",
  "youtubeRelay",
  "analysisCorpus",
  "opponentProfiles",
  "overlayEnrichment",
  "gameDetailsHeavyIo",
  "mlTraining",
]);
const SENSITIVE_FIELD =
  /user|token|secret|credential|authorization|auth|email|slug|identifier|(?:^|[_-])id(?:$|[_-])|Id$|(?:^|[_-])key(?:$|[_-])|Key$/i;

/**
 * Small registry for capacity-only snapshots owned by route-local components.
 * Providers remain synchronous and their output passes through a fail-closed
 * numeric/boolean sanitizer before it can reach production logs.
 */
class RuntimeCapacityRegistry {
  constructor() {
    /** @type {Map<string, () => unknown>} */
    this.providers = new Map();
  }

  /**
   * Register or replace one process-local capacity provider.
   *
   * @param {string} name fixed, non-user-derived source name
   * @param {() => unknown} provider synchronous read-only snapshot
   * @returns {() => void} unregister callback
   */
  register(name, provider) {
    if (!SAFE_SOURCE_NAME.test(name) || !ALLOWED_SOURCE_NAMES.has(name)) {
      throw new TypeError("runtime capacity source name is invalid");
    }
    if (typeof provider !== "function") {
      throw new TypeError("runtime capacity provider must be a function");
    }
    this.providers.set(name, provider);
    return () => {
      if (this.providers.get(name) === provider) this.providers.delete(name);
    };
  }

  /**
   * @returns {{sources: Record<string, unknown>, providerErrors: number}}
   */
  snapshot() {
    /** @type {Record<string, unknown>} */
    const sources = {};
    let providerErrors = 0;
    for (const [name, provider] of this.providers) {
      try {
        const sanitized = sanitizeCapacityValue(provider(), 0);
        if (sanitized && typeof sanitized === "object") {
          sources[name] = sanitized;
        }
      } catch {
        // A telemetry provider must never affect serving traffic. Do not log
        // the thrown value because it could contain request/user material.
        providerErrors += 1;
      }
    }
    return { sources, providerErrors };
  }
}

/**
 * Periodically log a bounded, credential-free view of process capacity.
 * The timer is explicitly unref'd and is stopped during graceful shutdown.
 *
 * @param {{
 *   logger: {info: Function, warn?: Function},
 *   io?: import('socket.io').Server | null,
 *   registry?: RuntimeCapacityRegistry | null,
 *   intervalMs?: number,
 *   memoryUsage?: () => NodeJS.MemoryUsage,
 *   heapStatistics?: () => v8.HeapInfo,
 *   setIntervalImpl?: typeof setInterval,
 *   clearIntervalImpl?: typeof clearInterval,
 * }} opts
 */
function buildRuntimeCapacityMonitor(opts) {
  const intervalMs = Number.isFinite(opts.intervalMs)
    && Number(opts.intervalMs) > 0
    ? Math.floor(Number(opts.intervalMs))
    : RUNTIME_CAPACITY_INTERVAL_MS;
  const memoryUsage = opts.memoryUsage || process.memoryUsage.bind(process);
  const heapStatistics = opts.heapStatistics || v8.getHeapStatistics;
  const setIntervalImpl = opts.setIntervalImpl || setInterval;
  const clearIntervalImpl = opts.clearIntervalImpl || clearInterval;
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;

  function logNow() {
    try {
      const memory = memoryUsage();
      const heap = heapStatistics();
      const registered = opts.registry
        ? opts.registry.snapshot()
        : { sources: {}, providerErrors: 0 };
      const snapshot = {
        memory: {
          heapUsed: finiteNonNegative(memory.heapUsed),
          heapTotal: finiteNonNegative(memory.heapTotal),
          rss: finiteNonNegative(memory.rss),
          external: finiteNonNegative(memory.external),
          arrayBuffers: finiteNonNegative(memory.arrayBuffers),
          heapSizeLimit: finiteNonNegative(heap.heap_size_limit),
        },
        socketClients: socketClientCount(opts.io),
        capacity: registered.sources,
        capacityProviderErrors: registered.providerErrors,
      };
      opts.logger.info(snapshot, "runtime_capacity");
      return snapshot;
    } catch {
      // Sampling must be invisible to the request path, and the error object
      // itself is intentionally omitted to preserve the no-secrets contract.
      opts.logger.warn?.("runtime_capacity_sample_failed");
      return null;
    }
  }

  function start() {
    if (timer) return;
    // Capture the boot baseline immediately, then sample at a stable cadence.
    logNow();
    timer = setIntervalImpl(logNow, intervalMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  function stop() {
    if (!timer) return;
    clearIntervalImpl(timer);
    timer = null;
  }

  return {
    start,
    stop,
    logNow,
    isRunning: () => timer !== null,
  };
}

/**
 * Permit only finite numeric counters and booleans. Strings, arrays, dates,
 * and sensitive-looking field names are discarded, even when a future
 * provider accidentally returns them.
 *
 * @param {unknown} value
 * @param {number} depth
 * @returns {unknown}
 */
function sanitizeCapacityValue(value, depth) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "boolean") return value;
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || value instanceof Date
    || depth >= MAX_SNAPSHOT_DEPTH
  ) {
    return undefined;
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  let inspected = 0;
  for (const [key, nested] of Object.entries(value)) {
    if (inspected >= MAX_KEYS_PER_OBJECT) break;
    inspected += 1;
    if (!SAFE_SOURCE_NAME.test(key) || SENSITIVE_FIELD.test(key)) continue;
    const sanitized = sanitizeCapacityValue(nested, depth + 1);
    if (sanitized !== undefined) out[key] = sanitized;
  }
  return out;
}

/** @param {import('socket.io').Server | null | undefined} io */
function socketClientCount(io) {
  const engineCount = Number(io?.engine?.clientsCount);
  if (Number.isFinite(engineCount) && engineCount >= 0) return engineCount;
  const socketCount = Number(io?.sockets?.sockets?.size);
  return Number.isFinite(socketCount) && socketCount >= 0 ? socketCount : 0;
}

/** @param {unknown} value */
function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

module.exports = {
  RuntimeCapacityRegistry,
  buildRuntimeCapacityMonitor,
  RUNTIME_CAPACITY_INTERVAL_MS,
  __internal: {
    sanitizeCapacityValue,
    socketClientCount,
  },
};
