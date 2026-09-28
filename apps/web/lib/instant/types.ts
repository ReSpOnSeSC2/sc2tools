/**
 * Shared types for Instant Analysis: the in-browser replay engine, file
 * intake, player identification, local storage and uploads.
 *
 * Everything here is plain data so it can cross the Web Worker boundary
 * (structured clone) and be stored in IndexedDB unchanged.
 *
 * Example:
 *   const outcome: ParseOutcome = { ok: false, fileName: "a.SC2Replay",
 *     relativePath: "a.SC2Replay", errorKind: "corrupt_file", ms: 12 };
 */

/**
 * Why a single replay could not become an uploadable game.
 *
 * The first block mirrors what `sc2tools_agent.instant_analysis` returns
 * (`errorKind`); the second block is produced by the TypeScript client.
 */
export type ErrorKind =
  // --- emitted by the Python engine ---
  | "unsupported_version"
  | "corrupt_file"
  | "not_a_replay"
  | "ai_game"
  | "player_unresolved"
  | "player_ambiguous"
  | "no_result"
  | "parse_failed"
  | "analysis_failed"
  | "playback_budget_exceeded"
  | "engine_unavailable"
  // --- emitted by the client / worker host ---
  | "timeout"
  | "out_of_memory"
  | "not_1v1"
  | "resumed_replay"
  | "outside_date_range"
  | "too_large"
  | "cancelled"
  | "integrity_failed"
  | "engine_boot_failed"
  | "worker_crashed";

/** Where a file entered the flow (GA4 `instant_files_selected.source`). */
export type IntakeSource = "drop" | "picker" | "folder" | "zip";

/** One candidate replay the visitor handed us. Never leaves the device. */
export interface IntakeFile {
  /** Stable key within one session (relativePath + size + lastModified). */
  key: string;
  /** Base name, e.g. `Tourmaline LE (3).SC2Replay`. */
  name: string;
  /**
   * Path relative to the picked root, `/`-separated. For Folder Sync this
   * keeps the `<region>-S2-<realm>-<id>` toon folder, which identifies the
   * player exactly (same rule as the desktop agent).
   */
  relativePath: string;
  size: number;
  /** `File.lastModified` in epoch ms (used for the pre-parse date filter). */
  lastModified: number;
  source: IntakeSource;
  blob: Blob;
}

/** A human, non-observer player as read by `list_replay_players`. */
export interface ReplayPlayer {
  name: string;
  /** sc2reader toon handle, e.g. `1-S2-1-267727`; null when absent. */
  toon: string | null;
  race: string;
  result: "Win" | "Loss" | "Tie" | null;
  pid: number;
}

export type MatchFormat = "1v1" | "team" | "ffa" | "other";

/** Cheap header scan used for "which player is me?" and date filtering. */
export type PlayersResult =
  | {
      ok: true;
      players: ReplayPlayer[];
      /** Replay end time, RFC 3339 UTC, or null for degenerate replays. */
      date: string | null;
      map: string | null;
      durationSec: number;
      matchFormat: MatchFormat | null;
      playerCount: number;
      isAiGame: boolean;
      /** Toon handle found in the relative path, if any. */
      toonFromPath: string | null;
    }
  | { ok: false; errorKind: ErrorKind; detail?: string };

/** Hashes of the original file, for the optional replay backup. */
export interface ReplayDigests {
  sha256: string;
  /** Base64 MD5 (the `Content-MD5` header R2 verifies). */
  md5: string;
  sizeBytes: number;
}

/** Successful parse: the exact payload the desktop agent would upload. */
export interface ParsedGame {
  ok: true;
  fileName: string;
  relativePath: string;
  gameId: string;
  /**
   * Compact JSON of `CloudGame.to_payload()`, produced by Python's
   * `upload_json.compact_json_bytes` (ASCII-only). Upload these bytes as-is.
   */
  json: string;
  date: string;
  myToonHandle: string | null;
  matchFormat: MatchFormat | null;
  isResumedFromReplay: boolean;
  ms: number;
  digests?: ReplayDigests;
}

export interface FailedParse {
  ok: false;
  fileName: string;
  relativePath: string;
  errorKind: ErrorKind;
  /** Short technical detail for a disclosure. Never contains player names. */
  detail?: string;
  ms: number;
}

export type ParseOutcome = ParsedGame | FailedParse;

/** Identity the engine should analyse the replay from. */
export interface PlayerSelector {
  /** Exact toon handle; preferred. Verified against the parsed payload. */
  toon: string | null;
  /** Display name (substring match, desktop-agent semantics). */
  handle: string | null;
}

export interface ParseRequest {
  file: IntakeFile;
  player: PlayerSelector;
  /** Also return SHA-256 + MD5 of the original bytes (replay backup). */
  wantDigests?: boolean;
}

export type EnginePhase = "boot" | "players" | "parse" | "unzip";

/** Progress event: `{phase, index, total, fileName, ms, ok|error}`. */
export interface EngineProgress {
  phase: EnginePhase;
  index: number;
  total: number;
  fileName: string;
  /** Present once the step has finished. */
  ms?: number;
  ok?: boolean;
  errorKind?: ErrorKind;
}

export interface EngineInfo {
  engineVersion: string;
  pyodideVersion: string;
  pythonVersion: string;
  bundleId: string;
  bootMs: number;
}

/** `/engine/current.json`. */
export interface EnginePointer {
  protocol: number;
  engineVersion: string;
  manifest: string;
}

export type EngineAssetRole =
  | "pyodide-loader"
  | "pyodide-asm"
  | "pyodide-wasm"
  | "python-stdlib"
  | "engine-bundle";

export interface EngineAsset {
  role: EngineAssetRole;
  /** Same-origin absolute path, e.g. `/pyodide/314.0.7/pyodide.asm.wasm`. */
  path: string;
  sha256: string;
  bytes: number;
}

/** `/engine/<engineVersion>/<bundleId>/manifest.json`. */
export interface EngineManifest {
  protocol: number;
  engineVersion: string;
  pyodideVersion: string;
  pythonVersion: string;
  bundleId: string;
  /** Pyodide lock `info` block; lets the worker boot without the lock file. */
  lockInfo: Record<string, unknown>;
  assets: EngineAsset[];
  python: { sysPath: string[]; module: string };
  builtFrom: {
    agentVersion: string;
    wheels: Array<{ file: string; sha256: string }>;
  };
}

export interface ParseOptions {
  onProgress?: (event: EngineProgress) => void;
  signal?: AbortSignal;
}

/** Promise-based façade over the engine worker (see `engineClient.ts`). */
export interface EngineClient {
  boot(options?: ParseOptions): Promise<EngineInfo>;
  listPlayers(files: IntakeFile[], options?: ParseOptions): Promise<PlayersResult[]>;
  parseFiles(requests: ParseRequest[], options?: ParseOptions): Promise<ParseOutcome[]>;
  /** Unzip with Python's `zipfile` inside the worker; returns replay entries. */
  expandZip(file: IntakeFile, options?: ParseOptions): Promise<IntakeFile[]>;
  cancel(): void;
  dispose(): void;
  /**
   * Emscripten heap in bytes reported by the most recent boot or parse,
   * or null before the engine first booted. Read-only; used by the memory
   * budget measurement. Optional so test doubles need not implement it.
   */
  lastHeapBytes?(): number | null;
}

/** A parsed game ready for upload (from a fresh parse or IndexedDB). */
export interface UploadableGame {
  gameId: string;
  json: string;
  /** Optional original file for the replay backup. */
  file?: IntakeFile;
  digests?: ReplayDigests;
}
