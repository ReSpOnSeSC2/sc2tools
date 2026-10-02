/**
 * Explicit allowlist of repository files shipped in the browser engine
 * bundle (engine.zip). Paths are repo-relative and land under `/sc2tools/`
 * inside Pyodide, so `replay_pipeline._candidate_bases()` finds the engine
 * exactly as it does in a source checkout.
 *
 * The list is the traced import closure of
 * `sc2tools_agent.instant_analysis.parse_replay_bytes` over every fixture
 * replay (see the Instant Analysis closure research), plus modules that are
 * imported on other supported paths:
 *   - `player_handle.py`: imported when no perspective hint is given.
 *   - `sc2_observation_export.py`: optional import on the playback path.
 *
 * Deliberately NOT shipped: `data/map_bounds.json` and the repo seed
 * `data/custom_builds.json`. The installed (frozen) desktop agent has no
 * bounds table and an EMPTY custom builds file; the bundle mirrors that data
 * view and writes its own empty `custom_builds.json` (see pyodideBundle.mjs).
 * Also excluded: pulse_resolver (network), playback_artifacts (state dir),
 * detectors/, analytics other than macro_score, tests and map images.
 *
 * Example:
 *   const files = await readBundleFiles();
 *   files[0].path; // -> "apps/agent/sc2tools_agent/__init__.py"
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { REPO_DIR } from "./config.mjs";
import { BuildError } from "./util.mjs";

const AGENT = "apps/agent/sc2tools_agent";
const CORE = "apps/replay-engine/core";

const AGENT_MODULES = [
  "__init__", "camera_signature", "group_signature", "instant_analysis", "instant_intake",
  "play_signature", "player_handle", "replay_pipeline", "upload_json",
];

const CORE_MODULES = [
  "__init__", "ability_casts", "atomic_io", "build_definitions", "build_durations", "custom_builds",
  "event_extractor",
  "file_lock", "map_playback_data", "paths", "replay_errors", "replay_loader", "sc2_catalog",
  "sc2_observation_export", "sc2_replay_parser", "strategy_detector", "strategy_detector_base",
  "strategy_detector_helpers", "strategy_detector_matchups", "strategy_detector_opponent",
  "strategy_detector_pvp", "strategy_detector_pvt", "strategy_detector_pvz", "strategy_detector_race",
  "strategy_detector_user", "timebase",
];

/** Every shipped repo file, repo-relative with `/` separators. */
export const BUNDLE_FILES = Object.freeze([
  ...AGENT_MODULES.map((name) => `${AGENT}/${name}.py`),
  ...CORE_MODULES.map((name) => `${CORE}/${name}.py`),
  "apps/replay-engine/analytics/__init__.py",
  "apps/replay-engine/analytics/macro_score.py",
  // Read at import time by core/custom_builds.py (hard requirement).
  "apps/replay-engine/data/custom_builds.schema.json",
]);

/** Written by the build (empty cache), never copied from the repo. */
export const GENERATED_CUSTOM_BUILDS = "apps/replay-engine/data/custom_builds.json";

const CRLF_RE = /\r\n/g;

/**
 * Normalise CRLF to LF so a Windows checkout builds the same bundle bytes.
 * Python reads sources with universal newlines, so behaviour is unchanged.
 */
function normalizeNewlines(buffer) {
  const text = buffer.toString("utf8");
  return text.includes("\r\n") ? Buffer.from(text.replace(CRLF_RE, "\n"), "utf8") : buffer;
}

/**
 * Read every allowlisted file; fails loudly when one is missing.
 *
 * Example:
 *   (await readBundleFiles()).length; // -> 38
 */
export async function readBundleFiles() {
  return Promise.all(BUNDLE_FILES.map(async (relative) => {
    try {
      const raw = await readFile(path.join(REPO_DIR, relative));
      return { path: relative, data: normalizeNewlines(raw) };
    } catch (error) {
      throw new BuildError(`bundle allowlist file missing: ${relative} (${error.code ?? error.message})`);
    }
  }));
}
