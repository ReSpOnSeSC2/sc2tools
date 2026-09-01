"use strict";

const AjvModule = require("ajv");
const addFormatsModule = require("ajv-formats");

const Ajv = /** @type {any} */ (AjvModule).default || AjvModule;
const addFormats =
  /** @type {any} */ (addFormatsModule).default || addFormatsModule;

// Every object level deliberately allows forward-compatible properties, so
// validation is read-only. Avoid JSON stringify/parse cloning here: replay
// batches already live in req.body and a second deep copy of each heavy game
// (build logs, macro timelines, map playback) doubled peak ingest memory.
// Fail on the first schema violation. A 5 MiB replay can contain thousands
// of array items; collecting an AJV error object for every invalid item can
// amplify one bounded request into hundreds of megabytes of heap.
const ajv = new Ajv({ allErrors: false });
addFormats(ajv);

// These ceilings intentionally match services/scouting/compositionAt.js.
// Real SC2 unit tokens / per-tick type counts sit far below them; their job is
// to reject adversarial maps before phase preparation can amplify giant keys.
const UNIT_TIMELINE_TOKEN_MAX_LENGTH = 64;
const UNIT_TIMELINE_SIDE_MAX_PROPERTIES = 256;
// Agent build-log rows are ``[m:ss] InternalName`` and are normally under
// 40 characters. Leave ample room for future tokens without accepting a
// multi-megabyte string in any of the 5,000-entry log arrays.
const BUILD_LOG_LINE_MAX_LENGTH = 256;

// Compact replay-behavior evidence used by the private opponent identity
// matcher. It lives on the slim game row, so every branch is explicitly
// bounded even though the surrounding agent payload remains forward
// compatible.
const PLAY_SIGNATURE_SLOT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["slot", "set", "add", "recall", "doubleTap"],
  properties: {
    slot: { type: "integer", minimum: 0, maximum: 9 },
    set: { type: "integer", minimum: 0, maximum: 9999 },
    add: { type: "integer", minimum: 0, maximum: 9999 },
    recall: { type: "integer", minimum: 0, maximum: 9999 },
    doubleTap: { type: "integer", minimum: 0, maximum: 9999 },
  },
};

const PLAY_SIGNATURE_TRANSITION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["from", "to", "count"],
  properties: {
    from: { type: "integer", minimum: 0, maximum: 9 },
    to: { type: "integer", minimum: 0, maximum: 9 },
    count: { type: "integer", minimum: 1, maximum: 9999 },
  },
};

const PLAY_SIGNATURE_MILESTONE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["atSec", "name"],
  properties: {
    atSec: { type: "integer", minimum: 0, maximum: 10 * 60 },
    name: { type: "string", minLength: 1, maxLength: 64 },
  },
};

const PLAY_SIGNATURE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["version", "windowSec"],
  properties: {
    version: { const: 1 },
    windowSec: { type: "integer", minimum: 1, maximum: 10 * 60 },
    controlGroups: {
      type: "object",
      additionalProperties: false,
      required: ["events", "activeSeconds", "slots"],
      properties: {
        events: { type: "integer", minimum: 1, maximum: 99999 },
        activeSeconds: { type: "integer", minimum: 1, maximum: 10 * 60 },
        slots: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          items: PLAY_SIGNATURE_SLOT_SCHEMA,
        },
        transitions: {
          type: "array",
          maxItems: 12,
          items: PLAY_SIGNATURE_TRANSITION_SCHEMA,
        },
      },
    },
    build: {
      type: "object",
      additionalProperties: false,
      required: ["milestones"],
      properties: {
        milestones: {
          type: "array",
          minItems: 1,
          maxItems: 18,
          items: PLAY_SIGNATURE_MILESTONE_SCHEMA,
        },
      },
    },
  },
  anyOf: [
    { required: ["controlGroups"] },
    { required: ["build"] },
  ],
};

const UNIT_TIMELINE_SIDE_SCHEMA = {
  type: "object",
  additionalProperties: true,
  maxProperties: UNIT_TIMELINE_SIDE_MAX_PROPERTIES,
  propertyNames: {
    type: "string",
    minLength: 1,
    maxLength: UNIT_TIMELINE_TOKEN_MAX_LENGTH,
  },
};

const GAME_SCHEMA = {
  type: "object",
  required: ["gameId", "date", "result", "myRace", "map"],
  additionalProperties: true,
  allOf: [
    {
      if: {
        required: ["myMmrSource"],
        properties: { myMmrSource: { const: "replay" } },
      },
      then: { required: ["myMmr"] },
    },
    {
      if: {
        required: ["myMmrSource"],
        properties: { myMmrSource: { const: "unavailable" } },
      },
      then: { not: { required: ["myMmr"] } },
    },
  ],
  properties: {
    gameId: { type: "string", minLength: 1, maxLength: 200 },
    isResumedFromReplay: { type: "boolean" },
    resumedReplayGameIds: {
      type: "array",
      maxItems: 50,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 200 },
    },
    date: { type: "string", format: "date-time" },
    // Exact replay start time from sc2reader. ``date`` remains the replay
    // end time for backwards compatibility with existing rows/clients.
    // Optional for records uploaded by agents predating this field.
    startedAt: { type: "string", format: "date-time" },
    result: { type: "string", enum: ["Victory", "Defeat", "Tie"] },
    myRace: { type: "string", minLength: 1, maxLength: 24 },
    // Race selected when queueing for ladder. This can be "Random"
    // even though ``myRace`` records the race actually spawned in the
    // replay. Optional for payloads from agents predating this field.
    myLadderRace: { type: "string", minLength: 1, maxLength: 24 },
    myBuild: { type: "string", maxLength: 200 },
    map: { type: "string", minLength: 1, maxLength: 200 },
    // Total players in the replay. Emitted by the agent from the parsed
    // player list; retained as display metadata and as the legacy 1v1
    // fallback when matchFormat is absent. Count alone cannot distinguish
    // a team game from FFA. Optional for older agents.
    playerCount: { type: "integer", minimum: 1, maximum: 16 },
    // Normalized topology of the replay's actual player/team layout.
    // Unlike playerCount, this distinguishes an 8-player FFA from a
    // 4v4 team game. The global Players filter uses this as the
    // authoritative format signal; older agents omit it.
    matchFormat: {
      type: "string",
      enum: ["1v1", "team", "ffa", "other"],
    },
    // Authoritative ladder-vs-custom signal from the replay's
    // matchmaking category. true = ranked ladder, false = custom. The
    // ingest path prefers this over the map-name proxy when present.
    // Optional — games from agents predating this field fall back to
    // the proxy.
    isLadderGame: { type: "boolean" },
    // Exact client provenance from the replay header. ``gameVersion``
    // preserves sc2reader's four-part release string (for example
    // 5.0.16.97425); ``gameBuild`` is the numeric client build. Both
    // remain optional for records uploaded by pre-cutover agents.
    gameVersion: {
      type: "string",
      pattern: "^[0-9]+(?:\\.[0-9]+){3}$",
      maxLength: 40,
    },
    gameBuild: { type: "integer", minimum: 1, maximum: 2147483647 },
    durationSec: { type: "integer", minimum: 0, maximum: 24 * 60 * 60 },
    macroScore: { type: "number", minimum: 0, maximum: 100 },
    apm: { type: "number", minimum: 0, maximum: 5000 },
    spq: { type: "number", minimum: 0 },
    // Player MMR at the time of the game. Optional — the agent only
    // surfaces this for ranked replays where sc2reader exposes it. The
    // overlay's session widget reads this to derive an MMR delta.
    myMmr: { type: "integer", minimum: 0, maximum: 9999 },
    // Agent-authored provenance for ``myMmr``. ``replay`` means the
    // rating came from this replay's player record; ``unavailable`` is
    // an explicit instruction that no game-time rating exists. The
    // latter lets a resync remove legacy rows polluted by the retired
    // current-SC2Pulse fallback without guessing from a flat chart.
    myMmrSource: { type: "string", enum: ["replay", "unavailable"] },
    // Streamer's own raw sc2reader toon_handle (e.g. "2-S2-1-267727").
    // Optional — earlier agent versions don't ship it. Used by the
    // session widget's Tier-3 MMR fallback so the cloud can resolve the
    // streamer's current 1v1 ladder rating via SC2Pulse without
    // requiring them to paste a numeric pulseCharacterId into Settings.
    myToonHandle: { type: "string", maxLength: 64 },
    // Legacy slim aliases are still accepted from older agents, but each is
    // explicitly typed so a forward-compatible unknown-field policy cannot
    // turn an allow-listed high-fan-out field into a multi-megabyte object.
    duration: { type: "number", minimum: 0, maximum: 24 * 60 * 60 },
    macro_score: { type: "number", minimum: 0, maximum: 100 },
    oppMmr: { type: "integer", minimum: 0, maximum: 9999 },
    oppPulseId: { type: "string", maxLength: 200 },
    oppRace: { type: "string", maxLength: 24 },
    opp_strategy: { type: "string", maxLength: 200 },
    top3Leaks: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", maxLength: 120 },
          detail: { type: "string", maxLength: 300 },
          quantity: { type: "number", minimum: 0, maximum: 1000000 },
          mineral_cost: { type: "number", minimum: 0, maximum: 100000000 },
          penalty: { type: "number", minimum: 0, maximum: 100000000 },
        },
      },
    },
    opponent: {
      type: "object",
      additionalProperties: true,
      properties: {
        // pulseId is the per-opponent storage key. Historically holds
        // the raw sc2reader toon_handle (region-realm-bnid); kept stable
        // for backwards compat with existing rows.
        pulseId: { type: "string", maxLength: 200 },
        // toonHandle: the raw sc2reader toon_handle (e.g. "1-S2-1-267727").
        // Carried separately so we can retroactively resolve a
        // pulseCharacterId on later games even if the first ingestion
        // happened while sc2pulse.nephest.com was unreachable.
        toonHandle: { type: "string", maxLength: 64 },
        // pulseCharacterId: the canonical SC2Pulse character ID (numeric
        // string) — e.g. "994428". This is what the UI shows in the
        // "Pulse ID" column and what links to sc2pulse.nephest.com.
        pulseCharacterId: { type: "string", pattern: "^[0-9]+$", maxLength: 32 },
        // pulseLookupAttempted: true when the agent tried to resolve
        // the toon → pulseCharacterId for this game, regardless of
        // whether the lookup succeeded. Lets the API distinguish
        // "agent didn't try" from "agent tried and Pulse said no",
        // which the server-side backfill cron uses to decide whether
        // to retry. v0.5.x agents always emit this when ``opp.handle``
        // is present.
        pulseLookupAttempted: { type: "boolean" },
        // Server-owned one-shot marker for the recent-game SC2Pulse
        // MMR enrichment job. true means the row was attempted even
        // when Pulse had no matching-race rating, so misses do not
        // re-enter the queue forever.
        mmrLookupAttempted: { type: "boolean" },
        // Independent server-owned one-shot marker for league repair.
        // Separate from MMR because older rows may already have a rating
        // while still lacking the leagueId required by league-band meta.
        leagueLookupAttempted: { type: "boolean" },
        displayName: { type: "string", maxLength: 80 },
        race: { type: "string", maxLength: 24 },
        mmr: { type: "integer", minimum: 0, maximum: 9999 },
        leagueId: { type: "integer", minimum: 0, maximum: 100 },
        opening: { type: "string", maxLength: 80 },
        strategy: { type: "string", maxLength: 200 },
        playSignature: PLAY_SIGNATURE_SCHEMA,
      },
    },
    buildLog: {
      type: "array",
      maxItems: 5000,
      items: { type: "string", maxLength: BUILD_LOG_LINE_MAX_LENGTH },
    },
    earlyBuildLog: {
      type: "array",
      maxItems: 1000,
      items: { type: "string", maxLength: BUILD_LOG_LINE_MAX_LENGTH },
    },
    oppEarlyBuildLog: {
      type: "array",
      maxItems: 1000,
      items: { type: "string", maxLength: BUILD_LOG_LINE_MAX_LENGTH },
    },
    oppBuildLog: {
      type: "array",
      maxItems: 5000,
      items: { type: "string", maxLength: BUILD_LOG_LINE_MAX_LENGTH },
    },
    // Structured macro analytics. The agent computes these on each
    // upload so the SPA's Activity tab and macro-breakdown drilldown
    // can render charts without a follow-up recompute round-trip.
    macroBreakdown: {
      type: "object",
      additionalProperties: true,
      properties: {
        raw: { type: "object", additionalProperties: true },
        all_leaks: { type: "array", maxItems: 100 },
        top_3_leaks: { type: "array", maxItems: 10 },
        stats_events: { type: "array", maxItems: 5000 },
        opp_stats_events: { type: "array", maxItems: 5000 },
        // unit_timeline arrives at the same cadence as stats_events
        // (one entry per 10 s game-time bucket post-downsample, matching
        // sc2reader's native PlayerStatsEvent cadence). Each entry
        // shape: { time, my: {Name: count}, opp: {Name: count} }. Cap
        // is 5000 entries — enough for ~13 h of game time, so SC2's
        // hard 60-min limit never approaches the bound.
        unit_timeline: {
          type: "array",
          maxItems: 5000,
          items: {
            type: "object",
            additionalProperties: true,
            properties: {
              my: UNIT_TIMELINE_SIDE_SCHEMA,
              opp: UNIT_TIMELINE_SIDE_SCHEMA,
            },
          },
        },
        // Per-player cumulative stats: { me, opponent } each carrying
        // counters (units_produced, units_killed, etc.) plus the
        // average APM/SPM merged from the apmCurve. Drives the SPA's
        // Replay Player Unit Statistics table.
        player_stats: { type: "object", additionalProperties: true },
        // Structure lifetimes
        // ({name, unit_id, born_time, died_time, destroyed}) for both
        // sides. The explicit lifecycle result lets the SPA and API
        // subtract the latest real death instead of mistaking it for
        // the legacy game-end survivor timestamp. Caps sit far above
        // what a real game produces (~200 structures in a heavy game).
        production_buildings: { type: "array", maxItems: 2000 },
        opp_production_buildings: { type: "array", maxItems: 2000 },
        bases: { type: "array", maxItems: 200 },
        opp_bases: { type: "array", maxItems: 200 },
      },
    },
    apmCurve: {
      type: "object",
      additionalProperties: true,
      properties: {
        window_sec: { type: "integer", minimum: 1, maximum: 600 },
        has_data: { type: "boolean" },
        players: { type: "array", maxItems: 8 },
      },
    },
    // Compact vespene-style playback payload for the map replayer:
    // per-unit waypoint tracks + buildings + battle markers + stats
    // series in world coordinates. Agent-side compaction bounds every
    // list; the caps here are a belt-and-braces backstop far above
    // what a real 60-minute game compacts to.
    mapPlayback: {
      type: "object",
      additionalProperties: true,
      properties: {
        v: { type: "integer", minimum: 1, maximum: 10 },
        mapName: { type: "string", maxLength: 200 },
        gameLength: { type: "number", minimum: 0, maximum: 24 * 60 * 60 },
        bounds: { type: "object", additionalProperties: true },
        spawns: { type: "array", maxItems: 16 },
        battles: { type: "array", maxItems: 200 },
        buildings: { type: "array", maxItems: 1000 },
        units: { type: "array", maxItems: 1200 },
        resources: { type: "array", maxItems: 600 },
        // Ability / spell casts (v5 payloads; absent on v4 and older).
        // o = 0 me / 1 opponent, a = stable ability slug, t = game
        // seconds, x/y = world cells and are OMITTED when the engine
        // could not place a self-cast. Nothing is required: a cast the
        // agent shaped oddly must never cost the whole game record its
        // upload, and apps/web's sanitizeMapPlayback drops malformed
        // entries individually before anything is drawn.
        casts: {
          type: "array",
          maxItems: 800,
          items: {
            type: "object",
            additionalProperties: true,
            properties: {
              o: { type: "integer", minimum: 0, maximum: 1 },
              a: { type: "string", maxLength: 40 },
              t: { type: "number", minimum: 0, maximum: 24 * 60 * 60 },
              x: { type: "number" },
              y: { type: "number" },
            },
          },
        },
        stats: { type: "object", additionalProperties: true },
      },
    },
  },
};

const validate = ajv.compile(GAME_SCHEMA);

/**
 * Validate + normalize one game record from the agent.
 *
 * @param {unknown} raw
 * @returns {{valid: true, value: object} | {valid: false, errors: string[]}}
 */
function validateGameRecord(raw) {
  if (!raw || typeof raw !== "object") {
    return { valid: false, errors: ["body must be an object"] };
  }
  const value = /** @type {Record<string, any>} */ (raw);
  if (!validate(value)) {
    const errs = (validate.errors || []).slice(0, 3).map(
      /** @param {any} e */
      (e) => `${e.instancePath || "/"} ${e.message}`,
    );
    return { valid: false, errors: errs };
  }
  return { valid: true, value };
}

module.exports = { validateGameRecord };
