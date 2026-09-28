/**
 * When the browser-engine build is REQUIRED (any failure fails the build)
 * rather than optional (a warning, and no engine in this deploy).
 *
 * The rollout flag is read exactly like the app reads it
 * (`lib/instant/flag.ts`: trimmed, case-insensitive), so a value such as
 * "All" or " Admins " that turns the feature on in the app can never ship
 * without an engine.
 *
 * Example:
 *   isEngineRequired([], { NEXT_PUBLIC_INSTANT_IMPORT: "All" }); // -> true
 */

export const REQUIRE_FLAG = "--require";
const REQUIRED_ENV_VALUE = "1";
const FLAG_MODES_REQUIRING_ENGINE = new Set(["admins", "all"]);

/**
 * Normalise `NEXT_PUBLIC_INSTANT_IMPORT` like `getInstantImportMode()`.
 *
 * Example:
 *   normalizeFlag(" Admins "); // -> "admins"
 */
export function normalizeFlag(value) {
  return (value ?? "").trim().toLowerCase();
}

/**
 * Whether a failure must fail the build.
 *
 * Example:
 *   isEngineRequired(["--require"], {}); // -> true
 *   isEngineRequired([], { NEXT_PUBLIC_INSTANT_IMPORT: "off" }); // -> false
 */
export function isEngineRequired(argv, env) {
  if (argv.includes(REQUIRE_FLAG)) return true;
  if (env.INSTANT_ENGINE_REQUIRED === REQUIRED_ENV_VALUE) return true;
  return FLAG_MODES_REQUIRING_ENGINE.has(normalizeFlag(env.NEXT_PUBLIC_INSTANT_IMPORT));
}
