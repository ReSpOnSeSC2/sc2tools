/**
 * Paths and constants shared by the browser-engine build
 * (`scripts/build-browser-engine.mjs`) and its helper modules.
 *
 * Everything the build writes lives under `public/pyodide/` and
 * `public/engine/` (generated, gitignored) or under the npm cache dir
 * `node_modules/.cache/sc2tools-browser-engine/` (venv + wheel cache).
 *
 * Example:
 *   import { WEB_DIR, publicEngineDir } from "./config.mjs";
 *   publicEngineDir("1.6.3"); // -> "<repo>/apps/web/public/engine/1.6.3"
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** `apps/web`. */
export const WEB_DIR = path.resolve(HERE, "..", "..");
/** Repository root. */
export const REPO_DIR = path.resolve(WEB_DIR, "..", "..");
/** This helper directory (requirements files, Python build tools). */
export const ENGINE_SCRIPTS_DIR = HERE;

export const PUBLIC_DIR = path.join(WEB_DIR, "public");
export const PUBLIC_ENGINE_DIR = path.join(PUBLIC_DIR, "engine");
export const POINTER_FILE = path.join(PUBLIC_ENGINE_DIR, "current.json");
export const CACHE_DIR = path.join(WEB_DIR, "node_modules", ".cache", "sc2tools-browser-engine");
export const PYODIDE_PACKAGE_DIR = path.join(WEB_DIR, "node_modules", "pyodide");

export const REQUIREMENTS_FILE = path.join(HERE, "requirements.txt");
export const BUILD_REQUIREMENTS_FILE = path.join(HERE, "build-requirements.txt");
export const PY_BUILD_TOOLS_FILE = path.join(HERE, "bundle_tools.py");

export const ENGINE_VERSION_FILE = path.join(REPO_DIR, "apps", "replay-engine", "VERSION");
export const ENGINE_VERSION_TS = path.join(WEB_DIR, "lib", "instant", "engineVersion.ts");
export const AGENT_INIT_FILE = path.join(REPO_DIR, "apps", "agent", "sc2tools_agent", "__init__.py");
export const SCHEMA_FILE = path.join(REPO_DIR, "apps", "replay-engine", "data", "custom_builds.schema.json");

/** Fixture + perspective of the build-time smoke parse. */
export const SMOKE_FIXTURE = path.join(
  REPO_DIR, "apps", "replay-engine", "tests", "fixtures", "replays", "warpgate_adept_tracking.SC2Replay",
);
export const SMOKE_TOON = "1-S2-1-267727";

/** Root of the repo files inside the Pyodide filesystem (unpacks at "/"). */
export const BUNDLE_REPO_ROOT = "/sc2tools";
/** `sys.path` entry the worker adds; `replay_pipeline` adds the engine dir itself. */
export const BUNDLE_SYS_PATH = ["/sc2tools/apps/agent"];
/** Python module the worker imports. */
export const BUNDLE_MODULE = "sc2tools_agent.instant_analysis";

/** Pyodide runtime files self-hosted under `/pyodide/<version>/`, by manifest role. */
export const PYODIDE_ASSETS = [
  { role: "pyodide-loader", file: "pyodide.mjs" },
  { role: "pyodide-asm", file: "pyodide.asm.mjs" },
  { role: "pyodide-wasm", file: "pyodide.asm.wasm" },
  { role: "python-stdlib", file: "python_stdlib.zip" },
];

export const ENGINE_BUNDLE_FILE = "engine.zip";
export const MANIFEST_FILE = "manifest.json";
/** Hex chars of the manifest digest used as the bundle id (see publish.mjs). */
export const BUNDLE_ID_HEX_CHARS = 16;
/** 1980-01-01T00:00:00Z: the earliest zip timestamp; pins wheel builds. */
export const SOURCE_DATE_EPOCH = "315532800";

/**
 * `public/engine/<engineVersion>`.
 *
 * Example:
 *   publicEngineDir("1.6.3"); // -> ".../public/engine/1.6.3"
 */
export function publicEngineDir(engineVersion) {
  return path.join(PUBLIC_ENGINE_DIR, engineVersion);
}

/**
 * `public/pyodide/<pyodideVersion>`.
 *
 * Example:
 *   publicPyodideDir("314.0.7"); // -> ".../public/pyodide/314.0.7"
 */
export function publicPyodideDir(pyodideVersion) {
  return path.join(PUBLIC_DIR, "pyodide", pyodideVersion);
}
