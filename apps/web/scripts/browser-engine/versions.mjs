/**
 * Version pins for the browser engine, read from their single sources and
 * cross-checked so a build can never ship a bundle the web client does not
 * expect:
 *
 *   apps/replay-engine/VERSION           == INSTANT_ENGINE_VERSION (engineVersion.ts)
 *   package.json devDependencies.pyodide == PYODIDE_VERSION (exact pin, no ^/~)
 *   node_modules/pyodide/package.json    == PYODIDE_VERSION
 *
 * Example:
 *   const v = await readVersions();
 *   v.engineVersion; // -> "1.6.3"
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  AGENT_INIT_FILE,
  ENGINE_VERSION_FILE,
  ENGINE_VERSION_TS,
  PYODIDE_PACKAGE_DIR,
  SCHEMA_FILE,
  WEB_DIR,
} from "./config.mjs";
import { BuildError } from "./util.mjs";

const TS_STRING_CONST = (name) => new RegExp(`^export const ${name}\\s*=\\s*"([^"]+)";`, "m");
const TS_NUMBER_CONST = (name) => new RegExp(`^export const ${name}\\s*=\\s*(\\d+);`, "m");
const AGENT_VERSION_RE = /^__version__\s*=\s*"([^"]+)"/m;
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+$/;

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function matchOrThrow(text, regex, what) {
  const match = regex.exec(text);
  if (!match) throw new BuildError(`could not read ${what}`);
  return match[1];
}

async function readClientPins() {
  const source = await readFile(ENGINE_VERSION_TS, "utf8");
  return {
    engineVersion: matchOrThrow(source, TS_STRING_CONST("INSTANT_ENGINE_VERSION"), "INSTANT_ENGINE_VERSION"),
    pyodideVersion: matchOrThrow(source, TS_STRING_CONST("PYODIDE_VERSION"), "PYODIDE_VERSION"),
    protocol: Number(matchOrThrow(source, TS_NUMBER_CONST("ENGINE_PROTOCOL"), "ENGINE_PROTOCOL")),
  };
}

function assertEqual(label, expected, actual, hint) {
  if (expected !== actual) {
    throw new BuildError(`version drift: ${label} is "${actual}" but expected "${expected}". ${hint}`);
  }
}

/**
 * `properties.version.const` of the custom builds schema, read exactly like
 * `core.custom_builds._read_schema_version` (without importing Python).
 *
 * Example:
 *   await readSchemaVersion(); // -> 3
 */
export async function readSchemaVersion() {
  const schema = await readJson(SCHEMA_FILE);
  const value = schema?.properties?.version?.const;
  if (!Number.isInteger(value)) {
    throw new BuildError(`${path.basename(SCHEMA_FILE)} lacks an integer properties.version.const`);
  }
  return value;
}

/**
 * Read and cross-check every version pin; throws `BuildError` on drift.
 *
 * Example:
 *   const { engineVersion, pyodideVersion, protocol, agentVersion, lockInfo } = await readVersions();
 */
export async function readVersions() {
  const pins = await readClientPins();
  const engineFile = (await readFile(ENGINE_VERSION_FILE, "utf8")).trim();
  assertEqual("apps/replay-engine/VERSION", pins.engineVersion, engineFile,
    "Update INSTANT_ENGINE_VERSION in apps/web/lib/instant/engineVersion.ts with the engine release.");
  const webPackage = await readJson(path.join(WEB_DIR, "package.json"));
  const declared = webPackage.devDependencies?.pyodide ?? webPackage.dependencies?.pyodide ?? "";
  if (!EXACT_VERSION_RE.test(declared)) {
    throw new BuildError(`apps/web/package.json must pin pyodide exactly (got "${declared}")`);
  }
  assertEqual("package.json pyodide", pins.pyodideVersion, declared,
    "Keep PYODIDE_VERSION in engineVersion.ts equal to the package.json pin.");
  const installed = await readJson(path.join(PYODIDE_PACKAGE_DIR, "package.json"));
  assertEqual("node_modules/pyodide", pins.pyodideVersion, installed.version, "Run npm ci in apps/web.");
  const lock = await readJson(path.join(PYODIDE_PACKAGE_DIR, "pyodide-lock.json"));
  const agentVersion = matchOrThrow(await readFile(AGENT_INIT_FILE, "utf8"), AGENT_VERSION_RE, "agent __version__");
  return { ...pins, agentVersion, lockInfo: lock.info, schemaVersion: await readSchemaVersion() };
}
