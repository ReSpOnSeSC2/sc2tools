/**
 * Small helpers for the browser-engine build: hashing, byte views,
 * subprocesses and log formatting. No build policy lives here.
 *
 * Example:
 *   sha256Hex(Buffer.from("abc"));
 *   // -> "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const BYTES_PER_KIB = 1024;
const BYTES_PER_MIB = BYTES_PER_KIB * BYTES_PER_KIB;
const MS_PER_SECOND = 1000;
const LOG_PREFIX = "[engine]";
/** Lines of a failed command's stderr kept in the BuildError message. */
const STDERR_TAIL_LINES = 15;

/** A build failure with an actionable message (printed without a stack). */
export class BuildError extends Error {
  /**
   * Example:
   *   throw new BuildError("python3 not found; install Python 3.10+");
   */
  constructor(message) {
    super(message);
    this.name = "BuildError";
  }
}

/**
 * Lower-case hex SHA-256 of one or more byte chunks.
 *
 * Example:
 *   sha256Hex(Buffer.from("a"), Buffer.from([0])); // hash of "a\0"
 */
export function sha256Hex(...chunks) {
  const hash = createHash("sha256");
  for (const chunk of chunks) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Plain `Uint8Array` view of a Node `Buffer` (Pyodide rejects `Buffer`).
 *
 * Example:
 *   py.unpackArchive(u8(readFileSync(zip)), "zip", { extractDir: "/" });
 */
export function u8(buffer) {
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

/**
 * Human-readable size, e.g. `9.15 MiB` or `412.3 KiB`.
 *
 * Example:
 *   formatBytes(2048); // -> "2.0 KiB"
 */
export function formatBytes(bytes) {
  if (bytes >= BYTES_PER_MIB) return `${(bytes / BYTES_PER_MIB).toFixed(2)} MiB`;
  return `${(bytes / BYTES_PER_KIB).toFixed(1)} KiB`;
}

/**
 * Seconds with one decimal, e.g. `3.4 s`.
 *
 * Example:
 *   formatMs(3400); // -> "3.4 s"
 */
export function formatMs(ms) {
  return `${(ms / MS_PER_SECOND).toFixed(1)} s`;
}

/**
 * Prefixed build log line on stdout.
 *
 * Example:
 *   logStep("wheels ready"); // [engine] wheels ready
 */
export function logStep(message) {
  console.log(`${LOG_PREFIX} ${message}`);
}

/**
 * Prefixed warning on stderr.
 *
 * Example:
 *   logWarn("python3 not found; skipping");
 */
export function logWarn(message) {
  console.warn(`${LOG_PREFIX} WARNING: ${message}`);
}

/**
 * Run a command; resolve with its captured stdout, reject with a
 * `BuildError` carrying the tail of stderr when it exits non-zero.
 *
 * Example:
 *   await run("python3", ["--version"]);
 */
export function run(command, args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", (error) => reject(new BuildError(`${command} could not start: ${error.message}`)));
    child.on("close", (code) => {
      if (code === 0) return resolve(Buffer.concat(out).toString("utf8"));
      const tail = Buffer.concat(err).toString("utf8").trim().split("\n").slice(-STDERR_TAIL_LINES).join("\n");
      return reject(new BuildError(`${command} ${args.join(" ")} exited with ${code}\n${tail}`));
    });
  });
}
