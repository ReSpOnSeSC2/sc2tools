/** Public data only. Python validates schema/version/hash before installation or
 * persistence. One small durable manifest per API origin; no replay/auth data. */
import type { EngineRuntime } from "./enginePyGlue";

const MAX_BYTES = 1024 * 1024;
const CACHE_NAME = "sc2tools-preset-policy-v1";

interface RefreshDeps {
  fetch?: typeof fetch;
  caches?: Pick<CacheStorage, "open">;
  now?: () => number;
}

async function boundedText(response: Response): Promise<string> {
  if (!response.ok || Number(response.headers.get("content-length")) > MAX_BYTES) throw new Error("policy_unavailable");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("policy_unavailable");
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_BYTES) throw new Error("policy_too_large");
      parts.push(next.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** Refresh at most once/minute; failures retain the installed/bundled policy. */
export function createPresetPolicyRefresh(apiBase: string, deps: RefreshDeps = {}): (runtime: EngineRuntime) => Promise<void> {
  const url = `${apiBase.replace(/\/$/, "")}/v1/build-policy?evaluator=1`;
  const request = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const storage = deps.caches ?? globalThis.caches;
  const now = deps.now ?? Date.now;
  let installed: EngineRuntime | null = null;
  let nextRefresh = 0;
  let pending: Promise<void> | null = null;
  return async (runtime) => {
    if (!runtime.installPolicy) return;
    if (pending) return pending;
    if (installed === runtime && now() < nextRefresh) return;
    const refresh = async () => {
      const first = installed !== runtime;
      installed = runtime;
      nextRefresh = now() + 60000;
      const cache = await storage?.open(CACHE_NAME).catch(() => null);
      if (first && cache) {
        try {
          const cached = await cache.match(url);
          if (cached) runtime.installPolicy?.(await boundedText(cached));
        } catch { /* Invalid or incompatible cache never clears the bundled state. */ }
      }
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), 2000);
      try {
        const response = await request(url, { credentials: "omit", signal: controller.signal, cache: "no-cache" });
        const raw = await boundedText(response);
        runtime.installPolicy?.(raw);
        await cache?.put(url, new Response(raw, { headers: { "Content-Type": "application/json" } })).catch(() => undefined);
      } catch { /* Offline/older API: use the last compatible installed policy. */ }
      finally { clearTimeout(deadline); }
    };
    pending = refresh();
    try { await pending; } finally { pending = null; }
  };
}
