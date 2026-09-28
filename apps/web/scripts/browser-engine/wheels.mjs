/**
 * Hash-pinned Python wheels for the browser engine (sc2reader + mpyq).
 *
 * A private venv under `node_modules/.cache/sc2tools-browser-engine/venv`
 * gets pinned pip + setuptools (build-requirements.txt), then
 * `pip wheel --no-deps --require-hashes` builds/downloads the wheels listed
 * in requirements.txt. mpyq only ships an sdist, so it is built with the
 * venv's pinned setuptools (`--no-build-isolation`) and a fixed
 * SOURCE_DATE_EPOCH, which makes the wheel byte-for-byte reproducible. The
 * wheel set is cached per requirements hash so re-runs skip pip entirely.
 *
 * Example:
 *   const python = await findPython();
 *   const wheels = await ensureWheels(python);
 *   wheels.map((w) => w.file); // -> ["mpyq-0.2.5-py3-none-any.whl", "sc2reader-1.8.0-py3-none-any.whl"]
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  BUILD_REQUIREMENTS_FILE,
  CACHE_DIR,
  REQUIREMENTS_FILE,
  SOURCE_DATE_EPOCH,
} from "./config.mjs";
import { BuildError, logStep, run, sha256Hex } from "./util.mjs";

const MIN_PYTHON = [3, 10];
const VENV_DIR = path.join(CACHE_DIR, "venv");
const VENV_MARKER = path.join(VENV_DIR, ".sc2tools-ready");
const WHEELS_DIR = path.join(CACHE_DIR, "wheels");
const WHEELS_COMPLETE = ".complete";
const CACHE_KEY_HEX_CHARS = 16;
const PURE_WHEEL_SUFFIX = "-py3-none-any.whl";
const EXPECTED_WHEEL_PREFIXES = ["mpyq-0.2.5-", "sc2reader-1.8.0-"];
const PROBE = "import sys, venv, ensurepip; print('%d.%d' % sys.version_info[:2])";

function pipEnv() {
  return {
    ...process.env,
    PYTHONDONTWRITEBYTECODE: "1",
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    PIP_NO_INPUT: "1",
    SOURCE_DATE_EPOCH,
  };
}

function venvPython() {
  return process.platform === "win32"
    ? path.join(VENV_DIR, "Scripts", "python.exe")
    : path.join(VENV_DIR, "bin", "python");
}

function isSupported(version) {
  const [major, minor] = version.split(".").map(Number);
  return major > MIN_PYTHON[0] || (major === MIN_PYTHON[0] && minor >= MIN_PYTHON[1]);
}

/**
 * First usable CPython (>= 3.10 with venv + ensurepip): `$PYTHON`, then
 * `python3`, then `python`. Resolves null when none is usable.
 *
 * Example:
 *   await findPython(); // -> { command: "python3", version: "3.12" } | null
 */
export async function findPython() {
  const candidates = [process.env.PYTHON, "python3", "python"].filter(Boolean);
  for (const command of candidates) {
    try {
      const version = (await run(command, ["-c", PROBE])).trim();
      if (isSupported(version)) return { command, version };
    } catch {
      // Not installed or lacks venv/ensurepip (Debian: python3-venv); try the next one.
    }
  }
  return null;
}

async function requirementsKey() {
  const [build, runtime] = await Promise.all([
    readFile(BUILD_REQUIREMENTS_FILE), readFile(REQUIREMENTS_FILE),
  ]);
  return sha256Hex(build, Buffer.from([0]), runtime).slice(0, CACHE_KEY_HEX_CHARS);
}

async function ensureVenv(python) {
  const buildKey = sha256Hex(await readFile(BUILD_REQUIREMENTS_FILE)).slice(0, CACHE_KEY_HEX_CHARS);
  const marker = `${buildKey} ${python.version}\n`;
  if (existsSync(VENV_MARKER) && (await readFile(VENV_MARKER, "utf8")) === marker) return venvPython();
  logStep(`creating build venv (${python.command} ${python.version})`);
  await rm(VENV_DIR, { recursive: true, force: true });
  await mkdir(CACHE_DIR, { recursive: true });
  await run(python.command, ["-m", "venv", VENV_DIR], { env: pipEnv() });
  await run(venvPython(), [
    "-m", "pip", "install", "--quiet", "--require-hashes", "--no-cache-dir", "-r", BUILD_REQUIREMENTS_FILE,
  ], { env: pipEnv(), cwd: CACHE_DIR });
  await writeFile(VENV_MARKER, marker);
  return venvPython();
}

async function listWheels(dir) {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".whl")).sort();
  const unexpected = names.filter((name) => !name.endsWith(PURE_WHEEL_SUFFIX));
  const missing = EXPECTED_WHEEL_PREFIXES.filter((prefix) => !names.some((name) => name.startsWith(prefix)));
  if (unexpected.length || missing.length || names.length !== EXPECTED_WHEEL_PREFIXES.length) {
    throw new BuildError(`unexpected wheel set in ${dir}: ${names.join(", ") || "(none)"}`);
  }
  return Promise.all(names.map(async (file) => {
    const data = await readFile(path.join(dir, file));
    return { file, data, sha256: sha256Hex(data) };
  }));
}

async function buildWheelsInto(pythonInVenv, target) {
  const staging = `${target}.tmp-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await run(pythonInVenv, [
    "-m", "pip", "wheel", "--quiet", "--no-deps", "--require-hashes", "--no-build-isolation",
    "--no-cache-dir", "-r", REQUIREMENTS_FILE, "-w", staging,
  ], { env: pipEnv(), cwd: CACHE_DIR });
  await listWheels(staging);
  await writeFile(path.join(staging, WHEELS_COMPLETE), "");
  await rm(target, { recursive: true, force: true });
  await rename(staging, target);
}

/**
 * Wheels for requirements.txt, from cache or freshly built.
 *
 * Example:
 *   const [mpyq, sc2reader] = await ensureWheels(await findPython());
 *   sc2reader.sha256; // hex digest recorded in the manifest
 */
export async function ensureWheels(python) {
  const key = await requirementsKey();
  const target = path.join(WHEELS_DIR, key);
  if (!existsSync(path.join(target, WHEELS_COMPLETE))) {
    const pythonInVenv = await ensureVenv(python);
    logStep("building hash-pinned wheels (pip wheel --require-hashes)");
    await buildWheelsInto(pythonInVenv, target);
  } else {
    logStep(`wheels cached (${key})`);
  }
  return listWheels(target);
}
