/**
 * SC2 Stream Overlay Backend (merged toolkit edition)
 * -------------------------------------------------------------
 * - Unified event bus ("overlay_event") with typed envelopes.
 * - Back-compat shims for the original "new_match_result" /
 *   "opponent_update" channels so old clients keep working.
 * - Persistent session tracker (wins / losses / MMR delta / time)
 *   that survives restarts and auto-resets after a 4h idle gap.
 * - Cheese-history detection from MyOpponentHistory.json.
 * - Rematch / streak / rank-up pop-ups.
 * - Config file (overlay.config.json) with hot-reload over HTTP.
 * - Dev test panel at /static/debug.html to fire any event.
 * - Twitch chat bot: !stats, !session, !record, !build, !meta.
 *
 * NEW in the merged toolkit:
 *   - /api/replay/deep  endpoint receives strategy detection results
 *     from the threaded deep-parse worker.
 *   - favoriteOpening   pop-up (F1): emitted pre-game when we have
 *     enough history vs this opponent to know their go-to opener.
 *   - bestAnswer        pop-up (F2): emitted alongside favoriteOpening
 *     with the build that has historically beaten that opener.
 *   - postGameStrategyReveal (F3): emitted after the deep parse
 *     completes -- shows what the opponent actually did.
 *   - !build  Twitch    (F4): replays the FIRST 5 MINUTES of the user's
 *     own most recent build so chat can see the opener.
 *   - metaCheck         (F5): counts how often the opponent uses their
 *     favorite opening this session.
 */

require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cors = require('cors');
const { Server } = require('socket.io');
const tmi = require('tmi.js');
const { mmrToLeague } = require('./utils');
// Analyzer module (meta_database.json + MyOpponentHistory.json
// aggregations served as JSON to the new web SPA at /analyzer).
const analyzer = require('./analyzer');
// node-fetch v2 ships in node_modules; stick with that to keep CJS
// require() compatibility on older node runtimes that don't have a
// global fetch.
const fetch = (typeof globalThis.fetch === 'function')
    ? globalThis.fetch.bind(globalThis)
    : require('node-fetch');

// ------------------------------------------------------------------
// PATHS
// ------------------------------------------------------------------
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');

// Prefer the unified data/ location if it exists; fall back to project root.
function pickHistoryPath() {
    const dataDirPath = path.join(DATA_DIR, 'MyOpponentHistory.json');
    const legacyPath  = path.join(ROOT, 'MyOpponentHistory.json');
    if (fs.existsSync(dataDirPath)) return dataDirPath;
    if (fs.existsSync(legacyPath))  return legacyPath;
    // If neither exists yet, the watcher will create the data/ one.
    return dataDirPath;
}

const HISTORY_FILE_PATH  = pickHistoryPath();
const OPPONENT_FILE_PATH = path.join(ROOT, 'opponent.txt');
const SCANNED_MMR_PATH   = path.join(ROOT, 'scanned_mmr.txt');
// Reveal-Sc2Opponent.ps1 writes the resolved Pulse Character ID(s)
// here so the backend doesn't have to re-implement the auto-detect.
// Single source of truth: configure CharacterId in reveal-sc2-opponent.bat.
const CHARACTER_IDS_PATH = path.join(ROOT, 'character_ids.txt');
const CONFIG_PATH        = path.join(__dirname, 'overlay.config.json');
const SESSION_STATE_PATH = path.join(__dirname, 'session.state.json');
const PUBLIC_DIR         = path.join(__dirname, 'public');
const SOUNDS_DIR         = path.join(PUBLIC_DIR, 'sounds');

// ------------------------------------------------------------------
// CONFIG
// ------------------------------------------------------------------
const DEFAULT_CONFIG = {
    events: {
        matchResult:             { enabled: true, durationMs: 15000, priority: 5 },
        opponentDetected:        { enabled: true, durationMs: 20000, priority: 5 },
        rematch:                 { enabled: true, durationMs: 15000, priority: 6 },
        cheeseHistory:           { enabled: true, durationMs: 18000, priority: 8, cheeseMaxSeconds: 300 },
        streak:                  { enabled: true, durationMs: 8000,  priority: 7 },
        rankChange:              { enabled: true, durationMs: 12000, priority: 9 },
        mmrDelta:                { enabled: true, durationMs: 10000, priority: 4 },
        favoriteOpening:         { enabled: true, durationMs: 18000, priority: 7, minGames: 2 },
        bestAnswer:              { enabled: true, durationMs: 18000, priority: 7, minSamples: 2 },
        postGameStrategyReveal:  { enabled: true, durationMs: 16000, priority: 6 },
        metaCheck:               { enabled: true, durationMs: 12000, priority: 5 },
        rivalAlert:              { enabled: true, durationMs: 16000, priority: 9, minGames: 5 },
        scoutingReport:          { enabled: true, durationMs: 22000, priority: 8 },
        session:                 { enabled: true } // persistent, no duration
    },
    twitch: { enabled: true },
    sounds: { enabled: false, volume: 0.5 },
    session: {
        idleResetMs: 1 * 60 * 60 * 1000, // auto-reset after 1h gap
        // Per-game MMR estimate. DEFAULT 0/0 -- we'd rather show "0"
        // and wait for the SC2Pulse post-match fetch to deliver the
        // real number than show a fake +25 that turns out to be wrong
        // (real MMR swings are typically +/-6 to +/-30 depending on
        // expected outcome). Set to non-zero only if you accept the
        // approximation when Pulse/replay don't provide real data.
        mmrEstimate: { winDelta: 0, lossDelta: 0 }
    },
    pulse: {
        // SC2Pulse community ladder API. ONLY source of truth for
        // session MMR. We aggressively retry the post-match fetch so
        // real numbers land within ~30 seconds of the game ending.
        enabled: true,
        apiRoot: 'https://sc2pulse.nephest.com/sc2/api',
        queue: 'LOTV_1V1',
        // Empty array = auto-detect from local SC2 profile folder.
        // Override here to pin specific Pulse character IDs.
        characterIds: [],
        // Delay before first post-match fetch. SC2Pulse ingests from
        // Blizzard every few seconds; 8s is enough for the typical case.
        fetchDelayMs: 8000,
        // Max age (seconds) of team.lastPlayed for the reading to
        // count as belonging to the match we just finished. 900s = 15
        // min, generous enough to absorb Pulse ingest lag.
        freshSeconds: 900,
        // Retry chain when the first reading is stale.
        retryDelayMs: 6000,
        retryAttempts: 5
    }
};

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            let raw = fs.readFileSync(CONFIG_PATH, 'utf8');
            if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
            const parsed = JSON.parse(raw);
            return deepMerge(DEFAULT_CONFIG, parsed);
        }
        _atomicWriteJsonSync(CONFIG_PATH, DEFAULT_CONFIG, 2);
        return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    } catch (err) {
        console.error('[Config] Load failed, using defaults:', err.message);
        return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    }
}

function deepMerge(base, override) {
    if (Array.isArray(base) || typeof base !== 'object' || base === null) return override ?? base;
    const out = { ...base };
    for (const k of Object.keys(override || {})) {
        out[k] = (k in base) ? deepMerge(base[k], override[k]) : override[k];
    }
    return out;
}

let config = loadConfig();

// ------------------------------------------------------------------
// SESSION STATE
// ------------------------------------------------------------------
function defaultSession() {
    return {
        startedAt: Date.now(),
        wins: 0,
        losses: 0,
        mmrStart: null,
        mmrCurrent: null,
        // Cumulative MMR change for the session. Tracked as a
        // first-class field so we can keep accruing per-game estimates
        // even when the replay file doesn't carry a usable MMR. Real
        // OCR / replay readings recompute this from mmrCurrent-mmrStart.
        mmrDelta: 0,
        currentStreak: { type: null, count: 0 },
        lastResultTime: null,
        // F5 meta check: counts of opponent-strategy hits this session
        metaCounts: {}
    };
}

// Pull the per-game MMR estimate from config. NO HIDDEN FALLBACK:
// if the user has 0/0 (the default), we honor that and add nothing --
// we'd rather show "xD" in the session widget than a made-up +25 that
// turns out to be wrong. To opt in to estimates, set non-zero
// winDelta/lossDelta in stream-overlay-config.json explicitly.
function mmrEstimateDeltas() {
    const est = (config.session && config.session.mmrEstimate) || {};
    const winDelta  = (typeof est.winDelta  === 'number') ? est.winDelta  : 0;
    const lossDelta = (typeof est.lossDelta === 'number') ? est.lossDelta : 0;
    return { winDelta, lossDelta };
}

// Recompute mmrDelta from the absolute mmrStart/mmrCurrent anchors when
// both are known. Real OCR or replay readings should be authoritative
// over any prior estimates that were accumulated into mmrDelta.
function recomputeSessionMmrDelta() {
    if (Number.isFinite(session.mmrStart) && Number.isFinite(session.mmrCurrent)) {
        session.mmrDelta = Math.round(session.mmrCurrent - session.mmrStart);
    }
}

function loadSession() {
    try {
        if (!fs.existsSync(SESSION_STATE_PATH)) return defaultSession();
        const raw = fs.readFileSync(SESSION_STATE_PATH, 'utf8');
        const data = JSON.parse(raw);
        const idleGap = Date.now() - (data.lastResultTime || data.startedAt || 0);
        if (idleGap > (config.session?.idleResetMs ?? (1 * 60 * 60 * 1000))) {
            console.log('[Session] Idle gap exceeded, starting fresh session.');
            // #5 Render the recap BEFORE wiping. We can't call
            // generateRecapPng() yet because that helper uses the live
            // `session` -- but the python script reads
            // session.state.json directly off disk, so it sees the
            // PRIOR session's stats correctly. Schedule it after
            // express is up.
            setTimeout(() => {
                try { generateRecapPng(); } catch (_) {}
            }, 500);
            return defaultSession();
        }
        const merged = { ...defaultSession(), ...data, metaCounts: data.metaCounts || {} };

        // Backfill mmrDelta for sessions saved by the older code path
        // that didn't track it as a first-class field. ONLY trust the
        // real absolute anchors (mmrStart/mmrCurrent set by SC2Pulse or
        // a real replay reading). We deliberately do NOT synthesize a
        // delta from W-L counts here -- the user wants real numbers or
        // an honest "xD" in the widget, not a fabricated +25 per win.
        if (!Number.isFinite(merged.mmrDelta) || merged.mmrDelta === 0) {
            if (Number.isFinite(merged.mmrStart) &&
                Number.isFinite(merged.mmrCurrent) &&
                merged.mmrStart !== merged.mmrCurrent) {
                merged.mmrDelta = Math.round(merged.mmrCurrent - merged.mmrStart);
            }
        }
        return merged;
    } catch (err) {
        console.error('[Session] Load failed:', err.message);
        return defaultSession();
    }
}

let session = loadSession();

function saveSession() {
    try {
        _atomicWriteJsonSync(SESSION_STATE_PATH, session, 2);
    } catch (err) {
        console.error('[Session] Save failed:', err.message);
    }
}

// MMR -> league name. Approximate boundaries based on Blizzard's
// 1v1 ladder ranges; close enough for a stream overlay badge. Edit
// here if Blizzard rebalances the ladder.
// (Moved to utils.js)

function sessionSnapshot() {
    const elapsedMs = Date.now() - session.startedAt;
    const totalMin = Math.max(0, Math.floor(elapsedMs / 60000));
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;

    // mmrDelta resolution rules (no mock/fake data allowed):
    //   1. Both real anchors known -> real delta (mmrCurrent - mmrStart).
    //   2. Anchors missing AND user opted into a per-game estimate
    //      (non-zero winDelta/lossDelta in config) -> trust the
    //      accumulated session.mmrDelta.
    //   3. Anchors missing AND no estimate configured AND any games
    //      have been played -> null (frontend renders "xD").
    //   4. Fresh session, 0 games -> 0 (no change yet, that's true).
    const totalGames = (session.wins || 0) + (session.losses || 0);
    const hasRealAnchors =
        Number.isFinite(session.mmrStart) && Number.isFinite(session.mmrCurrent);
    const { winDelta, lossDelta } = mmrEstimateDeltas();
    const estimatesEnabled = winDelta !== 0 || lossDelta !== 0;

    let mmrDelta;
    if (hasRealAnchors) {
        mmrDelta = Math.round(session.mmrCurrent - session.mmrStart);
    } else if (estimatesEnabled) {
        mmrDelta = Number.isFinite(session.mmrDelta) ? session.mmrDelta : 0;
    } else if (totalGames === 0) {
        mmrDelta = 0;
    } else {
        // Games played, no real anchor, no estimate -> we don't know.
        mmrDelta = null;
    }

    return {
        wins: session.wins,
        losses: session.losses,
        mmrDelta,
        // Tell the frontend whether mmrDelta is grounded in real data
        // (Pulse/replay anchors) or only a configured estimate.
        mmrDeltaReal: hasRealAnchors,
        mmrCurrent: session.mmrCurrent,
        league: mmrToLeague(session.mmrCurrent),
        durationText: h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`,
        currentStreak: { ...session.currentStreak },
        metaCounts: { ...session.metaCounts }
    };
}

// ------------------------------------------------------------------
// SC2PULSE INTEGRATION (primary MMR source for ranked games)
// ------------------------------------------------------------------
// Pulls the player's current 1v1 team rating from sc2pulse.nephest.com
// after each match. Replaces the unreliable OCR scanner for ranked
// games. Falls back to the per-game estimate (mmrEstimate) when the
// game was unranked or Pulse hasn't ingested the result yet.
let pulseSeasonId = null;
let pulseCharacterIds = [];
let pulseInitPromise = null;
let pulseLastFetchAt = 0;

function pulseConfig() {
    return (config && config.pulse) || {};
}

function readPublishedCharacterIds() {
    // Reveal-Sc2Opponent.ps1 writes the resolved IDs (either passed
    // via -CharacterId or auto-detected) to character_ids.txt at the
    // project root. This is the single source of truth -- override
    // it in reveal-sc2-opponent.bat by setting SC2_CHARACTER_IDS.
    try {
        if (!fs.existsSync(CHARACTER_IDS_PATH)) return [];
        let raw = fs.readFileSync(CHARACTER_IDS_PATH, 'utf8').trim();
        if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
        if (!raw) return [];
        return raw.split(',')
            .map(s => parseInt(s.trim(), 10))
            .filter(Number.isFinite);
    } catch (_) {
        return [];
    }
}

function autoDetectCharacterIds() {
    // Last-resort fallback if character_ids.txt isn't there yet
    // (PowerShell scanner hasn't run). Mirrors the .ps1 auto-detect
    // logic so the backend can still bootstrap on its own.
    const docs = path.join(os.homedir(), 'Documents', 'StarCraft II', 'Accounts');
    if (!fs.existsSync(docs)) return [];
    const found = new Set();
    function walk(dir, depth) {
        if (depth > 2) return;
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
        for (const e of entries) {
            if (!e.isDirectory()) continue;
            const m = e.name.match(/^\d+-S2-\d+-(\d+)$/);
            if (m) {
                const id = parseInt(m[1], 10);
                if (Number.isFinite(id)) found.add(id);
            } else {
                walk(path.join(dir, e.name), depth + 1);
            }
        }
    }
    walk(docs, 0);
    return [...found];
}

async function fetchPulseSeason() {
    const pc = pulseConfig();
    if (!pc.apiRoot) return null;
    try {
        const res = await fetch(`${pc.apiRoot}/season/list/all`);
        if (!res.ok) return null;
        const seasons = await res.json();
        // Pulse returns seasons keyed by region; pick the highest
        // battlenetId across all regions (== current global season).
        const ids = (Array.isArray(seasons) ? seasons : [])
            .map(s => Number(s.battlenetId))
            .filter(Number.isFinite);
        if (ids.length === 0) return null;
        return Math.max(...ids);
    } catch (err) {
        console.error('[Pulse] season fetch failed:', err.message);
        return null;
    }
}

async function fetchPulseTeams() {
    const pc = pulseConfig();
    if (!pc.enabled) return null;
    if (!pulseSeasonId || pulseCharacterIds.length === 0) return null;
    const ids = pulseCharacterIds.join(',');
    const url = `${pc.apiRoot}/group/team?season=${pulseSeasonId}&queue=${pc.queue}&characterId=${ids}`;
    try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const teams = await res.json();
        return Array.isArray(teams) ? teams : null;
    } catch (err) {
        console.error('[Pulse] team fetch failed:', err.message);
        return null;
    }
}

// Map SC2Pulse region codes to short labels for logging.
const PULSE_REGION_LABEL = { 1: 'NA', 2: 'EU', 3: 'KR', 5: 'CN' };

// Extract the region/race/character info from a Pulse team object so
// we can log which account just got picked. Multi-region users can
// then see at a glance whether their NA or EU rating is being tracked.
function describePulseTeam(team) {
    if (!team) return '?';
    const m = (team.members && team.members[0]) || {};
    const ch = m.character || {};
    const region = PULSE_REGION_LABEL[ch.region] || `R${ch.region ?? '?'}`;
    const race = team.race || (m.zergGamesPlayed ? 'Z'
                            : m.protossGamesPlayed ? 'P'
                            : m.terranGamesPlayed ? 'T'
                            : m.randomGamesPlayed ? 'R' : '?');
    const name = (ch.name || '').split('#')[0] || '?';
    return `${region} ${name} (${race})`;
}

// Pick the team whose rating most likely belongs to "now". Prefer the
// most-recently-played one across all regions; tie-break by highest
// rating. This is what makes multi-region "just work" -- if you switch
// regions, the next match's lastPlayed timestamp moves to that region's
// team and the session widget follows.
function pickActiveTeam(teams) {
    let best = null;
    let bestTime = -1;
    for (const t of teams || []) {
        const r = Number(t.rating);
        if (!Number.isFinite(r)) continue;
        const lp = t.lastPlayed ? Date.parse(t.lastPlayed) : 0;
        if (lp > bestTime || (lp === bestTime && (!best || r > best.rating))) {
            bestTime = lp;
            best = { rating: Math.round(r), lastPlayed: t.lastPlayed, lastPlayedMs: lp, raw: t };
        }
    }
    return best;
}

async function pulseGetActiveRating() {
    const teams = await fetchPulseTeams();
    if (!teams) return null;
    return pickActiveTeam(teams);
}

// Apply a real Pulse rating to the session. Updates anchors, recomputes
// the delta from real values, and broadcasts. `team` is the raw Pulse
// team object (when available) so we can log which region/race got
// picked -- useful for multi-region users to verify the right account
// is being tracked.
function applyPulseRating(rating, sourceTag, team) {
    if (!Number.isFinite(rating)) return false;
    if (session.mmrStart == null) session.mmrStart = rating;
    const prev = Number.isFinite(session.mmrCurrent) ? session.mmrCurrent : null;
    session.mmrCurrent = rating;
    recomputeSessionMmrDelta();
    saveSession();
    broadcastSession();
    if (prev !== null && prev !== rating) {
        emitEvent('mmrDelta', {
            delta: rating - prev,
            current: rating,
            previous: prev,
            source: sourceTag || 'pulse'
        });
    }
    const who = team ? ` ${describePulseTeam(team)}` : '';
    console.log(`[Pulse]${who} MMR=${rating} (delta=${session.mmrDelta}, source=${sourceTag || 'pulse'})`);
    return true;
}

// Schedule a Pulse refresh after a match. If the team's lastPlayed
// timestamp is too stale (game was unranked OR Pulse hasn't ingested
// yet) we retry once or twice, and ultimately leave the per-game
// estimate in place as a fallback.
async function refreshMmrFromPulseAfterMatch() {
    const pc = pulseConfig();
    if (!pc.enabled) return;
    await ensurePulseInitialized();
    if (!pulseSeasonId || pulseCharacterIds.length === 0) {
        console.log('[Pulse] skipping post-match fetch -- not initialized');
        return;
    }
    const matchAt = Date.now();
    const attempts = Math.max(1, Number(pc.retryAttempts) || 1) + 1; // initial + retries
    const retryMs = Math.max(1000, Number(pc.retryDelayMs) || 15000);
    const freshSec = Math.max(60, Number(pc.freshSeconds) || 600);
    // Snapshot what we had BEFORE the post-match fetch so we can
    // detect a real Pulse update vs. "got the same number back".
    const ratingBefore = session.mmrCurrent;

    console.log(`[Pulse] post-match: starting ${attempts}-attempt fetch chain (delay=${retryMs}ms, freshSec=${freshSec})`);

    for (let i = 0; i < attempts; i++) {
        const team = await pulseGetActiveRating();
        if (team) {
            const ageSinceMatchSec = (Date.now() - team.lastPlayedMs) / 1000;
            const lastPlayedAfterMatch = team.lastPlayedMs >= (matchAt - 5000);
            const ratingChanged = Number.isFinite(ratingBefore) && team.rating !== ratingBefore;
            console.log(
                `[Pulse] attempt ${i + 1}/${attempts}: ${describePulseTeam(team.raw)} ` +
                `rating=${team.rating} (was ${ratingBefore ?? '?'}, ` +
                `changed=${ratingChanged}, lastPlayed=${Math.round(ageSinceMatchSec)}s ago, ` +
                `afterMatch=${lastPlayedAfterMatch})`
            );
            // Accept the reading if EITHER the timestamp moved past
            // match start (definitive), OR the rating actually changed
            // (Pulse may not have refreshed lastPlayed instantly), OR
            // we're under the freshness cap.
            if (lastPlayedAfterMatch || ratingChanged || ageSinceMatchSec <= freshSec) {
                applyPulseRating(team.rating, 'pulse:post-match', team.raw);
                pulseLastFetchAt = Date.now();
                return;
            }
        } else {
            console.log(`[Pulse] attempt ${i + 1}/${attempts}: no team returned from API`);
        }
        if (i < attempts - 1) await new Promise(r => setTimeout(r, retryMs));
    }
    // All attempts came back stale -- the game we just finished was
    // probably unranked. The per-game estimate already applied in
    // /api/replay stays in place as the fallback.
    console.log('[Pulse] post-match readings stayed stale -- treating as unranked, keeping estimate');
}

async function ensurePulseInitialized() {
    if (pulseInitPromise) return pulseInitPromise;
    pulseInitPromise = (async () => {
        const pc = pulseConfig();
        if (!pc.enabled) return;
        // Resolve characterIds in priority order:
        //   1. overlay.config.json -> pulse.characterIds (explicit override)
        //   2. character_ids.txt    (published by Reveal-Sc2Opponent.ps1
        //                           -- this is the single source of truth)
        //   3. local SC2 Documents folder (last-resort auto-detect, in
        //      case the PowerShell scanner hasn't run yet)
        let source = 'config';
        if (Array.isArray(pc.characterIds) && pc.characterIds.length) {
            pulseCharacterIds = pc.characterIds.map(Number).filter(Number.isFinite);
        } else {
            const published = readPublishedCharacterIds();
            if (published.length) {
                pulseCharacterIds = published;
                source = 'character_ids.txt';
            } else {
                pulseCharacterIds = autoDetectCharacterIds();
                source = 'auto-detect';
            }
        }
        if (pulseCharacterIds.length === 0) {
            console.log('[Pulse] no characterIds found. Run reveal-sc2-opponent.bat first (it publishes character_ids.txt), or set SC2_CHARACTER_IDS in the .bat, or set pulse.characterIds in overlay.config.json.');
            return;
        }
        console.log(`[Pulse] characterIds (${source}): ${pulseCharacterIds.join(', ')}`);
        pulseSeasonId = await fetchPulseSeason();
        if (!pulseSeasonId) {
            console.log('[Pulse] could not resolve current season. Pulse fetches will be skipped until next init.');
            // Allow a future retry by clearing the cached promise.
            pulseInitPromise = null;
            return;
        }
        console.log(`[Pulse] season=${pulseSeasonId}`);

        // Seed mmrStart with the player's current Pulse rating so the
        // session widget has a real baseline before the first match.
        const team = await pulseGetActiveRating();
        if (team) applyPulseRating(team.rating, 'pulse:init', team.raw);
    })().catch(err => {
        console.error('[Pulse] init failed:', err.message);
        pulseInitPromise = null;
    });
    return pulseInitPromise;
}

// ------------------------------------------------------------------
// HISTORY HELPERS
// ------------------------------------------------------------------
function readHistory() {
    try {
        if (!fs.existsSync(HISTORY_FILE_PATH)) return {};
        let raw = fs.readFileSync(HISTORY_FILE_PATH, 'utf8');
        if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
        return JSON.parse(raw);
    } catch (err) {
        console.error('[History] Read failed:', err.message);
        return {};
    }
}

function stripClanTag(name) {
    if (!name) return name;
    return name.includes(']') ? name.split(']').pop().trim() : name;
}

// Strip the BattleTag discriminator ("#1234") off the end of a name.
// SC2Pulse stores names with the discriminator ("Player#1234") but the
// overlay's opponent parser sometimes drops it. We need both forms to
// compare cleanly so rematches against known opponents are recognized.
function stripDiscriminator(name) {
    if (!name) return name;
    const i = name.lastIndexOf('#');
    return i >= 0 ? name.slice(0, i) : name;
}

// Build the set of "comparable" forms for a name: lowercased original,
// without clan tag, without BattleTag discriminator, and without both.
// Two names match if any pair from their respective sets matches.
function nameForms(name) {
    if (!name) return new Set();
    const out = new Set();
    const add = (s) => { if (s) out.add(s.toLowerCase().trim()); };
    add(name);
    const noClan = stripClanTag(name);
    add(noClan);
    add(stripDiscriminator(name));
    add(stripDiscriminator(noClan));
    return out;
}

function findOpponentByName(history, nameNeedle) {
    if (!nameNeedle) return null;
    const needleForms = nameForms(nameNeedle);
    if (needleForms.size === 0) return null;
    // First pass: exact match across any normalized form. This is
    // what catches "Player#1234" in history vs "Player" in
    // opponent.txt, or vice versa.
    for (const pulseId of Object.keys(history)) {
        const data = history[pulseId] || {};
        const rawName = data.Name || '';
        const recordForms = nameForms(rawName);
        for (const f of needleForms) {
            if (recordForms.has(f)) {
                return { pulseId, data, cleanName: stripClanTag(rawName) };
            }
        }
    }
    return null;
}

function flattenGames(oppRecord) {
    const games = [];
    if (Array.isArray(oppRecord.Games)) {
        for (const g of oppRecord.Games) games.push({ ...g });
    }
    if (oppRecord.Matchups) {
        for (const mu of Object.keys(oppRecord.Matchups)) {
            const list = oppRecord.Matchups[mu].Games || [];
            for (const g of list) games.push({ ...g, Matchup: mu });
        }
    }
    return games;
}

function computeRecord(oppRecord) {
    let w = oppRecord.Wins || 0;
    let l = oppRecord.Losses || 0;
    if (oppRecord.Matchups) {
        for (const mu of Object.keys(oppRecord.Matchups)) {
            w += oppRecord.Matchups[mu].Wins || 0;
            l += oppRecord.Matchups[mu].Losses || 0;
        }
    }
    const total = w + l;
    const winRate = total > 0 ? Math.round((w / total) * 100) : 0;
    return { wins: w, losses: l, total, winRate };
}

function formatMatchDuration(totalSeconds) {
    if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return null;
    const m = Math.floor(totalSeconds / 60);
    const s = Math.floor(totalSeconds % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
}

function detectCheeseHistory(oppName) {
    const cheeseMax = config.events.cheeseHistory?.cheeseMaxSeconds ?? 300;
    const history = readHistory();
    const found = findOpponentByName(history, oppName);
    if (!found) return null;

    const games = flattenGames(found.data)
        .filter(g => Number.isFinite(g.Duration) && g.Duration > 0)
        .sort((a, b) => (b.Date || '').localeCompare(a.Date || ''));

    const cheese = games.find(g => g.Duration <= cheeseMax);
    if (!cheese) return null;

    return {
        opponent: found.cleanName,
        result: cheese.Result,
        map: cheese.Map || 'unknown map',
        duration: cheese.Duration,
        durationText: formatMatchDuration(cheese.Duration),
        date: cheese.Date || null,
        matchup: cheese.Matchup || null
    };
}

function buildRematchSummary(oppName) {
    const history = readHistory();
    const found = findOpponentByName(history, oppName);
    if (!found) return null;
    const rec = computeRecord(found.data);
    if (rec.total === 0) return null;
    return {
        opponent: found.cleanName,
        wins: rec.wins,
        losses: rec.losses,
        total: rec.total,
        winRate: rec.winRate,
        race: found.data.Race || null
    };
}

// Detect a "rival" -- an opponent we've played at least minGames
// times. Returns null if not a rival yet.
function detectRival(oppName) {
    const minGames = config.events.rivalAlert?.minGames ?? 5;
    const history = readHistory();
    const found = findOpponentByName(history, oppName);
    if (!found) return null;
    const rec = computeRecord(found.data);
    if (rec.total < minGames) return null;
    // Find the most recent meeting, if any, for the "tagline".
    const games = flattenGames(found.data)
        .sort((a, b) => (b.Date || '').localeCompare(a.Date || ''));
    const lastResult = games[0]?.Result || null;
    return {
        opponent: found.cleanName,
        wins: rec.wins,
        losses: rec.losses,
        total: rec.total,
        winRate: rec.winRate,
        race: found.data.Race || null,
        lastResult,
        tier: rec.total >= 20 ? 'nemesis'
            : rec.total >= 10 ? 'rival'
            : 'familiar'
    };
}

// ------------------------------------------------------------------
// F1: FAVORITE OPENING (most-frequent opp_strategy from history)
// ------------------------------------------------------------------
function detectFavoriteOpening(oppName) {
    const minGames = config.events.favoriteOpening?.minGames ?? 2;
    const history = readHistory();
    const found = findOpponentByName(history, oppName);
    if (!found) return null;

    const games = flattenGames(found.data).filter(g => g.opp_strategy);
    if (games.length < minGames) return null;

    const tally = {};
    for (const g of games) {
        const s = g.opp_strategy;
        tally[s] = (tally[s] || 0) + 1;
    }
    const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    if (ranked.length === 0) return null;

    const [topStrat, topCount] = ranked[0];
    const total = games.length;
    return {
        opponent: found.cleanName,
        strategy: topStrat,
        count: topCount,
        totalSeen: total,
        sharePct: Math.round((topCount / total) * 100)
    };
}

// ------------------------------------------------------------------
// F2: BEST ANSWER (my_build with best WR vs that opp_strategy)
// Reads the analyzer DB (meta_database.json) so the same numbers
// the analyzer GUI shows are the ones we surface live.
// ------------------------------------------------------------------
const META_DB_PATH = path.join(DATA_DIR, 'meta_database.json');

function readMetaDb() {
    try {
        if (!fs.existsSync(META_DB_PATH)) return null;
        let raw = fs.readFileSync(META_DB_PATH, 'utf8');
        if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
        return JSON.parse(raw);
    } catch (err) {
        console.error('[MetaDB] Read failed:', err.message);
        return null;
    }
}

function detectBestAnswer(oppStrategy, myRace) {
    const minSamples = config.events.bestAnswer?.minSamples ?? 2;
    const db = readMetaDb();
    if (!db || !oppStrategy) return null;

    const candidates = [];
    for (const [buildName, bd] of Object.entries(db)) {
        if (myRace && !buildName.startsWith(`Pv${myRace[0]?.toUpperCase()}`)
            && !buildName.startsWith(myRace[0]?.toUpperCase() + 'v')) {
            // We do a soft race filter: don't show a Protoss build to a Zerg
            // user. Builds whose name doesn't carry a matchup prefix still
            // pass through.
        }
        const games = (bd.games || []).filter(g => g.opp_strategy === oppStrategy);
        if (games.length < minSamples) continue;
        const w = games.filter(g => g.result === 'Win').length;
        const l = games.filter(g => g.result === 'Loss').length;
        const total = w + l;
        if (total === 0) continue;
        candidates.push({
            build: buildName,
            wins: w,
            losses: l,
            total,
            winRate: w / total
        });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (b.winRate - a.winRate) || (b.total - a.total));
    const top = candidates[0];
    return {
        oppStrategy,
        build: top.build,
        wins: top.wins,
        losses: top.losses,
        total: top.total,
        winRatePct: Math.round(top.winRate * 100)
    };
}

// ------------------------------------------------------------------
// EXPRESS + SOCKET.IO
// ------------------------------------------------------------------
const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));

if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
if (!fs.existsSync(SOUNDS_DIR)) fs.mkdirSync(SOUNDS_DIR, { recursive: true });
app.use('/static', express.static(PUBLIC_DIR));

// Expose the SC2-Overlay icon library at `/static/icons/...` so the
// analyzer SPA can render building / race PNGs from the same canonical
// folder the desktop GUI uses. The `MedianTimingsGrid` component in
// public/analyzer/index.html resolves icons via `buildingIconUrl()` ->
// `/static/icons/buildings/<icon_file>`.
const SC2_OVERLAY_ICONS_DIR = path.join(ROOT, 'SC2-Overlay', 'icons');
if (fs.existsSync(SC2_OVERLAY_ICONS_DIR)) {
    app.use('/static/icons', express.static(SC2_OVERLAY_ICONS_DIR, {
        fallthrough: true,
        maxAge: '7d',
    }));
}

// ------------------------------------------------------------------
// ATOMIC JSON WRITER
// ------------------------------------------------------------------
// Wraps fs.writeFileSync(path, data) with a tmp + rename pattern so a
// process kill mid-flush can't leave a half-written JSON file on disk
// (the bug that left meta_database.json / MyOpponentHistory.json /
// overlay.config.json truncated in 04/2026). Mirrors the semantics of
// `core.atomic_io.atomic_write_json` on the Python side.
function _atomicWriteJsonSync(target, data, indent = 2) {
    const dir = path.dirname(target);
    fs.mkdirSync(dir, { recursive: true });
    // Pick a unique sibling temp filename. We avoid os.tmpdir so the
    // os.rename below can be atomic (same-filesystem requirement).
    const tmp = path.join(
        dir,
        '.tmp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10) + '.json'
    );
    try {
        const body = JSON.stringify(data, null, indent);
        fs.writeFileSync(tmp, body);
        fs.renameSync(tmp, target);
    } catch (err) {
        try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
        throw err;
    }
}

// ------------------------------------------------------------------
// META ANALYZER API + SPA
// ------------------------------------------------------------------
// Mount the analyzer router (JSON aggregations of meta_database.json
// and MyOpponentHistory.json) and serve the React-based web UI from
// public/analyzer. The .bat opens http://localhost:3000/analyzer.
app.use('/api/analyzer', analyzer.router);
app.get('/analyzer', (_req, res) =>
    res.sendFile(path.join(PUBLIC_DIR, 'analyzer', 'index.html')));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

const EVENT_CHANNEL = 'overlay_event';

function emitEvent(type, payload, opts = {}) {
    const cfg = (config.events && config.events[type]) || {};
    if (cfg.enabled === false) {
        console.log(`[Event] ${type} is disabled in config -- skipping`);
        return null;
    }
    const envelope = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type,
        payload: payload || {},
        durationMs: opts.durationMs ?? cfg.durationMs ?? 10000,
        priority:   opts.priority   ?? cfg.priority   ?? 5,
        timestamp: Date.now()
    };
    io.emit(EVENT_CHANNEL, envelope);
    console.log(`[Event] -> ${type}  (id=${envelope.id}, prio=${envelope.priority})`);

    // Back-compat shims for the original single-purpose channels:
    if (type === 'matchResult')      io.emit('new_match_result', payload);
    if (type === 'opponentDetected') io.emit('opponent_update', payload?.text || '');
    return envelope;
}

function broadcastSession() {
    io.emit('session_state', sessionSnapshot());
}

io.on('connection', (socket) => {
    console.log(`[Socket.io] Client connected: ${socket.id}`);
    socket.emit('session_state', sessionSnapshot());
    socket.emit('config_snapshot', config);
});

// ------------------------------------------------------------------
// LIVE REPLAY WEBHOOK (from replay_watcher.py, fast path)
// ------------------------------------------------------------------
app.post('/api/replay', (req, res) => {
    const r = req.body || {};
    console.log('[API] /api/replay received:', r);

    const result = r.result;
    const isWin  = result === 'Victory';
    const isLoss = result === 'Defeat';

    // Session totals
    if (isWin) session.wins += 1;
    if (isLoss) session.losses += 1;

    // MMR tracking
    if (Number.isFinite(r.myMmr)) {
        if (session.mmrStart == null) session.mmrStart = r.myMmr;
        const prev = session.mmrCurrent;

        // r.myMmr is the pre-match MMR. Add estimate for immediate post-match feedback
        const { winDelta, lossDelta } = mmrEstimateDeltas();
        const matchDelta = isWin ? winDelta : (isLoss ? lossDelta : 0);

        session.mmrCurrent = r.myMmr + matchDelta;
        recomputeSessionMmrDelta();

        if (Number.isFinite(prev) && prev !== session.mmrCurrent) {
            emitEvent('mmrDelta', {
                delta: session.mmrCurrent - prev,
                current: session.mmrCurrent,
                previous: prev,
                estimated: matchDelta !== 0
            });
        }
    } else if (isWin || isLoss) {
        // sc2reader couldn't read scaled_rating from this replay
        // (common with newer SC2 replay formats). Apply a configurable
        // per-game estimate so the session widget keeps moving. The
        // post-match SC2Pulse fetch (scheduled below) will overwrite
        // this with the real rating for ranked games; for unranked
        // games the estimate stays in place.
        const { winDelta, lossDelta } = mmrEstimateDeltas();
        const delta = isWin ? winDelta : lossDelta;
        const prev = Number.isFinite(session.mmrCurrent) ? session.mmrCurrent : null;
        if (Number.isFinite(session.mmrCurrent)) {
            session.mmrCurrent = session.mmrCurrent + delta;
        }
        // mmrStart stays at whatever Pulse/OCR seeded it as. If we
        // never had a baseline at all, the absolute anchors stay null
        // and only the cumulative mmrDelta moves -- league icon will
        // simply not render until a real reading lands.
        session.mmrDelta = (Number.isFinite(session.mmrDelta) ? session.mmrDelta : 0) + delta;
        emitEvent('mmrDelta', {
            delta,
            current: session.mmrCurrent,
            previous: prev,
            estimated: true
        });
    }

    session.lastResultTime = Date.now();

    // Streak
    const streak = updateStreak(result);
    saveSession();
    broadcastSession();

    // Schedule a SC2Pulse fetch for the authoritative post-match MMR.
    // Runs out-of-band so we don't block the response. If the game was
    // ranked, this will replace the estimate above with the real
    // rating; if unranked, the estimate stays.
    if (isWin || isLoss) {
        const pc = pulseConfig();
        if (pc.enabled) {
            const delay = Math.max(0, Number(pc.fetchDelayMs) || 12000);
            setTimeout(() => {
                refreshMmrFromPulseAfterMatch().catch(err =>
                    console.error('[Pulse] post-match refresh error:', err.message));
            }, delay);
        }
    }

    // Match result pop-up
    emitEvent('matchResult', {
        myRace: r.myRace,
        oppRace: r.oppRace,
        map: r.map,
        result: r.result,
        oppName: r.oppName,
        duration: r.duration ?? null,
        durationText: formatMatchDuration(r.duration)
    });

    // Streak pop-up
    const sm = streakMessage(streak);
    if (sm) emitEvent('streak', { ...sm, count: streak.count, type: streak.type });

    res.status(200).json({ ok: true });
});

// ------------------------------------------------------------------
// DEEP REPLAY WEBHOOK (from replay_watcher.py, threaded slow path)
// Receives strategy detection + build logs once the deep parse is done.
// Drives F3 (post-game reveal), feeds F4 (!build), updates F5 (metaCheck).
// ------------------------------------------------------------------
const lastDeepByOpponent = new Map();    // oppName.lower() -> deep payload
let lastOwnEarlyBuildLog = [];           // most-recent first-5-min build log
let lastOwnDeep = null;                  // metadata for !meta

app.post('/api/replay/deep', (req, res) => {
    const d = req.body || {};
    console.log('[API] /api/replay/deep received:',
        { gameId: d.gameId, myBuild: d.myBuild, oppStrategy: d.oppStrategy,
          earlyLog: Array.isArray(d.earlyBuildLog) ? d.earlyBuildLog.length : 0 });

    if (Array.isArray(d.earlyBuildLog) && d.earlyBuildLog.length > 0) {
        lastOwnEarlyBuildLog = d.earlyBuildLog;
    }
    lastOwnDeep = {
        myBuild: d.myBuild,
        myRace: d.myRace,
        oppStrategy: d.oppStrategy,
        oppName: d.oppName,
        gameId: d.gameId,
        when: Date.now()
    };

    if (d.oppName) {
        lastDeepByOpponent.set(stripClanTag(d.oppName).toLowerCase(), d);
    }

    // F3 post-game reveal -- always emit so the streamer/chat sees what
    // the opp was actually doing. Includes the first-5-min build log
    // (already trimmed to early game by the watcher) so the front-end
    // can animate the timeline icon-by-icon.
    if (d.oppStrategy) {
        emitEvent('postGameStrategyReveal', {
            opponent: stripClanTag(d.oppName || 'Opponent'),
            oppRace: d.oppRace || null,
            strategy: d.oppStrategy,
            myBuild: d.myBuild,
            map: d.map,
            result: d.result,
            // OPPONENT's deduped first-5-min build (real milestones).
            // The frontend timeline animates these icons.
            oppEarlyBuildLog: Array.isArray(d.oppEarlyBuildLog) ? d.oppEarlyBuildLog : [],
            // Keep YOUR earlyBuildLog around too in case a custom UI wants it.
            earlyBuildLog: Array.isArray(d.earlyBuildLog) ? d.earlyBuildLog : []
        });
    }

    // F5 meta check -- count this opp_strategy in the session tally and
    // emit if this is now the streamer's most-faced opener.
    if (d.oppStrategy) {
        session.metaCounts[d.oppStrategy] = (session.metaCounts[d.oppStrategy] || 0) + 1;
        const ranked = Object.entries(session.metaCounts).sort((a, b) => b[1] - a[1]);
        const [topStrat, topCount] = ranked[0] || [null, 0];
        if (topStrat && topCount >= 2) {
            emitEvent('metaCheck', {
                strategy: topStrat,
                count: topCount,
                sessionTotal: ranked.reduce((s, [, c]) => s + c, 0),
                isCurrent: topStrat === d.oppStrategy
            });
        }
        saveSession();
        broadcastSession();
    }

    res.json({ ok: true });
});

function updateStreak(result) {
    const type = result === 'Victory' ? 'win'
               : result === 'Defeat'  ? 'loss'
               : null;
    if (!type) return session.currentStreak;

    if (session.currentStreak.type === type) {
        session.currentStreak.count += 1;
    } else {
        session.currentStreak = { type, count: 1 };
    }
    return session.currentStreak;
}

function streakMessage(streak) {
    if (streak.type === 'win') {
        if (streak.count >= 10) return { tier: 'rampage',    text: 'RAMPAGE',    subtext: `${streak.count} wins in a row` };
        if (streak.count >= 5)  return { tier: 'on-fire',    text: 'ON FIRE',    subtext: `${streak.count} wins in a row` };
        if (streak.count >= 3)  return { tier: 'heating-up', text: 'HEATING UP', subtext: `${streak.count} wins in a row` };
        return null;
    }
    if (streak.type === 'loss') {
        if (streak.count >= 3) return { tier: 'tilt-warn',   text: 'GLHF NEXT ONE', subtext: 'Shake it off' };
        if (streak.count >= 1) return { tier: 'gg-go-again', text: 'GG GO AGAIN',   subtext: 'One more' };
    }
    return null;
}

// ------------------------------------------------------------------
// SESSION API
// ------------------------------------------------------------------
app.get('/api/session', (_req, res) => res.json(sessionSnapshot()));

app.post('/api/session/reset', (_req, res) => {
    // #5 Generate the recap PNG BEFORE wiping the session, while we
    // still have the data. spawnSync so the PNG is on disk by the time
    // the response goes out.
    try { generateRecapPng(); } catch (err) {
        console.error('[Recap] Failed before reset:', err.message);
    }
    session = defaultSession();
    saveSession();
    broadcastSession();
    console.log('[Session] Reset via API.');
    // Re-seed mmrStart from current Pulse rating so the next session
    // has a real baseline immediately.
    if (pulseConfig().enabled) {
        pulseGetActiveRating()
            .then(team => team && applyPulseRating(team.rating, 'pulse:reset', team.raw))
            .catch(err => console.error('[Pulse] reset reseed error:', err.message));
    }
    res.json({ ok: true, session: sessionSnapshot(), recap: '/static/recap.png' });
});

// Manual Pulse refresh (debugging helper). Useful for testing or
// after a long idle, to re-anchor session MMR to the live rating.
app.post('/api/pulse/refresh', async (_req, res) => {
    try {
        await ensurePulseInitialized();
        const team = await pulseGetActiveRating();
        if (!team) {
            return res.status(503).json({
                ok: false,
                error: 'Pulse fetch returned no teams',
                characterIds: pulseCharacterIds,
                seasonId: pulseSeasonId
            });
        }
        applyPulseRating(team.rating, 'pulse:manual', team.raw);
        res.json({ ok: true, rating: team.rating, lastPlayed: team.lastPlayed });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// Diagnose: dump raw Pulse state so the user can SEE what the API
// returns for their character IDs. No mutations -- pure inspection.
app.get('/api/pulse/diagnose', async (_req, res) => {
    try {
        await ensurePulseInitialized();
        const teams = await fetchPulseTeams();
        const active = teams ? pickActiveTeam(teams) : null;
        const summary = (teams || []).map(t => {
            const m = (t.members && t.members[0]) || {};
            const ch = m.character || {};
            return {
                rating: t.rating,
                lastPlayed: t.lastPlayed,
                ageSec: t.lastPlayed ? Math.round((Date.now() - Date.parse(t.lastPlayed)) / 1000) : null,
                region: PULSE_REGION_LABEL[ch.region] || ch.region,
                race: t.race,
                wins: t.wins, losses: t.losses,
                charName: ch.name, charId: ch.battlenetId || ch.id,
            };
        });
        res.json({
            ok: true,
            seasonId: pulseSeasonId,
            characterIds: pulseCharacterIds,
            sessionMmrStart: session.mmrStart,
            sessionMmrCurrent: session.mmrCurrent,
            sessionMmrDelta: session.mmrDelta,
            teamsReturned: (teams || []).length,
            activePicked: active ? describePulseTeam(active.raw) + ' rating=' + active.rating : null,
            teams: summary,
        });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// On-demand recap (without wiping the session). Useful for testing.
app.post('/api/session/recap', (_req, res) => {
    try {
        const r = generateRecapPng();
        res.json({ ok: true, recap: '/static/recap.png', stdout: r });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// Spawn the Python recap generator. Resolves to its stdout for diagnostics.
function generateRecapPng() {
    const { spawnSync } = require('child_process');
    const script = path.join(ROOT, 'scripts', 'generate_session_recap.py');
    if (!fs.existsSync(script)) {
        console.warn('[Recap] script missing:', script);
        return '';
    }
    // Try pythonw first (no console pop-up), fall back to python.
    const candidates = ['pythonw', 'python', 'python3'];
    for (const exe of candidates) {
        try {
            const r = spawnSync(exe, [script], { encoding: 'utf8', timeout: 20000 });
            if (r.status === 0) {
                console.log('[Recap]', (r.stdout || '').trim());
                return r.stdout || '';
            }
            if (r.error && r.error.code === 'ENOENT') continue;
        } catch (_) {}
    }
    console.warn('[Recap] no Python interpreter on PATH');
    return '';
}

// Expose data/recap.png at /static/recap.png for OBS / chat sharing.
app.get('/static/recap.png', (_req, res) => {
    const recapPath = path.join(ROOT, 'data', 'recap.png');
    if (!fs.existsSync(recapPath)) {
        return res.status(404).send('No recap yet -- finish a session first.');
    }
    res.sendFile(recapPath);
});

// ------------------------------------------------------------------
// CONFIG API
// ------------------------------------------------------------------
app.get('/api/config', (_req, res) => res.json(config));

app.post('/api/config', (req, res) => {
    try {
        config = deepMerge(config, req.body || {});
        _atomicWriteJsonSync(CONFIG_PATH, config, 2);
        io.emit('config_snapshot', config);
        console.log('[Config] Updated via API.');
        res.json({ ok: true, config });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ------------------------------------------------------------------
// DEV TEST API
// ------------------------------------------------------------------
app.post('/api/test/event', (req, res) => {
    const { type, payload, durationMs, priority } = req.body || {};
    if (!type) return res.status(400).json({ error: 'type required' });
    const env = emitEvent(type, payload, { durationMs, priority });
    res.json({ ok: true, event: env });
});

// ------------------------------------------------------------------
// OPPONENT FILE WATCHER (pre-game hooks)
// ------------------------------------------------------------------
function parseFirstOpponentName(line) {
    if (!line) return null;
    const firstChunk = line.split(',')[0] || line;
    const cleaned = firstChunk
        .replace(/\(.*?\)/g, '')
        .replace(/\[.*?\]/g, '')
        .trim();
    return cleaned || null;
}

function parseMyRaceFromOpponentLine(line) {
    // Some scanners write "<Opp>, MyRace=Protoss" -- pluck it if present.
    const m = (line || '').match(/MyRace\s*=\s*(Zerg|Protoss|Terran)/i);
    return m ? m[1] : null;
}

// Pull the opponent's MMR (a 3-or-4-digit number, typically wrapped
// in parentheses or brackets) out of the opponent.txt line. Examples
// the PowerShell scanner produces:
//   "ScrubBoss42(2840) Z"
//   "ScrubBoss42 [2840] Zerg"
//   "ScrubBoss42 (2840) Zerg, MyRace=Protoss"
function parseOpponentMmr(line) {
    if (!line) return null;
    // Prefer a number inside () or [] (race-format short keeps these).
    let m = String(line).match(/[\(\[]\s*(\d{3,5})\s*[\)\]]/);
    if (m) return parseInt(m[1], 10);
    // Fallback: any standalone 3-5 digit number.
    m = String(line).match(/\b(\d{3,5})\b/);
    return m ? parseInt(m[1], 10) : null;
}

// Pull the opponent's race. Looks for Z/P/T or full Zerg/Protoss/Terran
// somewhere in the line, but ignores it if it's actually MyRace=...
function parseOpponentRace(line) {
    if (!line) return null;
    // Strip any MyRace=... segment so it can't hijack the match.
    const cleaned = String(line).replace(/MyRace\s*=\s*\w+/ig, '');
    // Look for the longest race word first.
    let m = cleaned.match(/\b(Zerg|Protoss|Terran|Random)\b/i);
    if (m) return m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
    // Fall back to the short letter (must be followed by end/punctuation
    // so we don't grab the first letter of the player name).
    m = cleaned.match(/(?:^|[\s,\)\]])([ZPTR])(?:[\s,]|$)/);
    if (m) {
        const letter = m[1].toUpperCase();
        return ({ Z: 'Zerg', P: 'Protoss', T: 'Terran', R: 'Random' })[letter] || null;
    }
    return null;
}

let lastOpponentText = '';
fs.watchFile(OPPONENT_FILE_PATH, { interval: 1000 }, () => {
    try {
        if (!fs.existsSync(OPPONENT_FILE_PATH)) return;
        const raw = fs.readFileSync(OPPONENT_FILE_PATH, 'utf8').trim();
        if (!raw || raw === lastOpponentText) return;
        lastOpponentText = raw;
        console.log(`[Scanner] Opponent file changed: ${raw}`);

        const oppMmr  = parseOpponentMmr(raw);
        const oppRace = parseOpponentRace(raw);
        const oppName = parseFirstOpponentName(raw);
        const myRace  = parseMyRaceFromOpponentLine(raw);

        // Look up our head-to-head record so the merged opponent
        // widget can show "Z 2840 MMR | 5W-3L (62%)" in one line.
        const rematch = oppName ? buildRematchSummary(oppName) : null;

        emitEvent('opponentDetected', {
            text: raw,
            opponent: oppName,
            mmr: oppMmr,
            race: oppRace || (rematch && rematch.race) || null,
            record: rematch ? {
                wins: rematch.wins,
                losses: rematch.losses,
                total: rematch.total,
                winRate: rematch.winRate
            } : null
        });

        // Keep the standalone rematch event for back-compat with any
        // separate rematch widget the user might still have on screen.
        if (rematch) emitEvent('rematch', rematch);

        if (!oppName) return;

        const cheese = detectCheeseHistory(oppName);
        if (cheese) emitEvent('cheeseHistory', cheese);

        // F1 favorite opening
        const fav = detectFavoriteOpening(oppName);
        let bestAns = null;
        if (fav) {
            emitEvent('favoriteOpening', fav);
            bestAns = detectBestAnswer(fav.strategy, myRace);
            if (bestAns) emitEvent('bestAnswer', { ...bestAns, opponent: fav.opponent });
        }

        // #6 rival alert (priority 9, fires for opponents played >= minGames times)
        const rival = detectRival(oppName);
        if (rival) emitEvent('rivalAlert', rival);

        // #1 unified scouting report -- consolidates everything we know
        // into one big card. The individual events above still fire for
        // back-compat with old overlay clients, but the new overlay can
        // ignore them in favor of this single coherent payload.
        if (rematch || fav || cheese || rival || oppRace || Number.isFinite(oppMmr)) {
            emitEvent('scoutingReport', {
                opponent: rematch?.opponent || fav?.opponent || rival?.opponent || oppName,
                race: oppRace || rematch?.race || rival?.race || null,
                mmr: Number.isFinite(oppMmr) ? oppMmr : null,
                record: rematch ? {
                    wins: rematch.wins,
                    losses: rematch.losses,
                    total: rematch.total,
                    winRate: rematch.winRate
                } : null,
                rival: rival ? {
                    tier: rival.tier,
                    lastResult: rival.lastResult
                } : null,
                favoriteOpening: fav ? {
                    strategy: fav.strategy,
                    sharePct: fav.sharePct,
                    count: fav.count,
                    totalSeen: fav.totalSeen
                } : null,
                bestAnswer: bestAns ? {
                    build: bestAns.build,
                    winRatePct: bestAns.winRatePct,
                    wins: bestAns.wins,
                    losses: bestAns.losses,
                    total: bestAns.total
                } : null,
                cheese: cheese ? {
                    result: cheese.result,
                    map: cheese.map,
                    durationText: cheese.durationText
                } : null
            });
        }
    } catch (err) {
        console.error('[Scanner] Error:', err.message);
    }
});

// ------------------------------------------------------------------
// MMR SCANNER WATCHER (updates current MMR from OCR)
// ------------------------------------------------------------------
let lastScannedMmr = '';
fs.watchFile(SCANNED_MMR_PATH, { interval: 1500 }, () => {
    try {
        if (!fs.existsSync(SCANNED_MMR_PATH)) return;
        const raw = fs.readFileSync(SCANNED_MMR_PATH, 'utf8').trim();
        if (!raw || raw === lastScannedMmr) return;
        lastScannedMmr = raw;

        const numbers = raw.split(',')
            .map(s => parseInt(s.trim(), 10))
            .filter(n => Number.isFinite(n) && n >= 1000 && n <= 8000);
        if (numbers.length === 0) return;

        let mine;
        if (Number.isFinite(session.mmrCurrent)) {
            mine = numbers.reduce((best, n) =>
                Math.abs(n - session.mmrCurrent) < Math.abs(best - session.mmrCurrent) ? n : best,
                numbers[0]);
        } else {
            mine = numbers[0];
        }

        if (session.mmrStart == null) session.mmrStart = mine;
        session.mmrCurrent = mine;
        saveSession();
        broadcastSession();
        console.log(`[Scanner] MMR updated from OCR: ${mine} (all=${raw})`);
    } catch (err) {
        console.error('[Scanner] MMR watcher error:', err.message);
    }
});

// ------------------------------------------------------------------
// TWITCH BOT
// ------------------------------------------------------------------
let twitchClient = null;

function startTwitch() {
    if (!config.twitch?.enabled) {
        console.log('[Twitch] Disabled in config.');
        return;
    }
    if (!process.env.TWITCH_OAUTH_TOKEN || !process.env.TWITCH_USERNAME || !process.env.TWITCH_CHANNEL) {
        console.log('[Twitch] Env vars missing. Skipping.');
        return;
    }

    twitchClient = new tmi.Client({
        options: { debug: false },
        connection: { reconnect: true, secure: true },
        identity: {
            username: process.env.TWITCH_USERNAME,
            password: process.env.TWITCH_OAUTH_TOKEN
        },
        channels: [process.env.TWITCH_CHANNEL]
    });

    twitchClient.connect()
        .then(() => console.log(`[Twitch] Connected to #${process.env.TWITCH_CHANNEL}`))
        .catch(err => console.error('[Twitch] Connect failed:', err.message));

    twitchClient.on('message', (channel, tags, message, self) => {
        if (self) return;
        const msg = message.trim();
        const lower = msg.toLowerCase();

        // !session / !record
        if (lower === '!session' || lower === '!record') {
            const s = sessionSnapshot();
            const mmr = s.mmrDelta === 0 ? '' : ` (${s.mmrDelta >= 0 ? '+' : ''}${s.mmrDelta} MMR)`;
            const lg  = s.league ? ` [${s.league}]` : '';
            twitchClient.say(channel, `Session${lg}: ${s.wins}W-${s.losses}L${mmr} - ${s.durationText}`);
            return;
        }

        // !build -- post latest first-5-min build inline + link
        if (lower === '!build') {
            if (!lastOwnEarlyBuildLog || lastOwnEarlyBuildLog.length === 0) {
                twitchClient.say(channel, `@${tags.username}, no build on record yet -- play a game first.`);
                return;
            }
            const reply = lastOwnEarlyBuildLog.slice(0, 30).join(' -> ');
            const prefix = lastOwnDeep?.myBuild ? `[${lastOwnDeep.myBuild}] ` : '';
            const link = `http://localhost:3000/static/last-build.html`;
            twitchClient.say(channel, `${prefix}${reply}  | full build: ${link}`);
            return;
        }

        // !meta -- session opp_strategy tally
        if (lower === '!meta') {
            const ranked = Object.entries(session.metaCounts || {}).sort((a, b) => b[1] - a[1]);
            if (ranked.length === 0) {
                twitchClient.say(channel, `@${tags.username}, no meta data this session yet.`);
                return;
            }
            const top = ranked.slice(0, 3).map(([s, c]) => `${s} x${c}`).join(' / ');
            twitchClient.say(channel, `Meta this session: ${top}`);
            return;
        }

        // !stats <name>
        if (lower.startsWith('!stats ')) {
            const oppName = msg.split(' ').slice(1).join(' ').trim();
            if (!oppName) {
                twitchClient.say(channel, `@${tags.username}, usage: !stats <OpponentName>`);
                return;
            }
            const history = readHistory();
            const found = findOpponentByName(history, oppName);
            if (!found) {
                twitchClient.say(channel, `@${tags.username}, no record vs ${oppName} in the Black Book.`);
                return;
            }
            const rec = computeRecord(found.data);
            twitchClient.say(channel,
                `All-time vs ${found.cleanName}: ${rec.wins}W-${rec.losses}L (${rec.winRate}% win rate).`);
            return;
        }
    });
}
startTwitch();

// ------------------------------------------------------------------
// HEALTH
// ------------------------------------------------------------------
app.get('/health', (_req, res) => res.json({
    ok: true,
    uptimeSec: Math.round(process.uptime()),
    session: sessionSnapshot(),
    historyPath: HISTORY_FILE_PATH,
    metaDbPath: META_DB_PATH
}));

// ------------------------------------------------------------------
// START
// ------------------------------------------------------------------
// Watch character_ids.txt for changes (e.g. user edited
// SC2_CHARACTER_IDS in reveal-sc2-opponent.bat and relaunched).
// Re-init Pulse so the new ID takes effect without a backend restart.
fs.watchFile(CHARACTER_IDS_PATH, { interval: 2000 }, () => {
    const fresh = readPublishedCharacterIds();
    if (fresh.length === 0) return;
    const sameSet =
        fresh.length === pulseCharacterIds.length &&
        fresh.every(id => pulseCharacterIds.includes(id));
    if (sameSet) return;
    console.log(`[Pulse] character_ids.txt changed -> re-initializing (${fresh.join(',')})`);
    pulseInitPromise = null;
    pulseSeasonId = null;
    pulseCharacterIds = [];
    if (pulseConfig().enabled) {
        ensurePulseInitialized().catch(err =>
            console.warn('[Pulse] re-init failed:', err.message));
    }
});

server.listen(PORT, async () => {
    console.log(`[Server] Listening on http://localhost:${PORT}`);
    console.log(`[Server] Dev panel: http://localhost:${PORT}/static/debug.html`);
    console.log(`[Server] !build:    http://localhost:${PORT}/static/last-build.html`);
    console.log(`[Server] History:   ${HISTORY_FILE_PATH}`);
    console.log(`[Server] Meta DB:   ${META_DB_PATH}`);
    // Per the SC2Pulse integration: kick off pulse season + character
    // resolution so the first game is ranked-aware. Don't await --
    // server should accept connections immediately even if Pulse is slow.
    if (typeof ensurePulseInitialized === 'function') {
        ensurePulseInitialized().catch(err =>
            console.warn('[Pulse] ensurePulseInitialized failed:', err.message));
    }
    // Watch meta_database.json + MyOpponentHistory.json for live SPA
    // updates. Broadcasts 'analyzer_db_changed' over Socket.io when
    // either DB moves so connected analyzer clients refresh in real time.
    try { analyzer.startWatching(io); }
    catch (err) { console.warn('[Analyzer] startWatching failed:', err.message); }
    console.log(`[Server] Analyzer:  http://localhost:${PORT}/analyzer`);
});

function shutdown(reason) {
    console.log(`[Server] Shutting down: ${reason}`);
    try { saveSession(); } catch (_) {}
    process.exit(0);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// EXPORT FOR TESTING
if (process.env.NODE_ENV === 'test') {
    module.exports = {
        loadConfig,
        DEFAULT_CONFIG,
        deepMerge
    };
}
