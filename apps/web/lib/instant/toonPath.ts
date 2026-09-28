/**
 * Toon-handle and replay-folder path rules for Instant Analysis.
 *
 * StarCraft II stores ladder replays under
 * `Accounts/<accountId>/<region>-S2-<realm>-<id>/Replays/Multiplayer/`.
 * The `<region>-S2-<realm>-<id>` folder names the player exactly, so a
 * replay path that keeps it tells us "which player is me" without any
 * guessing. These helpers reproduce the desktop agent's rules byte for
 * byte (`replay_pipeline._toon_handle_from_path` and the Multiplayer
 * discovery in `replay_finder.all_multiplayer_dirs`) so the browser and
 * the agent always pick the same player and therefore the same gameId.
 *
 * Example:
 *   toonFromPath("Accounts/1/1-S2-1-267727/Replays/Multiplayer/a.SC2Replay");
 *   // -> "1-S2-1-267727"
 */

/**
 * Battle.net toon handle, e.g. `1-S2-1-267727`. Anchored on the whole
 * path segment and case-sensitive on `S2`, with the same semantics as the
 * agent's `_TOON_HANDLE_RE = re.compile(r"^\d+-S2-\d+-\d+$")` under
 * Python's `re`: `\d` on a str pattern is any Unicode decimal digit
 * (category Nd, hence `\p{Nd}` here, not JS's ASCII-only `\d`), and `$`
 * also matches just before one trailing newline (hence `\n?$`).
 */
export const TOON_HANDLE_RE = /^\p{Nd}+-S2-\p{Nd}+-\p{Nd}+\n?$/u;

const PATH_SEPARATOR_RE = /[\\/]/;
const REPLAY_EXTENSION_RE = /\.sc2replay$/i;
const MULTIPLAYER_DIR = "multiplayer";
const REPLAYS_DIR = "replays";

/**
 * Split a relative path on both `/` and `\` and drop empty segments.
 *
 * Example:
 *   pathSegments("a\\b//c.SC2Replay"); // -> ["a", "b", "c.SC2Replay"]
 */
export function pathSegments(path: string): string[] {
  return path.split(PATH_SEPARATOR_RE).filter((part) => part.length > 0);
}

/**
 * First path segment (root to leaf) that is a toon handle, or null.
 * Same order and matching as the desktop agent, which walks
 * `Path.parts` and returns the first `_TOON_HANDLE_RE` match.
 *
 * Example:
 *   toonFromPath("C:\\SC2\\Accounts\\9\\2-S2-1-42\\Replays\\Multiplayer\\x.SC2Replay"); // -> "2-S2-1-42"
 *   toonFromPath("Downloads/x.SC2Replay"); // -> null
 */
export function toonFromPath(path: string): string | null {
  for (const part of path.split(PATH_SEPARATOR_RE)) {
    if (TOON_HANDLE_RE.test(part)) return part;
  }
  return null;
}

/**
 * True for `…/Replays/Multiplayer/<name>.SC2Replay` (folder names and
 * extension compared case-insensitively, like the agent's discovery on
 * Windows/macOS file systems). When the picked root IS the
 * `Multiplayer` folder, the relative path is just
 * `Multiplayer/<name>.SC2Replay` and is accepted too.
 *
 * Example:
 *   isMultiplayerReplayPath("1-S2-1-5/Replays/Multiplayer/a.SC2Replay"); // -> true
 *   isMultiplayerReplayPath("Multiplayer/a.sc2replay");                   // -> true
 *   isMultiplayerReplayPath("1-S2-1-5/Replays/VersusAI/a.SC2Replay");     // -> false
 */
export function isMultiplayerReplayPath(relativePath: string): boolean {
  const parts = pathSegments(relativePath);
  const count = parts.length;
  if (count < 2) return false;
  if (!REPLAY_EXTENSION_RE.test(parts[count - 1])) return false;
  if (parts[count - 2].toLowerCase() !== MULTIPLAYER_DIR) return false;
  return count === 2 || parts[count - 3].toLowerCase() === REPLAYS_DIR;
}
