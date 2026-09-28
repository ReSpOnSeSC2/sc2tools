import { Blob as NodeBlob } from "node:buffer";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  activationCode,
  bootEngine,
  describeBootError,
  fetchAllVerified,
  installWasmFetchShim,
  loadManifest,
  loadPointer,
  withImportScriptsHidden,
  type FetchScope,
} from "../engineBoot";
import { EngineError } from "../engineErrors";
import {
  ENGINE_ASSET_ROLES,
  checkManifest,
  checkPointer,
  isEngineManifest,
  isEnginePointer,
  pyodideIndexUrl,
} from "../engineManifest";
import { ENGINE_PROTOCOL, INSTANT_ENGINE_VERSION, PYODIDE_VERSION } from "../engineVersion";
import type { PyodideBootConfig, PyodideLike } from "../enginePyodide";
import { AssetFetchError, IntegrityError, sha256Hex, type FetchLike } from "../integrity";
import type { EngineAssetRole, EngineManifest, EnginePointer } from "../types";

const ORIGIN = "https://sc2tools.test";
const POINTER_URL = `${ORIGIN}/engine/current.json`;
const BUNDLE_ID = "0123456789abcdef";
const MANIFEST_PATH = `/engine/${INSTANT_ENGINE_VERSION}/${BUNDLE_ID}/manifest.json`;
const HTTP_NOT_FOUND = 404;

const ASSET_PATHS: Record<EngineAssetRole, string> = {
  "pyodide-loader": `/pyodide/${PYODIDE_VERSION}/pyodide.mjs`,
  "pyodide-asm": `/pyodide/${PYODIDE_VERSION}/pyodide.asm.mjs`,
  "pyodide-wasm": `/pyodide/${PYODIDE_VERSION}/pyodide.asm.wasm`,
  "python-stdlib": `/pyodide/${PYODIDE_VERSION}/python_stdlib.zip`,
  "engine-bundle": `/engine/${INSTANT_ENGINE_VERSION}/${BUNDLE_ID}/engine.zip`,
};

const bodyFor = (role: EngineAssetRole): Uint8Array => new TextEncoder().encode(`bytes of ${role}`);

function pointer(overrides: Partial<EnginePointer> = {}): EnginePointer {
  return { protocol: ENGINE_PROTOCOL, engineVersion: INSTANT_ENGINE_VERSION, manifest: MANIFEST_PATH, ...overrides };
}

async function manifest(overrides: Partial<EngineManifest> = {}): Promise<EngineManifest> {
  const assets = await Promise.all(
    ENGINE_ASSET_ROLES.map(async (role) => ({ role, path: ASSET_PATHS[role], sha256: await sha256Hex(bodyFor(role)), bytes: bodyFor(role).length })),
  );
  return {
    protocol: ENGINE_PROTOCOL,
    engineVersion: INSTANT_ENGINE_VERSION,
    pyodideVersion: PYODIDE_VERSION,
    pythonVersion: "3.14.2",
    bundleId: BUNDLE_ID,
    lockInfo: { python: "3.14.2", abi_version: "2026_0" },
    assets,
    python: { sysPath: ["/sc2tools/apps/agent"], module: "sc2tools_agent.instant_analysis" },
    builtFrom: { agentVersion: "0.17.2", wheels: [{ file: "mpyq-0.2.5-py3-none-any.whl", sha256: "a".repeat(64) }] },
    ...overrides,
  };
}

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (caught) {
    return caught;
  }
  return null;
}

/** Serves JSON / bytes by absolute URL; records the init of every call. */
function fakeFetch(routes: Record<string, unknown>): FetchLike & { inits: Array<RequestInit | undefined> } {
  const inits: Array<RequestInit | undefined> = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    inits.push(init);
    if (!(url in routes)) return new Response("", { status: HTTP_NOT_FOUND });
    const body = routes[url];
    // ArrayBuffer.isView: jsdom and Node each have their own Uint8Array realm.
    return ArrayBuffer.isView(body) ? new Response(body) : new Response(JSON.stringify(body));
  });
  return Object.assign(impl, { inits });
}

function assetRoutes(): Record<string, Uint8Array> {
  const routes: Record<string, Uint8Array> = {};
  for (const role of ENGINE_ASSET_ROLES) routes[`${ORIGIN}${ASSET_PATHS[role]}`] = bodyFor(role);
  return routes;
}

describe("pointer validation", () => {
  it("accepts a well-formed pointer for this engine version", () => {
    expect(isEnginePointer(pointer())).toBe(true);
    expect(checkPointer(pointer())).toEqual(pointer());
  });

  it("rejects malformed pointers as engine_unavailable", () => {
    for (const bad of [null, [], {}, pointer({ manifest: "//evil.test/m.json" }), { ...pointer(), protocol: "1" }]) {
      expect(isEnginePointer(bad)).toBe(false);
      expect(() => checkPointer(bad)).toThrow(EngineError);
    }
  });

  it("reports a version or protocol mismatch as 'engine updated'", () => {
    for (const stale of [pointer({ engineVersion: "0.0.1" }), pointer({ protocol: ENGINE_PROTOCOL + 1 })]) {
      const error = thrownBy(() => checkPointer(stale));
      expect(error).toBeInstanceOf(EngineError);
      if (error instanceof EngineError) {
        expect(error.kind).toBe("engine_unavailable");
        expect(error.detail).toMatch(/engine updated/);
      }
    }
  });
});

describe("manifest validation", () => {
  it("accepts a built manifest", async () => {
    const valid = await manifest();
    expect(isEngineManifest(valid)).toBe(true);
    expect(checkManifest(valid)).toBe(valid);
  });

  it("requires every asset role exactly once", async () => {
    const valid = await manifest();
    expect(isEngineManifest({ ...valid, assets: valid.assets.slice(1) })).toBe(false);
    expect(isEngineManifest({ ...valid, assets: [...valid.assets, valid.assets[0]] })).toBe(false);
  });

  it("rejects bad digests, cross-origin paths and unsafe module names", async () => {
    const valid = await manifest();
    const badSha = valid.assets.map((asset, i) => (i === 0 ? { ...asset, sha256: "xyz" } : asset));
    const crossOrigin = valid.assets.map((asset, i) => (i === 0 ? { ...asset, path: "https://cdn.test/p.mjs" } : asset));
    expect(isEngineManifest({ ...valid, assets: badSha })).toBe(false);
    expect(isEngineManifest({ ...valid, assets: crossOrigin })).toBe(false);
    expect(isEngineManifest({ ...valid, python: { sysPath: ["/x"], module: "os; import evil" } })).toBe(false);
    expect(isEngineManifest({ ...valid, bundleId: "short" })).toBe(false);
  });

  it("refuses a manifest from another engine or Pyodide release", async () => {
    const stale = await manifest({ engineVersion: "0.0.1" });
    expect(() => checkManifest(stale)).toThrow(/engine updated/);
    const other = await manifest({ pyodideVersion: "0.29.5" });
    expect(() => checkManifest(other)).toThrow(EngineError);
  });

  it("derives the Pyodide indexURL from the wasm asset", async () => {
    expect(pyodideIndexUrl(await manifest(), POINTER_URL)).toBe(`${ORIGIN}/pyodide/${PYODIDE_VERSION}/`);
  });
});

describe("loadPointer / loadManifest", () => {
  it("revalidates the pointer (cache: no-cache) and validates it", async () => {
    const fetchImpl = fakeFetch({ [POINTER_URL]: pointer() });
    await expect(loadPointer(POINTER_URL, fetchImpl)).resolves.toEqual(pointer());
    expect(fetchImpl.inits[0]).toEqual({ cache: "no-cache" });
  });

  it("maps HTTP failures to AssetFetchError and bad JSON to engine_unavailable", async () => {
    await expect(loadPointer(POINTER_URL, fakeFetch({}))).rejects.toBeInstanceOf(AssetFetchError);
    const garbage: FetchLike = vi.fn(async () => new Response("<html>"));
    await expect(loadPointer(POINTER_URL, garbage)).rejects.toMatchObject({ kind: "engine_unavailable" });
  });

  it("loads and validates a manifest", async () => {
    const valid = await manifest();
    const url = `${ORIGIN}${MANIFEST_PATH}`;
    await expect(loadManifest(url, fakeFetch({ [url]: valid }))).resolves.toEqual(valid);
    await expect(loadManifest(url, fakeFetch({ [url]: { nope: true } }))).rejects.toBeInstanceOf(EngineError);
  });
});

describe("fetchAllVerified", () => {
  it("returns every asset's verified bytes by role", async () => {
    const assets = await fetchAllVerified(await manifest(), POINTER_URL, fakeFetch(assetRoutes()));
    expect(new TextDecoder().decode(assets["engine-bundle"])).toBe("bytes of engine-bundle");
    expect(Object.keys(assets).sort()).toEqual(Object.keys(ASSET_PATHS).sort());
  });

  it("fails the boot with integrity_failed when one asset is tampered with", async () => {
    const routes = assetRoutes();
    routes[`${ORIGIN}${ASSET_PATHS["pyodide-wasm"]}`] = new TextEncoder().encode("evil wasm");
    const error = await fetchAllVerified(await manifest(), POINTER_URL, fakeFetch(routes)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntegrityError);
    expect(describeBootError(error).errorKind).toBe("integrity_failed");
  });
});

describe("installWasmFetchShim", () => {
  const wasmUrl = `${ORIGIN}/pyodide/${PYODIDE_VERSION}/pyodide.asm.wasm`;

  it("serves the verified bytes for exactly the wasm URL and restores fetch", async () => {
    const original = vi.fn(async () => new Response("network"));
    const scope: FetchScope = { fetch: original };
    const restore = installWasmFetchShim(scope, wasmUrl, new Uint8Array([0, 97, 115, 109]).buffer);
    const wasm = await scope.fetch(new URL(wasmUrl));
    expect(wasm.headers.get("Content-Type")).toBe("application/wasm");
    expect(new Uint8Array(await wasm.arrayBuffer())).toEqual(new Uint8Array([0, 97, 115, 109]));
    expect(await (await scope.fetch(`blob:${ORIGIN}/stdlib`)).text()).toBe("network");
    expect(original).toHaveBeenCalledTimes(1);
    restore();
    expect(scope.fetch).toBe(original);
  });

  it("fails closed: refuses every other network request while installed", async () => {
    const original = vi.fn(async () => new Response("network"));
    const scope: FetchScope = { fetch: original };
    installWasmFetchShim(scope, wasmUrl, new ArrayBuffer(1));
    for (const url of [`${ORIGIN}/pyodide/${PYODIDE_VERSION}/pyodide-lock.json`, `${wasmUrl}?v=2`, "https://cdn.test/pyodide.asm.wasm"]) {
      await expect(scope.fetch(url)).rejects.toThrow(TypeError);
    }
    expect(original).not.toHaveBeenCalled();
  });
});

describe("withImportScriptsHidden", () => {
  it("hides importScripts (Pyodide's classic-worker probe) only while booting", async () => {
    const probe = vi.fn();
    const scope: { importScripts?: unknown } = { importScripts: probe };
    const seen = await withImportScriptsHidden(scope, async () => typeof scope.importScripts);
    expect(seen).toBe("undefined");
    expect(scope.importScripts).toBe(probe);
  });

  it("restores an inherited importScripts by removing the shadowing property, even on failure", async () => {
    const proto = { importScripts: vi.fn() };
    const scope: { importScripts?: unknown } = Object.create(proto);
    await expect(withImportScriptsHidden(scope, async () => {
      throw new Error("boot failed");
    })).rejects.toThrow("boot failed");
    expect(Object.prototype.hasOwnProperty.call(scope, "importScripts")).toBe(false);
    expect(scope.importScripts).toBe(proto.importScripts);
  });

  it("is a no-op in scopes without importScripts", async () => {
    const scope = {};
    await expect(withImportScriptsHidden(scope, async () => 7)).resolves.toBe(7);
    expect("importScripts" in scope).toBe(false);
  });
});

describe("activationCode", () => {
  it("prepends sys.path, silences sc2reader and imports the module", async () => {
    const code = activationCode(await manifest());
    expect(code).toContain('json.loads("[\\"/sc2tools/apps/agent\\"]")');
    expect(code).toContain('logging.getLogger("sc2reader").setLevel(logging.CRITICAL)');
    expect(code).toContain('importlib.import_module("sc2tools_agent.instant_analysis")');
  });
});

describe("describeBootError", () => {
  it("classifies boot failures", () => {
    expect(describeBootError(new AssetFetchError("/x", HTTP_NOT_FOUND)).errorKind).toBe("engine_unavailable");
    expect(describeBootError(new EngineError("engine_unavailable", "engine updated")).detail).toBe("engine updated");
    expect(describeBootError(new RangeError("WebAssembly.Memory(): could not allocate memory")).errorKind).toBe("out_of_memory");
    const other = describeBootError(new TypeError("C:\\Users\\someone\\secret"));
    expect(other.errorKind).toBe("engine_boot_failed");
    expect(other.detail).not.toContain("someone");
  });
});

/*
 * Boot orchestration with REAL digest checks and real (Node) Blobs; only the
 * Pyodide runtime itself is faked. Proves the order "verify, then execute":
 * modules are imported from blob: URLs holding exactly the verified bytes,
 * the wasm comes from the shim, and a tampered asset stops the boot before
 * anything is imported.
 */
const WASM_URL = `${ORIGIN}${ASSET_PATHS["pyodide-wasm"]}`;
const BOOT_STARTED_MS = 1_000;
const BOOT_FINISHED_MS = 3_400;
const objectUrls = new Map<string, NodeBlob>();
const revoked: string[] = [];

/** Registers the Blob / importScripts / object-URL stubs for the enclosing describe. */
function useBootGlobals(): void {
  beforeEach(() => {
    objectUrls.clear();
    revoked.length = 0;
    // jsdom has neither URL.createObjectURL nor Blob#text; Node's Blob has both.
    vi.stubGlobal("Blob", NodeBlob);
    vi.stubGlobal("importScripts", vi.fn());
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: (blob: NodeBlob) => {
        const url = `blob:${ORIGIN}/${objectUrls.size + 1}`;
        objectUrls.set(url, blob);
        return url;
      },
    });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: (url: string) => revoked.push(url) });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(URL, "createObjectURL");
    Reflect.deleteProperty(URL, "revokeObjectURL");
  });
}

async function objectUrlText(url: string | undefined): Promise<string> {
  const blob = url === undefined ? undefined : objectUrls.get(url);
  if (!blob) throw new Error(`no object URL ${String(url)}`);
  return blob.text();
}

const importScriptsHidden = (): boolean => typeof Reflect.get(globalThis, "importScripts") !== "function";

/** Fake Pyodide runtime that records what the boot hands it. */
function fakeRuntime(scope: FetchScope) {
  const seen = { imports: [] as Array<{ url: string; text: string; hidden: boolean }>, wasm: "", stdlib: "", lockBlocked: false, hiddenInLoad: false, config: null as PyodideBootConfig | null, unpacked: "", extractDir: "", code: [] as string[] };
  const createPyodideModule = vi.fn();
  const pyodide: PyodideLike = {
    version: PYODIDE_VERSION,
    runPython: (code) => seen.code.push(code),
    unpackArchive: (buffer, format, options) => {
      seen.unpacked = `${format}:${new TextDecoder().decode(buffer)}`;
      seen.extractDir = options?.extractDir ?? "";
    },
    globals: { get: () => undefined },
    _module: { HEAP8: { length: 0 } },
  };
  const loadPyodide = vi.fn(async (config: PyodideBootConfig) => {
    seen.config = config;
    seen.hiddenInLoad = importScriptsHidden();
    seen.wasm = await (await scope.fetch(new URL(WASM_URL))).text();
    seen.stdlib = await objectUrlText(config.stdLibURL);
    seen.lockBlocked = await scope.fetch(`${ORIGIN}/pyodide/${PYODIDE_VERSION}/pyodide-lock.json`).then(() => false, () => true);
    return pyodide;
  });
  const importModule = vi.fn(async (url: string) => {
    const text = await objectUrlText(url);
    seen.imports.push({ url, text, hidden: importScriptsHidden() });
    return text === "bytes of pyodide-loader" ? { loadPyodide } : { default: createPyodideModule };
  });
  return { seen, importModule, loadPyodide, createPyodideModule };
}

async function bootRoutes(tampered?: EngineAssetRole) {
  const valid = await manifest();
  const all: Record<string, unknown> = { [POINTER_URL]: pointer(), [`${ORIGIN}${MANIFEST_PATH}`]: valid, ...assetRoutes() };
  if (tampered) all[`${ORIGIN}${ASSET_PATHS[tampered]}`] = new TextEncoder().encode("tampered");
  return { valid, fetchImpl: fakeFetch(all) };
}

describe("bootEngine", () => {
  useBootGlobals();

  it("imports only verified bytes and serves the verified wasm, stdlib and lock info", async () => {
    const { valid, fetchImpl } = await bootRoutes();
    const network = vi.fn(async () => new Response("network"));
    const scope: FetchScope = { fetch: network };
    const runtime = fakeRuntime(scope);
    const clock = [BOOT_STARTED_MS, BOOT_FINISHED_MS];
    const booted = await bootEngine(POINTER_URL, { fetchImpl, scope, importModule: runtime.importModule, now: () => clock.shift() ?? 0 });

    const { seen } = runtime;
    expect(seen.imports.map((entry) => entry.text)).toEqual(["bytes of pyodide-loader", "bytes of pyodide-asm"]);
    expect(seen.imports.every((entry) => entry.url.startsWith("blob:") && entry.hidden)).toBe(true);
    expect(seen.hiddenInLoad).toBe(true);
    expect(seen.wasm).toBe("bytes of pyodide-wasm");
    expect(seen.stdlib).toBe("bytes of python-stdlib");
    expect(seen.lockBlocked).toBe(true);
    expect(network).not.toHaveBeenCalled();
    expect(seen.config).toMatchObject({
      indexURL: `${ORIGIN}/pyodide/${PYODIDE_VERSION}/`,
      lockFileContents: { info: valid.lockInfo, packages: {} },
      createPyodideModule: runtime.createPyodideModule,
    });
    expect(seen.unpacked).toBe("zip:bytes of engine-bundle");
    expect(seen.extractDir).toBe("/");
    expect(seen.code).toEqual([activationCode(valid)]);
    expect(booted.info).toEqual({
      engineVersion: INSTANT_ENGINE_VERSION, pyodideVersion: PYODIDE_VERSION, pythonVersion: valid.pythonVersion,
      bundleId: BUNDLE_ID, bootMs: BOOT_FINISHED_MS - BOOT_STARTED_MS,
    });
    // Platform state is restored and every object URL released.
    expect(scope.fetch).toBe(network);
    expect(importScriptsHidden()).toBe(false);
    expect([...revoked].sort()).toEqual([...objectUrls.keys()].sort());
  });
});

describe("bootEngine failures", () => {
  useBootGlobals();

  it.each<EngineAssetRole>(["pyodide-loader", "pyodide-asm", "pyodide-wasm", "python-stdlib", "engine-bundle"])(
    "stops before executing anything when %s is tampered with",
    async (role) => {
      const { fetchImpl } = await bootRoutes(role);
      const scope: FetchScope = { fetch: vi.fn() };
      const runtime = fakeRuntime(scope);
      const error = await bootEngine(POINTER_URL, { fetchImpl, scope, importModule: runtime.importModule }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(IntegrityError);
      expect(runtime.importModule).not.toHaveBeenCalled();
      expect(runtime.loadPyodide).not.toHaveBeenCalled();
      expect(objectUrls.size).toBe(0);
    },
  );

  it("restores fetch and importScripts and revokes object URLs when Pyodide fails to start", async () => {
    const { fetchImpl } = await bootRoutes();
    const network = vi.fn(async () => new Response("network"));
    const scope: FetchScope = { fetch: network };
    const runtime = fakeRuntime(scope);
    runtime.loadPyodide.mockRejectedValueOnce(new RangeError("WebAssembly.Memory(): could not allocate memory"));
    const error = await bootEngine(POINTER_URL, { fetchImpl, scope, importModule: runtime.importModule }).catch((e: unknown) => e);
    expect(describeBootError(error).errorKind).toBe("out_of_memory");
    expect(scope.fetch).toBe(network);
    expect(importScriptsHidden()).toBe(false);
    expect(objectUrls.size).toBeGreaterThan(0);
    expect([...revoked].sort()).toEqual([...objectUrls.keys()].sort());
  });
});
