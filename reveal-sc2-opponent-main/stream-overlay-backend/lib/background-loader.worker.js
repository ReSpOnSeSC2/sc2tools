"use strict";

// Worker-thread side of background-loader.js. Reads the file with
// readFile (async fs), parses, and posts the result back. Stays
// completely off the main thread so parsing 27 MB doesn't stall HTTP.
//
// Includes the same JSON-salvage fallback the main analyzer uses, so a
// half-written file (atomic-rename in flight) still produces a usable
// snapshot rather than a hard reject.

const fs = require("node:fs/promises");
const { parentPort, workerData } = require("node:worker_threads");

async function main() {
  /** @type {{filePath: string}} */
  const { filePath } = workerData;
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    parentPort.postMessage({ ok: false, error: `read_failed: ${err.message}` });
    return;
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  try {
    const parsed = JSON.parse(raw);
    parentPort.postMessage({ ok: true, data: parsed });
    return;
  } catch (parseErr) {
    const salvaged = salvageJsonObject(raw);
    if (salvaged) {
      parentPort.postMessage({
        ok: true,
        data: salvaged,
        warning: `salvage: ${parseErr.message}`,
      });
      return;
    }
    parentPort.postMessage({
      ok: false,
      error: `parse_failed: ${parseErr.message}`,
    });
  }
}

/**
 * Find the largest valid JSON object prefix. Mirrors the algorithm in
 * analyzer.js so a partial/truncated write recovers identically here.
 *
 * @param {string} raw
 * @returns {object|null}
 */
function salvageJsonObject(raw) {
  if (!raw || typeof raw !== "string") return null;
  // Common partial-write tail: trailing comma + close. Try increasingly
  // aggressive truncation points, all anchored to a balanced brace.
  let depth = 0;
  let inString = false;
  let escaped = false;
  let lastValidEnd = -1;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) lastValidEnd = i;
    }
  }
  if (lastValidEnd < 0) return null;
  try {
    const candidate = raw.slice(0, lastValidEnd + 1);
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (_) {
    return null;
  }
  return null;
}

main().catch((err) => {
  parentPort.postMessage({ ok: false, error: String(err && err.message) });
});
