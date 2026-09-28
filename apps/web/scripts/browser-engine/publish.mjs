/**
 * Write the generated browser-engine assets under `apps/web/public/`:
 *
 *   public/pyodide/<pyodideVersion>/{pyodide.mjs, pyodide.asm.mjs, pyodide.asm.wasm, python_stdlib.zip}
 *   public/engine/<engineVersion>/<bundleId>/{engine.zip, manifest.json}
 *   public/engine/current.json   (EnginePointer, written last = the commit point)
 *
 * The bundle id is content-addressed: a digest of the whole manifest (which
 * holds the SHA-256 of engine.zip and of every Pyodide file) with the id
 * fields left blank. Any change to the bundle OR to the manifest itself
 * (pins, lock info, Python entry point) yields a new id, so every path except
 * current.json can be cached forever without ever serving a stale manifest.
 *
 * Example:
 *   const { bundleId, manifest } = await publishBundle({ versions, zip, wheels, pythonVersion });
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  BUNDLE_ID_HEX_CHARS,
  BUNDLE_MODULE,
  BUNDLE_SYS_PATH,
  ENGINE_BUNDLE_FILE,
  MANIFEST_FILE,
  POINTER_FILE,
  PYODIDE_ASSETS,
  PYODIDE_PACKAGE_DIR,
  publicEngineDir,
  publicPyodideDir,
} from "./config.mjs";
import { sha256Hex } from "./util.mjs";

/** Placeholder for the id-derived fields while the id is being computed. */
const PENDING_ID = "";

/**
 * Content-addressed bundle id of a manifest whose `bundleId` and engine
 * bundle `path` are still `PENDING_ID` (key order is fixed by
 * `buildManifest`, so the JSON is canonical).
 *
 * Example:
 *   bundleIdFor(manifestFor(PENDING_ID)); // -> "3f9c0a1b2c3d4e5f"
 */
export function bundleIdFor(pendingManifest) {
  return sha256Hex(Buffer.from(JSON.stringify(pendingManifest), "utf8")).slice(0, BUNDLE_ID_HEX_CHARS);
}

function engineBundleAsset(engineVersion, bundleId, zip, sha256) {
  const assetPath = bundleId === PENDING_ID ? PENDING_ID : `/engine/${engineVersion}/${bundleId}/${ENGINE_BUNDLE_FILE}`;
  return { role: "engine-bundle", path: assetPath, sha256, bytes: zip.length };
}

async function writeAtomic(file, data) {
  const staging = `${file}.tmp-${process.pid}`;
  await writeFile(staging, data);
  await rename(staging, file);
}

async function writeIfChanged(file, data, sha256) {
  if (existsSync(file) && sha256Hex(await readFile(file)) === sha256) return;
  await writeAtomic(file, data);
}

async function removeExcept(dir, keep) {
  if (!existsSync(dir)) return [];
  const stale = (await readdir(dir)).filter((name) => !keep.has(name));
  await Promise.all(stale.map((name) => rm(path.join(dir, name), { recursive: true, force: true })));
  return stale;
}

async function copyPyodideRuntime(pyodideVersion) {
  const target = publicPyodideDir(pyodideVersion);
  await mkdir(target, { recursive: true });
  const assets = [];
  for (const { role, file } of PYODIDE_ASSETS) {
    const data = await readFile(path.join(PYODIDE_PACKAGE_DIR, file));
    const sha256 = sha256Hex(data);
    await writeIfChanged(path.join(target, file), data, sha256);
    assets.push({ role, path: `/pyodide/${pyodideVersion}/${file}`, sha256, bytes: data.length });
  }
  await removeExcept(target, new Set(PYODIDE_ASSETS.map((asset) => asset.file)));
  return assets;
}

function buildManifest({ versions, bundleId, assets, wheels, pythonVersion }) {
  return {
    protocol: versions.protocol,
    engineVersion: versions.engineVersion,
    pyodideVersion: versions.pyodideVersion,
    pythonVersion,
    bundleId,
    lockInfo: versions.lockInfo,
    assets,
    python: { sysPath: [...BUNDLE_SYS_PATH], module: BUNDLE_MODULE },
    builtFrom: {
      agentVersion: versions.agentVersion,
      wheels: wheels.map(({ file, sha256 }) => ({ file, sha256 })),
    },
  };
}

function toJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Write every asset, the manifest and (last) the pointer; prune stale
 * bundles of the same engine version.
 *
 * Example:
 *   await publishBundle({ versions, zip, wheels, pythonVersion: "3.14.2" });
 */
export async function publishBundle({ versions, zip, wheels, pythonVersion }) {
  const { engineVersion, pyodideVersion } = versions;
  const pyodideAssets = await copyPyodideRuntime(pyodideVersion);
  const zipSha = sha256Hex(zip);
  const manifestFor = (bundleId) => buildManifest({
    versions, bundleId, wheels, pythonVersion,
    assets: [...pyodideAssets, engineBundleAsset(engineVersion, bundleId, zip, zipSha)],
  });
  const bundleId = bundleIdFor(manifestFor(PENDING_ID));
  const manifest = manifestFor(bundleId);
  const bundleDir = path.join(publicEngineDir(engineVersion), bundleId);
  await mkdir(bundleDir, { recursive: true });
  await writeIfChanged(path.join(bundleDir, ENGINE_BUNDLE_FILE), zip, zipSha);
  await writeAtomic(path.join(bundleDir, MANIFEST_FILE), toJson(manifest));
  const pointer = {
    protocol: versions.protocol,
    engineVersion,
    manifest: `/engine/${engineVersion}/${bundleId}/${MANIFEST_FILE}`,
  };
  await writeAtomic(POINTER_FILE, toJson(pointer));
  const pruned = await removeExcept(publicEngineDir(engineVersion), new Set([bundleId]));
  return { bundleId, manifest, pointer, pruned };
}
