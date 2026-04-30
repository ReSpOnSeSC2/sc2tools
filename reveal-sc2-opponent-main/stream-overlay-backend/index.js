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
// Settings router (per-user profile.json + per-installation config.json).
// Mounted before legacy /api/config so the new schema-validated routes win.
const { createSettingsRouter } = require('./routes/settings');
// Onboarding router (Stage 2.2): /api/onboarding/* helpers used by
// the first-run wizard. Spawns identity_cli.py, scans replay
// folders, and round-trips against Twitch / OBS / SC2Pulse to
// validate the user's optional integrations.
const { createOnboardingRouter } = require('./routes/onboarding');
// Backups router (Stage 2.3): /api/backups/* snapshot/restore for
// data/meta_database.json + sibling files. Used by the Settings
// page's Backups tab, but also safe to call directly via curl.
const { createBackupsRouter } = require('./routes/backups');
// Stage 4: diagnostics endpoints. /api/diagnostics returns a parallel
// health check across python, sc2reader, replay folders, meta_database,
// schema validation, SC2Pulse, Twitch, OBS, disk, logs, and the macro
// engine version pin. /api/diagnostics/bundle streams a redacted .zip.
const { createDiagnosticsRouter } = require('./routes/diagnostics');
// Stage 7.4: custom-builds router + community sync service.
const { createCustomBuildsRouter } = require('./routes/custom-builds');
// Stage 12.1: auto-update endpoints (see routes/version.js).
const { createVersionRouter } = require('./routes/version');
const { createCommunitySyncService } = require('./services/community_sync');
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
    if (Array.isArray(override) || typeof override !== 'object' || override === null) return override ?? base;
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
        // SC2Pulse region label (e.g., 'NA', 'EU', 'KR', 'CN') for the
        // active team picked by pickActiveTeam(). Captured at Pulse init
        // and refreshed on every applyPulseRating() so the session widget
        // can render the player's current server immediately.
        region: null,
        // Most-recent OPPONENT MMR resolved via the SC2Pulse
        // opponent-search flow (PowerShell -> opponent.txt). Reset
        // to null at session start; refreshed when opponent.txt
        // changes. Frontend decides when to render.
        mmrOpponent: null,
        // Cumulative MMR change for the session. Tracked as a
        // first-class field so we can keep accruing per-game estimates
        // even when the replay file doesn't carry a usable MMR. Real
        // Pulse / replay readings recompute this from mmrCurrent-mmrStart.
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
// both are known. Real Pulse or replay readings should be authoritative
// over any prior estimates that were accumulated into mmrDelta.
function recomputeSessionMmrDelta() {
    if (Number.isFinite(session.mmrStart) && Number.isFinite(session.mmrCurrent)) {
        session.mmrDelta = Math.round(session.mmrCurrent - session.mmrStart);
    }
}

// Parse a session JSON file at `pth` and merge it onto defaults. Throws
// on read or JSON.parse failure so the caller can decide whether to fall
// back to a backup or to a fresh session. Pulled out of loadSession()
// so the same merge applies to backup recovery.
function _parseSessionFile(pth) {
    const raw = fs.readFileSync(pth, 'utf8');
    const data = JSON.parse(raw);
    const merged = { ...defaultSession(), ...data, metaCounts: data.metaCounts || {} };
    // Backfill mmrDelta for sessions saved by the older code path that
    // didn't track it as a first-class field. ONLY trust the real
    // absolute anchors (mmrStart/mmrCurrent set by SC2Pulse or a real
    // replay reading). We deliberately do NOT synthesize a delta from
    // W-L counts here -- the user wants real numbers, not a fabricated
    // +25 per win.
    if (!Number.isFinite(merged.mmrDelta) || merged.mmrDelta === 0) {
        if (Number.isFinite(merged.mmrStart) &&
            Number.isFinite(merged.mmrCurrent) &&
            merged.mmrStart !== merged.mmrCurrent) {
            merged.mmrDelta = Math.round(merged.mmrCurrent - merged.mmrStart);
        }
    }
    return merged;
}

// Quarantine a broken session file by renaming it aside so saveSession()
// doesn't keep trying to read the same corruption next boot. Best-effort:
// we swallow rename errors because the recovery path must still proceed.
function _quarantineBrokenSession(pth, reason) {
    try {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const dest = `${pth}.broken-${ts}`;
        fs.renameSync(pth, dest);
        console.warn(`[Session] Quarantined broken file -> ${path.basename(dest)} (${reason})`);
    } catch (err) {
        console.warn(`[Session] Could not quarantine broken file: ${err.message}`);
    }
}

// Look for sibling backups of `pth` that the engineering preamble's
// rolling-backup convention writes (e.g. session.state.json.bak.<ts>,
// session.state.json.pre-<label>-<ts>). Returns absolute paths sorted
// newest first by mtime. Excludes .broken-* (those are quarantined
// failures, not known-good backups) and our atomic-write .tmp_* files.
function _listSessionBackups(pth) {
    try {
        const dir = path.dirname(pth);
        const base = path.basename(pth);
        const entries = fs.readdirSync(dir);
        const candidates = entries
            .filter(name => name.startsWith(base + '.'))
            .filter(name => !name.includes('.broken-'))
            .filter(name => !name.startsWith('.tmp_'))
            .map(name => path.join(dir, name));
        const stats = candidates.map(p => {
            try { return { p, m: fs.statSync(p).mtimeMs }; }
            catch (_) { return null; }
        }).filter(Boolean);
        stats.sort((a, b) => b.m - a.m);
        return stats.map(s => s.p);
    } catch (_) {
        return [];
    }
}

function loadSession() {
    if (!fs.existsSync(SESSION_STATE_PATH)) return defaultSession();

    // 1. Try the canonical file. On any read / parse failure, quarantine
    //    it and try sibling backups in newest-first order.
    let merged;
    let parseFailed = false;
    try {
        merged = _parseSessionFile(SESSION_STATE_PATH);
    } catch (err) {
        parseFailed = true;
        console.error('[Session] Load failed:', err.message);
        _quarantineBrokenSession(SESSION_STATE_PATH, err.message);
        for (const bak of _listSessionBackups(SESSION_STATE_PATH)) {
            try {
                merged = _parseSessionFile(bak);
                console.warn(`[Session] Recovered from backup: ${path.basename(bak)}`);
                break;
            } catch (bakErr) {
                console.warn(`[Session] Backup unusable (${path.basename(bak)}): ${bakErr.message}`);
            }
        }
        if (!merged) {
            console.warn('[Session] No usable backup found, starting fresh session.');
            return defaultSession();
        }
    }

    // 2. Idle-reset check applies to whichever source we ended up using.
    const idleGap = Date.now() - (merged.lastResultTime || merged.startedAt || 0);
    if (idleGap > (config.session?.idleResetMs ?? (1 * 60 * 60 * 1000))) {
        console.log('[Session] Idle gap exceeded, starting fresh session.');
        // Render the recap BEFORE wiping. We can't call
        // generateRecapPng() yet because that helper uses the live
        // `session` -- but the python script reads session.state.json
        // directly off disk, so it sees the PRIOR session's stats
        // correctly. Schedule it after express is up. Skip when the
        // canonical file was quarantined: the recap script would only
        // see the broken (now-renamed) file, not the recovered backup.
        if (!parseFailed) {
            setTimeout(() => {
                try { generateRecapPng(); } catch (_) {}
            }, 500);
        }
        return defaultSession();
    }

    return merged;
}

// Skip the bootstrap loadSession() under jest. Tests require this
// module to access exported helpers, but loadSession() runs file
// I/O against the production session.state.json, which can race
// with the live backend's saveSession() and trigger a spurious
// quarantine. Tests that need session-state behavior import the
// helpers directly and drive them against tmp dirs.
let session = (process.env.NODE_ENV === 'test') ? defaultSession() : loadSession();

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
        mmrOpponent: session.mmrOpponent,
        league: mmrToLeague(session.mmrCurrent),
        // Active SC2Pulse region ('NA' / 'EU' / 'KR' / 'CN'); null until the
        // first Pulse fetch resolves. The session widget renders this next
        // to the player's current MMR so the server is visible at a glance.
        region: session.region || null,
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

function readWizardPulseIds() {
    // Read data/config.json's stream_overlay.pulse_character_ids -- the
    // canonical wizard-saved value. This is the user's REAL Pulse character
    // IDs (not the Blizzard character_ids that live in their SC2 folder
    // names; those are a different number space).
    try {
        const cfgPath = path.join(DATA_DIR, 'config.json');
        if (!fs.existsSync(cfgPath)) return [];
        let raw = fs.readFileSync(cfgPath, 'utf8');
        if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
        const cfg = JSON.parse(raw);
        const ov = (cfg && cfg.stream_overlay) || {};
        const ids = Array.isArray(ov.pulse_character_ids) ? ov.pulse_character_ids : [];
        return ids
            .map((x) => parseInt(String(x).trim(), 10))
            .filter(Number.isFinite);
    } catch (_) {
        return [];
    }
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
// Pull a region label ('NA' | 'EU' | 'KR' | 'CN') off a raw SC2Pulse
// team object's first member's character. Returns null when the team
// or character isn't usable (so the caller can preserve a previously-
// known region instead of clobbering it with null).
//
// SC2Pulse returns ch.region as EITHER a numeric code (1/2/3/5) or a
// string enum ('US' | 'EU' | 'KR' | 'CN'). We normalize both into the
// short label the session widget renders. Note that Pulse uses 'US'
// for the Americas region; we surface it as 'NA' in the UI to match
// the convention SC2 players actually use ('NA server').
const PULSE_STRING_REGION_LABEL = {
    US: 'NA', NA: 'NA', EU: 'EU', KR: 'KR', CN: 'CN',
};
function extractTeamRegionLabel(team) {
    if (!team) return null;
    const m = (team.members && team.members[0]) || {};
    const ch = m.character || {};
    const r = ch.region;
    if (r == null) return null;
    if (typeof r === 'number') return PULSE_REGION_LABEL[r] || null;
    const key = String(r).toUpperCase();
    return PULSE_STRING_REGION_LABEL[key] || null;
}

function applyPulseRating(rating, sourceTag, team) {
    if (!Number.isFinite(rating)) return false;
    if (session.mmrStart == null) session.mmrStart = rating;
    const prev = Number.isFinite(session.mmrCurrent) ? session.mmrCurrent : null;
    session.mmrCurrent = rating;
    const regionLabel = extractTeamRegionLabel(team);
    if (regionLabel) session.region = regionLabel;
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
        //   2. character_ids.txt    (mirrored from the wizard on save and
        //                           also written by Reveal-Sc2Opponent.ps1)
        //   3. data/config.json -> stream_overlay.pulse_character_ids
        //                           (the wizard's canonical store)
        let source = 'config';
        if (Array.isArray(pc.characterIds) && pc.characterIds.length) {
            pulseCharacterIds = pc.characterIds.map(Number).filter(Number.isFinite);
        } else {
            const published = readPublishedCharacterIds();
            if (published.length) {
                pulseCharacterIds = published;
                source = 'character_ids.txt';
            } else {
                pulseCharacterIds = readWizardPulseIds();
                source = 'wizard config.json';
            }
        }
        if (pulseCharacterIds.length === 0) {
            console.log('[Pulse] no characterIds found. Complete the SC2Pulse step in the wizard (Settings -> Integrations) -- it auto-resolves and saves your Pulse IDs.');
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
// Recover a JSON object from a string truncated mid-write. Walks back
// from EOF looking for the last well-formed top-level entry close
// ("    }," at indent 4 -- json.dump(indent=4) format from the Python
// watcher), trims after that line, and appends the missing top-level
// brace. Returns null when no anchor is found so the caller can fall
// back to {} rather than ship garbage.
function _attemptHistoryRepair(text) {
    return _salvageJsonObject(text);
}

// Walk back through `},\n` record boundaries (any indent style — works for both
// the modern 4-space data/MyOpponentHistory.json and the legacy 15-space-indent
// project-root MyOpponentHistory.json that PowerShell ConvertTo-Json produces).
// Drops the trailing partial entry, appends the missing closing brace, retries
// the parse. Tries up to N most-recent boundaries before giving up.
//
// Returns null when nothing parseable can be reconstructed so the caller can
// fall back to {} rather than ship garbage.
function _salvageJsonObject(text) {
    if (typeof text !== 'string' || text.length === 0) return null;
    let trimmed = text.replace(/[\s\u0000]+$/, '');
    if (trimmed.endsWith(',')) trimmed = trimmed.slice(0, -1);
    const candidates = [trimmed + '\n}\n'];
    const BOUND_RE = /},\s*\n/g;
    const bounds = [];
    let m;
    while ((m = BOUND_RE.exec(text)) !== null && bounds.length < 200) {
        bounds.push(m.index);
    }
    for (let i = bounds.length - 1; i >= 0; i--) {
        const cut = bounds[i];
        candidates.push(text.slice(0, cut + 1) + '\n}\n');
    }
    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed;
            }
        } catch (_) { /* try next candidate */ }
    }
    return null;
}

function readHistory() {
    try {
        if (!fs.existsSync(HISTORY_FILE_PATH)) return {};
        let raw = fs.readFileSync(HISTORY_FILE_PATH, 'utf8');
        if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
        try {
            return JSON.parse(raw);
        } catch (parseErr) {
            // The Black Book has been hit by mid-write truncation a
            // few times (the watcher writing while the network FS
            // syncs partially across the Windows mount). Rather than
            // surface 'first meeting' for every opponent until the
            // user notices, attempt a tail-trim recovery that drops
            // the partial entry and rebuilds a parseable object.
            const recovered = _attemptHistoryRepair(raw);
            if (recovered) {
                const n = Object.keys(recovered).length;
                console.warn(
                    `[History] On-disk file is truncated (${parseErr.message}); ` +
                    `recovered ${n} entries via tail-trim repair. ` +
                    `Restart the replay watcher to rewrite the file cleanly.`
                );
                return recovered;
            }
            console.error('[History] Read failed and recovery declined to anchor:', parseErr.message);
            return {};
        }
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

// ------------------------------------------------------------------
// SCOUTING — recent games (last 5)
// ------------------------------------------------------------------
// Skip noise that the SC2 client emits at game start (reward dances,
// beacon pings, sprays). Real build events have a non-zero timestamp
// and a structural unit/building name.
const SCOUT_OPENER_NOISE_PREFIXES = [
    'RewardDance', 'Beacon', 'Spray', 'StimpackUpgrade',
];
const SCOUT_RECENT_LIMIT = 5;
const SCOUT_OPENER_LIMIT = 4;

// Filter a build_log array down to the first N "real" milestone lines.
// build_log lines look like "[m:ss] UnitOrBuildingName". We drop the
// [0:00] start-of-game UI noise and any line whose name starts with a
// known UI-only prefix.
function _scoutFilterOpener(buildLog) {
    if (!Array.isArray(buildLog)) return [];
    const out = [];
    for (const line of buildLog) {
        if (typeof line !== 'string') continue;
        // line shape: "[mm:ss] Name"
        const m = line.match(/^\[(\d+):(\d+)\]\s*(.+)$/);
        if (!m) continue;
        const mins = Number(m[1]);
        const secs = Number(m[2]);
        const name = (m[3] || '').trim();
        if (!name) continue;
        if (mins === 0 && secs === 0) continue; // start-of-game noise
        if (SCOUT_OPENER_NOISE_PREFIXES.some(pref => name.startsWith(pref))) {
            continue;
        }
        out.push({
            time: `${mins}:${String(secs).padStart(2, '0')}`,
            name,
        });
        if (out.length >= SCOUT_OPENER_LIMIT) break;
    }
    return out;
}

// Cross-reference meta_database.json for the most recent games against
// `oppName`. Each build's games[] is filtered by g.opponent (case-
// insensitive) — we ignore the legacy MyOpponentHistory.json here
// because it doesn't carry build_log / game_length, and the scouting
// card needs both.
function buildRecentGamesForOpponent(oppName, limit) {
    const cap = Number.isFinite(limit) && limit > 0 ? limit : SCOUT_RECENT_LIMIT;
    if (!oppName) return [];
    const db = readMetaDb();
    if (!db || typeof db !== 'object') return [];
    // Compare by the SAME normalized name-forms that findOpponentByName
    // uses against MyOpponentHistory.json. The PowerShell scanner writes
    // SC2Pulse Character.Name to opponent.txt, which carries the BattleTag
    // discriminator ('Player#1234'); the meta DB stores the bare in-game
    // name from sc2reader ('Player'). A strict toLowerCase() compare
    // missed every match in that case, leaving the scouting card empty.
    const targetForms = nameForms(oppName);
    if (targetForms.size === 0) return [];
    const flat = [];
    let scanned = 0;
    for (const [buildName, bd] of Object.entries(db)) {
        if (!bd || !Array.isArray(bd.games)) continue;
        for (const g of bd.games) {
            scanned++;
            const oppForms = nameForms(g && g.opponent);
            if (oppForms.size === 0) continue;
            let matched = false;
            for (const f of oppForms) {
                if (targetForms.has(f)) { matched = true; break; }
            }
            if (!matched) continue;
            flat.push({ buildName, g });
        }
    }
    console.log(
        `[Scout] recent-games lookup: opp="${oppName}" forms=${targetForms.size} ` +
        `scanned=${scanned} matched=${flat.length} cap=${cap}`
    );
    if (flat.length === 0) return [];
    // Newest first by date string (ISO sorts lexicographically).
    flat.sort((a, b) => String(b.g.date || '').localeCompare(String(a.g.date || '')));
    const taken = flat.slice(0, cap);
    return taken.map(({ buildName, g }) => {
        const lengthSec = Number(g.game_length) || 0;
        return {
            id: g.id || null,
            date: g.date || null,
            map: g.map || null,
            result: g.result || null, // "Win" | "Loss" | other
            lengthSec,
            lengthText: formatMatchDuration(lengthSec) || '—',
            myBuild: buildName || g.my_build || null,
            oppBuild: g.opp_strategy || null,
            oppRace: g.opp_race || null,
            myOpener:  _scoutFilterOpener(g.build_log),
            oppOpener: _scoutFilterOpener(
                g.opp_build_log && g.opp_build_log.length > 0
                    ? g.opp_build_log
                    : g.opp_early_build_log
            ),
        };
    });
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
    if (found) {
        const rec = computeRecord(found.data);
        if (rec.total > 0) {
            return {
                opponent: found.cleanName,
                wins: rec.wins,
                losses: rec.losses,
                total: rec.total,
                winRate: rec.winRate,
                race: found.data.Race || null
            };
        }
    }
    // Black Book miss (truncation / never-migrated / name mismatch). Fall back
    // to meta_database.json which is the authoritative post-game record. This
    // is what makes the opponent widget agree with the scouting widget when
    // the user has played this opponent but MyOpponentHistory doesn't reflect
    // it -- the symptom that surfaced as 'first meeting' on the merged
    // opponent card while the scouting card showed real recent games.
    const metaRec = _recordFromMetaDb(oppName);
    if (metaRec) {
        console.log(
            `[Rematch] Black Book miss for "${oppName}"; using meta DB fallback ` +
            `(${metaRec.wins}W-${metaRec.losses}L over ${metaRec.total} games).`
        );
        return metaRec;
    }
    return null;
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
        try {
            return JSON.parse(raw);
        } catch (parseErr) {
            // meta_database.json has historically been hit by mid-write
            // truncation -- the same failure mode that hits MyOpponentHistory.
            // Salvage the valid prefix so the live overlay path (recentGames,
            // bestAnswer, record fallback) keeps producing real numbers
            // instead of silently zeroing out.
            const recovered = _salvageJsonObject(raw);
            if (recovered) {
                console.warn(
                    `[MetaDB] On-disk file is truncated (${parseErr.message}); ` +
                    `recovered ${Object.keys(recovered).length} builds via salvage.`
                );
                return recovered;
            }
            console.error('[MetaDB] Read failed and salvage declined to anchor:', parseErr.message);
            return null;
        }
    } catch (err) {
        console.error('[MetaDB] Read failed:', err.message);
        return null;
    }
}

// Count W/L for `oppName` by walking meta_database.json games. Used as the
// authoritative fallback when MyOpponentHistory.json doesn't carry the
// opponent (truncation, name mismatch, or first-game-this-build state where
// the analyzer DB has the game but the Black Book hasn't been rewritten yet).
//
// Returns { wins, losses, total, winRate, race } or null if no games match.
function _recordFromMetaDb(oppName) {
    if (!oppName) return null;
    const db = readMetaDb();
    if (!db || typeof db !== 'object') return null;
    const targetForms = nameForms(oppName);
    if (targetForms.size === 0) return null;
    let wins = 0;
    let losses = 0;
    let race = null;
    let cleanName = null;
    for (const bd of Object.values(db)) {
        if (!bd || !Array.isArray(bd.games)) continue;
        for (const g of bd.games) {
            const oppForms = nameForms(g && g.opponent);
            if (oppForms.size === 0) continue;
            let matched = false;
            for (const f of oppForms) {
                if (targetForms.has(f)) { matched = true; break; }
            }
            if (!matched) continue;
            const result = String(g.result || '').toLowerCase();
            if (result === 'win' || result === 'victory') wins += 1;
            else if (result === 'loss' || result === 'defeat') losses += 1;
            if (!race && g.opp_race) race = g.opp_race;
            if (!cleanName && g.opponent) cleanName = stripClanTag(String(g.opponent));
        }
    }
    const total = wins + losses;
    if (total === 0) return null;
    return {
        opponent: cleanName || oppName,
        wins,
        losses,
        total,
        winRate: Math.round((wins / total) * 100),
        race
    };
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
// PORT honors the env var so SC2ReplayAnalyzer.py can set
// SC2_TOOLS_PORT and pass through PORT (Stage 3 launcher).
const DEFAULT_PORT = 3000;
const PORT = Number.parseInt(process.env.PORT, 10) || DEFAULT_PORT;

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

// Stage 2.2: serve the SC2-Overlay surface at /overlay/ so the
// first-run wizard's Streamlabs / OBS Browser-Source card can
// advertise a real URL (http://localhost:3000/overlay/) for the
// user to paste into their stream software.
const SC2_OVERLAY_DIR = path.join(ROOT, 'SC2-Overlay');
if (fs.existsSync(SC2_OVERLAY_DIR)) {
    app.use('/overlay', express.static(SC2_OVERLAY_DIR, {
        fallthrough: true,
        maxAge: '1h',
    }));
}
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
    // Open + write + fsync + close + rename. The fsync is the key
    // step the previous writeFileSync version was missing: on Windows,
    // writeFileSync returns as soon as the write hits the OS cache,
    // so a subsequent power loss / hard kill / OS crash could leave
    // the renamed-into-place file with only the bytes that the OS
    // happened to have flushed. fsyncSync forces the data to durable
    // storage before the rename, matching the Python side's
    // write -> fsync -> rename contract.
    let fd = -1;
    try {
        const body = JSON.stringify(data, null, indent);
        fd = fs.openSync(tmp, 'w');
        fs.writeSync(fd, body);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = -1;
        fs.renameSync(tmp, target);
    } catch (err) {
        if (fd !== -1) {
            try { fs.closeSync(fd); } catch (_) { /* ignore */ }
        }
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

// Stage 2: settings endpoints. Reads/writes data/profile.json and
// data/config.json with ajv schema validation + atomic write→fsync→
// rename. Registered here (before the legacy overlay /api/config
// handler further down) so /api/config resolves to the new router.
app.use(createSettingsRouter({ dataDir: DATA_DIR }));
// Stage 2.2: onboarding endpoints. Drives the first-run wizard.
// repoRoot = the merged-toolkit repo root (one level above this
// stream-overlay-backend dir); scriptsDir holds identity_cli.py
// alongside recon_sc2_install.py.
app.use(createOnboardingRouter({
    scriptsDir: path.join(ROOT, 'scripts'),
    repoRoot: ROOT,
    pythonExe: process.env.PYTHON
        || (process.platform === 'win32' ? 'py' : 'python3'),
    fetch,
    loopbackBase: (req) => `http://${req.headers.host}`,
}));

// Stage 2.3: backups endpoints. Snapshot / list / restore / delete the
// allow-listed data files (meta_database.json, profile.json, etc.).
// Restores always take a pre-restore safety snapshot first.
app.use(createBackupsRouter({ dataDir: DATA_DIR }));

// Stage 4: diagnostics endpoints (see routes/diagnostics.js).
app.use(createDiagnosticsRouter({
    dataDir: DATA_DIR,
    analyzerScriptsDir: path.resolve(ROOT, '..', 'SC2Replay-Analyzer'),
}));

// Stage 7.4: community sync service + custom-builds router. The
// service is constructed before the Socket.io server is wired so we
// can pass a lazy io getter into the router (io is declared a few
// lines below). The interval worker is started in the listen
// callback so unit tests that import index.js without listening
// don't kick off real network calls.
const communitySync = createCommunitySyncService({
    dataDir: DATA_DIR,
    baseUrl: process.env.COMMUNITY_BUILDS_URL,
    fetchImpl: typeof fetch === 'function' ? fetch : undefined,
    logger: {
        info: (obj, msg) => console.log('[community_sync]', msg, obj || {}),
        warn: (obj, msg) => console.warn('[community_sync]', msg, obj || {}),
        error: (obj, msg) => console.error('[community_sync]', msg, obj || {}),
        debug: () => undefined,
    },
});
app.use('/api/custom-builds', createCustomBuildsRouter({
    dataDir: DATA_DIR,
    sync: communitySync,
    getIo: () => io,
}));

// Stage 12.1: /api/version + /api/update/start. The router decides
// when to auto-exit so the silent installer can replace files.
app.use(createVersionRouter());

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
        // mmrStart stays at whatever Pulse seeded it as. If we
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
    // Tell the caller how many overlay clients (OBS browser sources)
    // were actually listening when this event went out. The debug panel
    // surfaces this so the user can tell 'event fired but nothing on
    // stream' apart from 'no client was listening to begin with'.
    res.json({ ok: true, event: env, clientsConnected: io.engine.clientsCount });
});

// Live count of connected overlay clients (any Socket.io connection,
// which in this codebase is exclusively SC2-Overlay browser sources).
// Polled by the dev panel to show 'OBS clients: N' so the user can
// confirm at a glance that their browser sources are listening before
// firing test events.
app.get('/api/overlay/clients', (_req, res) => {
    res.json({ count: io.engine.clientsCount });
});

// ------------------------------------------------------------------
// OPPONENT FILE WATCHER (pre-game hooks)
// ------------------------------------------------------------------
// Parse the opponent's display name out of opponent.txt. The PowerShell
// scanner (Reveal-Sc2Opponent.ps1) writes lines in several shapes
// depending on its rating/race format flags:
//   '[CLAN]Player(2840) P'
//   '[CLAN] Player [2840] Zerg'
//   '[CLAN]Player 2840MMR P (5-3)'         <- new long-format default
//   'Player#1234 5018MMR T (12-8), MyRace=Protoss'
// We strip the clan-tag prefix, take only the first comma-delimited
// chunk (so 'MyRace=...' tails are dropped), then peel known suffixes
// off the right edge until only the player name remains:
//   1. trailing '(W-L)' record like '(5-3)' or '(0-0)'
//   2. trailing race token: 'Z'/'P'/'T'/'R' or full name
//   3. trailing MMR token: '<digits>MMR' or bracketed '(2840)'/'[2840]'
//   4. trailing bare numeric MMR like '5018' (short-format scanner)
// Pre-2026 the scanner only ever emitted parens-wrapped MMR which the
// old strip-all-parens pass caught -- the new long format leaves the
// digits unwrapped, which jammed '<rating>MMR <race>' onto the name
// and broke every recent-games / Black Book lookup.
const _OPP_SUFFIX_PATTERNS = [
    /\s*\(\s*\d+\s*-\s*\d+\s*\)\s*$/,                        // (W-L)
    /\s+(?:Zerg|Protoss|Terran|Random|[ZPTR])\s*$/i,               // race
    /\s*[\(\[]\s*\d{3,5}\s*[\)\]]\s*$/,                       // (2840)/[2840]
    /\s+\d{3,5}\s*MMR\s*$/i,                                      // 2840MMR
    /\s+\d{3,5}\s*$/,                                              // bare digits
];

function parseFirstOpponentName(line) {
    if (!line) return null;
    let s = String(line).split(',')[0] || line;
    // Strip leading clan tag '[CLAN]' (with or without trailing space)
    s = s.replace(/^\s*\[[^\]]*\]\s*/, '').trim();
    // Iteratively peel known suffixes (race/MMR/W-L). Each pass strips
    // at most one match; loop until nothing changes so the order of
    // suffix tokens doesn't matter.
    let changed = true;
    while (changed) {
        changed = false;
        for (const re of _OPP_SUFFIX_PATTERNS) {
            const next = s.replace(re, '').trim();
            if (next !== s) { s = next; changed = true; }
        }
    }
    return s || null;
}

function parseMyRaceFromOpponentLine(line) {
    // Some scanners write "<Opp>, MyRace=Protoss" -- pluck it if present.
    const m = (line || '').match(/MyRace\s*=\s*(Zerg|Protoss|Terran)/i);
    return m ? m[1] : null;
}

// Pull the opponent's MMR out of the opponent.txt line. The PowerShell
// scanner produces several shapes depending on its rating-format flag:
//   'ScrubBoss42(2840) Z'                     <- short, paren-wrapped
//   'ScrubBoss42 [2840] Zerg'                 <- short, bracket-wrapped
//   '[Shopify]Harstem 5175MMR T (0-0)'        <- long format (default)
//   'Player#1234 5018MMR T (12-8), MyRace=P'  <- BattleTag discriminator
//
// Resolution order, most-specific first:
//   1. Bracketed MMR token like '(2840)' or '[2840]' on its own.
//   2. '<digits>MMR' literal -- the new long format. The old fallback
//      regex \b(\d{3,5})\b couldn't catch this because '5175' is glued
//      to 'M' with no word boundary, so it returned null and the
//      backend fell back to session.mmrOpponent (= previous opponent's
//      MMR), painting a stale '888 MMR' on the overlay.
//   3. Bare 3-5 digit number with word boundaries -- legacy fallback.
//      Skipped if it would land on a BattleTag discriminator like
//      '#1234' (those would otherwise win over the real rating).
function parseOpponentMmr(line) {
    if (!line) return null;
    const s = String(line);
    // 1. Bracketed MMR -- only a wrapper around digits and nothing else,
    //    so '(0-0)' and '[Shopify]' don't qualify.
    let m = s.match(/[\(\[]\s*(\d{3,5})\s*[\)\]]/);
    if (m) return parseInt(m[1], 10);
    // 2. <digits>MMR token (case-insensitive). Anchored on a left word
    //    boundary so 'Player1234MMR' (digits glued to a name) doesn't
    //    match -- only standalone numeric runs followed by 'MMR' do.
    m = s.match(/(?:^|[^\w#])(\d{3,5})\s*MMR\b/i);
    if (m) return parseInt(m[1], 10);
    // 3. Bare 3-5 digit number with word boundaries on BOTH sides AND
    //    not preceded by '#' (BattleTag discriminator). 'Player#1234'
    //    has '\b1234\b' true but '#' precedes -- skip.
    const re = /(^|[^\w#])(\d{3,5})\b/g;
    let match;
    while ((match = re.exec(s)) !== null) {
        // The character right before the digits is captured in group 1
        // (or empty if at start). If it's '#' we already filtered, but
        // also reject when the lead char is a digit (avoid mid-number
        // partial matches like grabbing '123' out of '12345').
        const lead = match[1];
        if (lead === '#') continue;
        return parseInt(match[2], 10);
    }
    return null;
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
        // PowerShell clears opponent.txt when a game ends. Reset the dedup
        // anchor so the NEXT pre-game write -- even if its content happens
        // to match the previous game's line -- still triggers a fresh emit.
        if (!raw) {
            if (lastOpponentText) {
                lastOpponentText = '';
                console.log('[Scanner] Opponent file cleared (game ended); dedup reset.');
            }
            return;
        }
        if (raw === lastOpponentText) return;
        lastOpponentText = raw;
        console.log(`[Scanner] Opponent file changed: ${raw}`);

        const oppMmr  = parseOpponentMmr(raw);
        const oppRace = parseOpponentRace(raw);
        const oppName = parseFirstOpponentName(raw);
        const myRace  = parseMyRaceFromOpponentLine(raw);

        // Look up our head-to-head record so the merged opponent
        // widget can show "Z 2840 MMR | 5W-3L (62%)" in one line.
        const rematch = oppName ? buildRematchSummary(oppName) : null;

        // Persist the parsed opponent MMR (from the PowerShell
        // SC2Pulse search) onto the session so #opp-mmr refreshes
        // and downstream events see a consistent value. When the
        // current line carries no MMR (e.g. unranked fallback) we
        // keep whatever Pulse last gave us rather than blanking it.
        if (Number.isFinite(oppMmr)) {
            const oppChanged = oppMmr !== session.mmrOpponent;
            session.mmrOpponent = oppMmr;
            if (oppChanged) {
                saveSession();
                io.emit('opponentMmrUpdate', { mmr: oppMmr });
            }
        }
        const opponentMmrForEmit = Number.isFinite(oppMmr)
            ? oppMmr
            : (Number.isFinite(session.mmrOpponent) ? session.mmrOpponent : null);
        emitEvent('opponentDetected', {
            text: raw,
            opponent: oppName,
            mmr: opponentMmrForEmit,
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
        if (rematch || fav || cheese || rival || oppRace
            || Number.isFinite(opponentMmrForEmit)) {
            emitEvent('scoutingReport', {
                opponent: rematch?.opponent || fav?.opponent || rival?.opponent || oppName,
                race: oppRace || rematch?.race || rival?.race || null,
                mmr: opponentMmrForEmit,
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
                } : null,
                // Last N games against this opponent — pulled live from
                // meta_database.json. Each entry: { lengthText, result,
                // myBuild, oppBuild, myOpener[], oppOpener[], date, map }.
                // The widget renders these instead of the now-deprecated
                // favoriteOpening row.
                recentGames: buildRecentGamesForOpponent(oppName, SCOUT_RECENT_LIMIT)
            });
        }
    } catch (err) {
        console.error('[Scanner] Error:', err.message);
    }
});

// ------------------------------------------------------------------
// MMR SCANNER WATCHER -- removed in v0.9.0
// ------------------------------------------------------------------
// The dual-zone OCR scanner that wrote scanned_mmr.txt has been
// retired. Player MMR is anchored from SC2Pulse (see refresh chain
// above) and opponent MMR is parsed from opponent.txt (which the
// PowerShell scanner now writes via the Pulse-anchored search). The
// opponent-file watcher keeps session.mmrOpponent in sync and emits
// opponentMmrUpdate, so the overlay widget refreshes #opp-mmr the
// same way it did before -- minus the unreliable screen capture.

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

// /api/health: schema-stable readiness endpoint used by the desktop
// launcher (SC2ReplayAnalyzer.py) and the Stage-4 /diagnostics page.
// Keep the response shape minimal so external pollers can rely on it.
const PKG_VERSION = require('./package.json').version;
app.get('/api/health', (_req, res) => res.json({
    ok: true,
    version: PKG_VERSION,
    uptime_sec: Math.round(process.uptime())
}));

// ------------------------------------------------------------------
// START
if (require.main === module) {
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
}

if (require.main === module) {
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
        // Stage 7.4: start the 15-minute community sync worker.
        try { communitySync.start(); }
        catch (err) { console.warn('[community_sync] start failed:', err.message); }
        console.log(`[Server] Analyzer:  http://localhost:${PORT}/analyzer`);
    });

    function shutdown(reason) {
        console.log(`[Server] Shutting down: ${reason}`);
        try { saveSession(); } catch (_) {}
        process.exit(0);
    }
    process.on('SIGINT',  () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// EXPORT FOR TESTING
if (process.env.NODE_ENV === 'test') {
    module.exports = {
        loadConfig,
        DEFAULT_CONFIG,
        deepMerge,
        describePulseTeam,
        // Session-state recovery + atomic-write helpers, exported so
        // __tests__/session.test.js can drive them against tmp dirs
        // without spinning up the express server.
        _atomicWriteJsonSync,
        _parseSessionFile,
        _quarantineBrokenSession,
        _listSessionBackups,
        defaultSession,
        // Stage 11.3: expose the constructed Express app + http
        // server so health/version/games tests can drive routes
        // via supertest without needing to spin up server.listen.
        app,
        server
    };
}
