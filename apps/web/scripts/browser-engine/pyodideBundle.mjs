/**
 * Assemble and smoke-test engine.zip inside Pyodide (running in Node).
 *
 * 1. A build interpreter unpacks the wheels into site-packages, writes the
 *    allowlisted repo files under /sc2tools, writes the EMPTY custom builds
 *    cache the installed agent ships, precompiles unchecked-hash .pyc and
 *    writes a deterministic zip (bundle_tools.py). PYTHONHASHSEED=0 keeps
 *    frozenset constants, and therefore the .pyc bytes, stable.
 * 2. A FRESH interpreter unpacks that exact zip at "/", activates it like
 *    the browser worker does and parses the fixture replay; the build fails
 *    unless the parse succeeds.
 *
 * Example:
 *   const zip = await assembleEngineZip({ wheels, files, schemaVersion: 3 });
 *   const smoke = await smokeTestEngineZip(zip);
 *   smoke.ok; // -> true
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadPyodide } from "pyodide";

import {
  BUNDLE_MODULE,
  BUNDLE_REPO_ROOT,
  BUNDLE_SYS_PATH,
  PY_BUILD_TOOLS_FILE,
  SMOKE_FIXTURE,
  SMOKE_TOON,
} from "./config.mjs";
import { GENERATED_CUSTOM_BUILDS } from "./files.mjs";
import { BuildError, u8 } from "./util.mjs";

const TOOLS_DIR = "/tmp/sc2tools-build";
const ZIP_OUT = "/tmp/engine.zip";
const SMOKE_DIR = "/tmp/sc2tools-smoke";
const STDERR_TAIL_LINES = 20;

async function bootInterpreter() {
  const stderr = [];
  const py = await loadPyodide({
    env: { PYTHONHASHSEED: "0" },
    stdout: () => {},
    stderr: (line) => stderr.push(line),
  });
  return { py, stderr };
}

async function loadTools(py) {
  py.FS.mkdirTree(TOOLS_DIR);
  py.FS.writeFile(`${TOOLS_DIR}/bundle_tools.py`, u8(await readFile(PY_BUILD_TOOLS_FILE)));
  py.runPython(`import sys\nif ${JSON.stringify(TOOLS_DIR)} not in sys.path: sys.path.insert(0, ${JSON.stringify(TOOLS_DIR)})`);
  return py.pyimport("bundle_tools");
}

function writeTree(py, root, relative, data) {
  const target = `${root}/${relative}`;
  py.FS.mkdirTree(path.posix.dirname(target));
  py.FS.writeFile(target, u8(data));
}

function withStderr(error, stderr) {
  const tail = stderr.slice(-STDERR_TAIL_LINES).join("\n");
  return new BuildError(`${error.message}${tail ? `\n--- python stderr ---\n${tail}` : ""}`);
}

function stageSources(py, { wheels, files, schemaVersion }) {
  const sitePackages = py.runPython("import site; site.getsitepackages()[0]");
  const listSitePackages = () => py.runPython(`import os, json; json.dumps(sorted(os.listdir(${JSON.stringify(sitePackages)})))`);
  const before = new Set(JSON.parse(listSitePackages()));
  for (const wheel of wheels) py.unpackArchive(u8(wheel.data), "wheel", { extractDir: sitePackages });
  for (const file of files) writeTree(py, BUNDLE_REPO_ROOT, file.path, file.data);
  const emptyBuilds = `${JSON.stringify({ version: schemaVersion, builds: [] }, null, 2)}\n`;
  writeTree(py, BUNDLE_REPO_ROOT, GENERATED_CUSTOM_BUILDS, Buffer.from(emptyBuilds, "utf8"));
  return { sitePackages, before, listSitePackages };
}

/**
 * Build the deterministic engine.zip bytes (unpacks at "/").
 *
 * Example:
 *   const zip = await assembleEngineZip({ wheels, files, schemaVersion });
 */
export async function assembleEngineZip({ wheels, files, schemaVersion }) {
  const { py, stderr } = await bootInterpreter();
  try {
    const tools = await loadTools(py);
    const staged = stageSources(py, { wheels, files, schemaVersion });
    tools.compile_tree([staged.sitePackages, `${BUNDLE_REPO_ROOT}/apps`]);
    const added = JSON.parse(staged.listSitePackages()).filter((name) => !staged.before.has(name));
    const roots = [...added.map((name) => `${staged.sitePackages}/${name}`), BUNDLE_REPO_ROOT];
    const summary = JSON.parse(tools.write_deterministic_zip(ZIP_OUT, roots));
    tools.destroy();
    return { zip: Buffer.from(py.FS.readFile(ZIP_OUT)), summary };
  } catch (error) {
    throw withStderr(error, stderr);
  }
}

/**
 * Boot a fresh interpreter from the zip exactly like the browser worker and
 * parse the fixture; throws `BuildError` unless the parse succeeds.
 *
 * Example:
 *   const { pythonVersion, gameId } = await smokeTestEngineZip(zip);
 */
export async function smokeTestEngineZip(zip) {
  const { py, stderr } = await bootInterpreter();
  try {
    py.unpackArchive(u8(zip), "zip", { extractDir: "/" });
    const tools = await loadTools(py);
    tools.activate_bundle(BUNDLE_SYS_PATH, BUNDLE_MODULE);
    const replayPath = `${SMOKE_DIR}/${path.basename(SMOKE_FIXTURE)}`;
    writeTree(py, SMOKE_DIR, path.basename(SMOKE_FIXTURE), await readFile(SMOKE_FIXTURE));
    const result = JSON.parse(tools.smoke_parse(BUNDLE_MODULE, replayPath, SMOKE_TOON));
    tools.destroy();
    if (!result.ok) throw new BuildError(`smoke parse failed: errorKind=${result.errorKind}`);
    const pythonVersion = py.runPython("import sys; '%d.%d.%d' % sys.version_info[:3]");
    return { ...result, pythonVersion };
  } catch (error) {
    throw withStderr(error, stderr);
  }
}
