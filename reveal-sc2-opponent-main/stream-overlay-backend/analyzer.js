/**
 * SC2 META ANALYZER -- API LAYER
 * ============================================================
 * Serves the new web-based analyzer UI from the existing Express
 * backend. Two persistent data sources:
 *
 *   data/meta_database.json     -- keyed by build name, each holds
 *                                  per-game records (the same files
 *                                  the Python analyzer GUI reads).
 *   data/MyOpponentHistory.json -- keyed by SC2Pulse Character ID,
 *                                  each holds per-opponent records
 *                                  (BattleTag, matchups, games).
 *
 * Both are reloaded on demand using a cheap file-signature short-
 * circuit (mtime + size + head/tail hash) so we don't re-parse 60MB
 * just to learn nothing changed.
 *
 * Aggregations are cached by DB revision and only recomputed when
 * the underlying data actually moves. Live updates push a Socket.io
 * `analyzer_db_changed` event to subscribed clients.
 *
 * All endpoints accept optional global filters via query string:
 *   ?since=2026-04-01      (ISO date)
 *   &until=2026-04-25
 *   &race=Z|P|T|R          (my race)
 *   &opp_race=Z|P|T|R
 *   &map=Goldenaura
 *   &mmr_min=3500&mmr_max=5000
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
// `spawn` is used both by the ML CLI (defined further down) and by the
// macro CLI helpers, so hoist it to the top requires block to avoid
// temporal-dead-zone issues for endpoints declared earlier in the file.
const { spawn } = require('child_process');

// SC2 catalog (mirrors core/sc2_catalog.py). Used by the build-order
// endpoint so the browser can render canonical display names + race +
// category for every event without round-tripping to Python.
let SC2_CATALOG = null;
try {
    SC2_CATALOG = require('./sc2_catalog');
} catch (_) {
    SC2_CATALOG = null;
}

// Matchup-aware timing taxonomy. Same module the SPA frontend loads at
// `/static/analyzer/timing_catalog.js` -- one source of truth, no drift.
// Mirrors `analytics/timing_catalog.py` in the Python repos.
const TimingCatalog = require('./public/analyzer/timing_catalog');

// --------------------------------------------------------------
// PATHS
// --------------------------------------------------------------
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const META_DB_PATH = path.join(DATA_DIR, 'meta_database.json');
const OPP_HISTORY_PATH = (() => {
    const inData = path.join(DATA_DIR, 'MyOpponentHistory.json');
    const legacy = path.join(ROOT, 'MyOpponentHistory.json');
    return fs.existsSync(inData) ? inData : legacy;
})();

// --------------------------------------------------------------
// FILE SIGNATURE HELPER
// --------------------------------------------------------------
// Same idea as the Python analyzer's compute_db_signature: cheap
// enough to call every few seconds, accurate enough to detect any
// real change. Hashes head + tail of the file plus mtime + size.
function fileSignature(p) {
    let st;
    try { st = fs.statSync(p); } catch (_) { return null; }
    try {
        const fd = fs.openSync(p, 'r');
        try {
            const head = Buffer.alloc(Math.min(4096, st.size));
            fs.readSync(fd, head, 0, head.length, 0);
            const h = crypto.createHash('sha1').update(head);
            if (st.size > 8192) {
                const tail = Buffer.alloc(4096);
                fs.readSync(fd, tail, 0, tail.length, st.size - 4096);
                h.update(tail);
            }
            return `${st.mtimeMs}:${st.size}:${h.digest('hex').slice(0, 12)}`;
        } finally { fs.closeSync(fd); }
    } catch (_) { return null; }
}

// --------------------------------------------------------------
// DB CACHE
// --------------------------------------------------------------
// Each DB has a revision counter that bumps on reload. Aggregation
// caches key off it so they only recompute when data actually moved.
const dbCache = {
    meta: { data: {}, signature: null, revision: 0, loadedAt: 0 },
    opp:  { data: {}, signature: null, revision: 0, loadedAt: 0 },
    aggCache: new Map(), // key: `${kind}:${revisionMeta}:${revisionOpp}:${filterHash}` -> result
};

function readJsonStripBom(p) {
    let raw = fs.readFileSync(p, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    return JSON.parse(raw);
}

function reloadIfChanged(which) {
    const cfg = which === 'meta'
        ? { slot: dbCache.meta, path: META_DB_PATH }
        : { slot: dbCache.opp,  path: OPP_HISTORY_PATH };
    if (!fs.existsSync(cfg.path)) return false;
    const sig = fileSignature(cfg.path);
    if (sig === cfg.slot.signature) return false;
    try {
        cfg.slot.data = readJsonStripBom(cfg.path) || {};
        cfg.slot.signature = sig;
        cfg.slot.revision += 1;
        cfg.slot.loadedAt = Date.now();
        dbCache.aggCache.clear();
        console.log(`[Analyzer] reloaded ${which}: rev=${cfg.slot.revision}`);
        return true;
    } catch (err) {
        console.error(`[Analyzer] failed to reload ${which}:`, err.message);
        return false;
    }
}

function ensureLoaded() {
    if (!dbCache.meta.signature) reloadIfChanged('meta');
    if (!dbCache.opp.signature)  reloadIfChanged('opp');
}

// Persist the in-memory meta DB back to disk (atomic-ish via tmp+rename).
// Used after the macro CLI mutates a single game record so the next
// reloadIfChanged sees the updated signature without overwriting our edits.
function persistMetaDb() {
    if (!dbCache.meta || !dbCache.meta.data) return;
    const tmp = META_DB_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(dbCache.meta.data, null, 2), 'utf8');
    fs.renameSync(tmp, META_DB_PATH);
    // Refresh signature so the watcher doesn't think the file changed
    // out from under us and trigger a redundant analyzer_db_changed event.
    dbCache.meta.signature = fileSignature(META_DB_PATH);
    dbCache.meta.revision += 1;
    dbCache.aggCache.clear();
}

// Resolve the player name for macro/ML calls: explicit param wins, then
// Prefer Stage 2.1+ profile.json (preferred_player_name_in_replays),
// fall back to the legacy config.json.last_player (the pre-Stage-2.2
// shape), then to the SC2_PLAYER env var, else ''.
function getDefaultPlayerName() {
    try {
        const profilePath = path.join(DATA_DIR, 'profile.json');
        if (fs.existsSync(profilePath)) {
            const raw = fs.readFileSync(profilePath, 'utf8') || '{}';
            // Strip BOM if present (Windows tools sometimes add one).
            const noBom = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
            const profile = JSON.parse(noBom);
            const name = profile && profile.preferred_player_name_in_replays;
            if (typeof name === 'string' && name.length > 0) return name;
        }
    } catch (_) { /* fall through to legacy */ }
    try {
        const cfgPath = path.join(DATA_DIR, 'config.json');
        if (fs.existsSync(cfgPath)) {
            const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8') || '{}');
            if (cfg && typeof cfg.last_player === 'string') return cfg.last_player;
        }
    } catch (_) { /* ignore */ }
    return process.env.SC2_PLAYER || '';
}

// Spawn the python macro_cli.py with subcmd+args, parse newline-delimited
// JSON from stdout, resolve with the array of records. Mirrors runMlCli.
function runMacroCli(subcmd, args = []) {
    return new Promise((resolve, reject) => {
        const projDir = pythonProjectDirOrErr();
        if (projDir.error) return reject(new Error(projDir.error));
        const py = pickPythonExe();
        const pyArgs = ['scripts/macro_cli.py', subcmd, ...args];
        const proc = spawn(py, pyArgs, {
            cwd: projDir.dir, env: mlEnv(), windowsHide: true,
        });
        let stdout = '', stderr = '';
        proc.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
        proc.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
        proc.on('error', (err) => reject(err));
        proc.on('close', (code) => {
            const records = stdout.split('\n')
                .map(l => l.trim()).filter(Boolean)
                .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
                .filter(Boolean);
            if (code !== 0 && records.length === 0) {
                return reject(new Error(stderr.trim() || `macro_cli exit ${code}`));
            }
            resolve(records);
        });
    });
}

function cachedAgg(kind, filters, compute) {
    const fh = filters ? JSON.stringify(filters) : '';
    const key = `${kind}:${dbCache.meta.revision}:${dbCache.opp.revision}:${fh}`;
    if (dbCache.aggCache.has(key)) return dbCache.aggCache.get(key);
    const result = compute();
    dbCache.aggCache.set(key, result);
    // Bound cache growth: keep the last ~200 distinct queries.
    if (dbCache.aggCache.size > 200) {
        const oldest = dbCache.aggCache.keys().next().value;
        dbCache.aggCache.delete(oldest);
    }
    return result;
}

// --------------------------------------------------------------
// FILTER PARSING & APPLICATION
// --------------------------------------------------------------
function parseFilters(q) {
    if (!q) return {};
    const f = {};
    // Date filter inputs are "YYYY-MM-DD" with no time component.
    // Parse them as LOCAL time so they match game timestamps which
    // are also stored without a TZ ("2026-04-03 12:37"). Otherwise
    // Date.parse() treats the bare date as UTC midnight, which
    // chops off everything from that day in negative-offset zones.
    if (q.since) f.since = Date.parse(q.since + 'T00:00:00');
    if (q.until) f.until = Date.parse(q.until + 'T23:59:59.999');
    if (q.race)     f.race     = String(q.race).toUpperCase().slice(0, 1);
    if (q.opp_race) f.oppRace  = String(q.opp_race).toUpperCase().slice(0, 1);
    if (q.map)      f.map      = String(q.map).toLowerCase();
    if (q.mmr_min)  f.mmrMin   = Number(q.mmr_min);
    if (q.mmr_max)  f.mmrMax   = Number(q.mmr_max);
    if (q.build)    f.build    = String(q.build);
    if (q.opp_strategy) f.oppStrategy = String(q.opp_strategy);
    return f;
}

function gameMatches(game, build, filters) {
    if (!filters) return true;
    if (filters.build && build !== filters.build) return false;
    if (filters.oppStrategy && (game.opp_strategy || 'Unknown') !== filters.oppStrategy) return false;
    if (filters.oppRace) {
        const r = (game.opp_race || '').charAt(0).toUpperCase();
        if (r !== filters.oppRace) return false;
    }
    if (filters.race) {
        // race is from the build name prefix (e.g. "Protoss - ...") in
        // most cases; fall back to a per-game my_race field if present.
        const myRace = (game.my_race || build.split(' ')[0] || '').charAt(0).toUpperCase();
        if (myRace !== filters.race) return false;
    }
    if (filters.map) {
        const m = (game.map || '').toLowerCase();
        if (!m.includes(filters.map)) return false;
    }
    if (filters.since || filters.until) {
        const t = parseGameDate(game.date);
        if (!Number.isFinite(t)) return false;
        if (filters.since && t < filters.since) return false;
        if (filters.until && t > filters.until) return false;
    }
    if (filters.mmrMin && Number.isFinite(game.opp_mmr) && game.opp_mmr < filters.mmrMin) return false;
    if (filters.mmrMax && Number.isFinite(game.opp_mmr) && game.opp_mmr > filters.mmrMax) return false;
    return true;
}

function parseGameDate(s) {
    if (!s) return NaN;
    // Handle several formats found in the DBs: "2026-04-03 12:37",
    // "2026-04-03T12:37:00", "2018-07-16 15:16:53".
    const t = Date.parse(String(s).replace(' ', 'T'));
    return Number.isFinite(t) ? t : NaN;
}

// Normalised date accessor for game records that may use either
// `date` (meta_database.json) or `Date` (MyOpponentHistory.json).
function gameDate(g) {
    return parseGameDate(g && (g.date || g.Date));
}

// SC2 game records come from two different data sources with two
// different conventions: meta_database.json uses lowercase `result`
// ("Win"/"Loss") while MyOpponentHistory.json uses capitalised
// `Result` ("Victory"/"Defeat"). Normalise here so a single helper
// works for both.
function gameResult(g) {
    const r = g && (g.result || g.Result);
    if (!r) return null;
    const s = String(r).toLowerCase();
    if (s === 'win' || s === 'victory') return 'win';
    if (s === 'loss' || s === 'defeat') return 'loss';
    return null;
}
function isWin(g)  { return gameResult(g) === 'win'; }
function isLoss(g) { return gameResult(g) === 'loss'; }

// --------------------------------------------------------------
// CORE ITERATOR -- yields {build, game} for every game across the
// meta DB after filters are applied. Single hot path; every
// aggregation reuses it.
// --------------------------------------------------------------
function* iterFilteredGames(filters) {
    const db = dbCache.meta.data;
    for (const build of Object.keys(db)) {
        const bd = db[build] || {};
        const games = bd.games || [];
        for (const g of games) {
            if (gameMatches(g, build, filters)) yield { build, game: g };
        }
    }
}

// --------------------------------------------------------------
// AGGREGATIONS
// --------------------------------------------------------------
function summarize(filters) {
    return cachedAgg('summary', filters, () => {
        let wins = 0, losses = 0, total = 0;
        const byMatchup = {};
        const byMap = {};
        const recent = [];
        for (const { build, game } of iterFilteredGames(filters)) {
            total++;
            if (isWin(game))  wins++;
            else if (isLoss(game)) losses++;
            const mu = `vs ${game.opp_race || 'Unknown'}`;
            byMatchup[mu] = byMatchup[mu] || { wins: 0, losses: 0 };
            if (isWin(game))  byMatchup[mu].wins++;
            else if (isLoss(game)) byMatchup[mu].losses++;
            const m = game.map || 'Unknown';
            byMap[m] = byMap[m] || { wins: 0, losses: 0 };
            if (isWin(game))  byMap[m].wins++;
            else if (isLoss(game)) byMap[m].losses++;
            recent.push({
                id: game.id,
                date: game.date,
                map: game.map,
                opponent: game.opponent,
                opp_race: game.opp_race,
                opp_strategy: game.opp_strategy,
                result: game.result,
                build,
            });
        }
        recent.sort((a, b) => parseGameDate(b.date) - parseGameDate(a.date));
        return {
            totals: { wins, losses, total, winRate: total ? wins / total : 0 },
            byMatchup,
            byMap,
            recent: recent.slice(0, 20),
        };
    });
}

// --------------------------------------------------------------
// FULL REPLAY LIST -- powers the Map Intel selector dropdown.
// Returns every game across every build that has a `file_path`
// (i.e. is actually openable in the playback viewer). The
// aggregation is cached by global filters; the cheap post-cache
// pass below applies search / sort / limit so we don't blow up
// the cache key with arbitrary search strings.
// --------------------------------------------------------------
function gamesList(filters) {
    return cachedAgg('games-list', filters, () => {
        const out = [];
        for (const { build, game } of iterFilteredGames(filters)) {
            if (!game || !game.file_path) continue;
            out.push({
                id: game.id || game.game_id || null,
                date: game.date || null,
                map: game.map || '',
                opponent: game.opponent || '',
                opp_race: game.opp_race || '',
                opp_strategy: game.opp_strategy || null,
                result: game.result || '',
                build,
                file_path: game.file_path,
                game_length: game.game_length || 0,
                macro_score: (typeof game.macro_score === 'number') ? game.macro_score : null,
            });
        }
        // Pre-sorted newest-first; the route handler may re-sort.
        out.sort((a, b) => parseGameDate(b.date) - parseGameDate(a.date));
        return out;
    });
}

function builds(filters) {
    return cachedAgg('builds', filters, () => {
        const out = {};
        for (const { build, game } of iterFilteredGames(filters)) {
            out[build] = out[build] || { wins: 0, losses: 0, total: 0, lastPlayed: 0 };
            out[build].total++;
            if (isWin(game))  out[build].wins++;
            else if (isLoss(game)) out[build].losses++;
            const t = parseGameDate(game.date);
            if (Number.isFinite(t) && t > out[build].lastPlayed) out[build].lastPlayed = t;
        }
        return Object.entries(out)
            .map(([name, s]) => ({
                name,
                wins: s.wins,
                losses: s.losses,
                total: s.total,
                winRate: s.total ? s.wins / s.total : 0,
                lastPlayed: s.lastPlayed || null,
            }))
            .sort((a, b) => b.total - a.total);
    });
}

function oppStrategies(filters) {
    return cachedAgg('opp_strategies', filters, () => {
        const out = {};
        for (const { game } of iterFilteredGames(filters)) {
            const k = game.opp_strategy || 'Unknown';
            out[k] = out[k] || { wins: 0, losses: 0, total: 0 };
            out[k].total++;
            if (isWin(game))  out[k].wins++;
            else if (isLoss(game)) out[k].losses++;
        }
        return Object.entries(out)
            .map(([name, s]) => ({ name, ...s, winRate: s.total ? s.wins / s.total : 0 }))
            .sort((a, b) => b.total - a.total);
    });
}

function buildVsStrategy(filters) {
    return cachedAgg('build_vs_strategy', filters, () => {
        const out = new Map();
        for (const { build, game } of iterFilteredGames(filters)) {
            const k = `${build}${game.opp_strategy || 'Unknown'}`;
            const cur = out.get(k) || { my_build: build, opp_strat: game.opp_strategy || 'Unknown', wins: 0, losses: 0, total: 0 };
            cur.total++;
            if (isWin(game))  cur.wins++;
            else if (isLoss(game)) cur.losses++;
            out.set(k, cur);
        }
        return [...out.values()]
            .map(r => ({ ...r, winRate: r.total ? r.wins / r.total : 0 }))
            .sort((a, b) => b.total - a.total);
    });
}

function maps(filters) {
    return cachedAgg('maps', filters, () => {
        const out = {};
        for (const { game } of iterFilteredGames(filters)) {
            const m = game.map || 'Unknown';
            out[m] = out[m] || { wins: 0, losses: 0, total: 0 };
            out[m].total++;
            if (isWin(game))  out[m].wins++;
            else if (isLoss(game)) out[m].losses++;
        }
        return Object.entries(out)
            .map(([name, s]) => ({ name, ...s, winRate: s.total ? s.wins / s.total : 0 }))
            .sort((a, b) => b.total - a.total);
    });
}

function matchups(filters) {
    return cachedAgg('matchups', filters, () => {
        const out = {};
        for (const { game } of iterFilteredGames(filters)) {
            const r = (game.opp_race || 'Unknown').charAt(0).toUpperCase();
            const k = `vs ${r === 'U' ? 'Unknown' : r}`;
            out[k] = out[k] || { wins: 0, losses: 0, total: 0 };
            out[k].total++;
            if (isWin(game))  out[k].wins++;
            else if (isLoss(game)) out[k].losses++;
        }
        return Object.entries(out)
            .map(([name, s]) => ({ name, ...s, winRate: s.total ? s.wins / s.total : 0 }))
            .sort((a, b) => b.total - a.total);
    });
}

// --------------------------------------------------------------
// OPPONENT HISTORY -- pulls from MyOpponentHistory.json
// --------------------------------------------------------------
// MyOpponentHistory.json records are written by the live overlay watcher
// at game-end and frequently lack the deeper post-game fields (opp_strategy,
// map, build_log). meta_database.json is the post-game analyzer's output
// and DOES carry those. We cross-link the two on game_id so an opponent's
// profile gets the richest available picture.
//
// Cache the index under the meta-DB revision so we only rebuild it when
// the meta DB actually moves.
let _metaIndexRevision = -1;
let _metaIndexById = null;
let _metaIndexByOppDate = null;

// Strip Battle.net discriminator and clan tags so SC2Pulse-derived names
// (e.g. "Melody#181", "[CLAN]Foo") match the in-replay names stored in
// meta_database.json (e.g. "Melody", "Foo"). Lowercased.
function _normalizeOpponentName(raw) {
    if (!raw) return '';
    let s = String(raw);
    // Strip leading "[clan]" tag.
    s = s.replace(/^\[[^\]]{1,8}\]\s*/, '');
    // Strip Battle.net discriminator "#1234".
    s = s.replace(/#\d+$/, '');
    return s.trim().toLowerCase();
}

function _buildMetaIndex() {
    if (_metaIndexRevision === dbCache.meta.revision && _metaIndexById) return;
    const byId = new Map();
    const byOppDate = new Map();
    const meta = dbCache.meta.data || {};
    for (const buildName of Object.keys(meta)) {
        const bd = meta[buildName];
        if (!bd || typeof bd !== 'object') continue;
        for (const g of bd.games || []) {
            if (!g || typeof g !== 'object') continue;
            const gid = g.id || g.game_id;
            if (gid) byId.set(gid, { game: g, build: buildName });
            // Some Black-Book records don't carry a game_id; secondary lookup
            // by `${opp_name}|${date_prefix}` lets us still match by date.
            // We register each meta game under TWO keys -- the literal
            // lowercased opponent name AND the normalized (clan-tag- and
            // discriminator-stripped) form -- so opp records that carry a
            // BattleTag like "Melody#181" still find the meta entry whose
            // in-replay name is "Melody".
            const datePrefix = String(g.date || '').slice(0, 10);
            if (!datePrefix) continue;
            const rawOpp = g.opponent || '';
            const literal = `${rawOpp.toLowerCase()}|${datePrefix}`;
            const norm = `${_normalizeOpponentName(rawOpp)}|${datePrefix}`;
            const entry = { game: g, build: buildName };
            if (rawOpp) {
                if (!byOppDate.has(literal)) byOppDate.set(literal, []);
                byOppDate.get(literal).push(entry);
                if (norm !== literal) {
                    if (!byOppDate.has(norm)) byOppDate.set(norm, []);
                    byOppDate.get(norm).push(entry);
                }
            }
        }
    }
    _metaIndexById = byId;
    _metaIndexByOppDate = byOppDate;
    _metaIndexRevision = dbCache.meta.revision;
}

// Normalise a result-ish string from either Result/result on either DB:
// "Win"/"Victory" -> "win", "Loss"/"Defeat" -> "loss", else "".
function _resultBucket(g) {
    const r = (g && (g.result || g.Result)) || '';
    const s = String(r).toLowerCase();
    if (s === 'win' || s === 'victory') return 'win';
    if (s === 'loss' || s === 'defeat') return 'loss';
    return '';
}

// Mutate `g` to add fields from any matching meta_database.json record.
//
// Matching strategy (each step is tried only if the previous misses):
//   1. Exact game_id (id / game_id / GameId / gameId).
//   2. oppName|YYYY-MM-DD with exactly 1 candidate.
//   3. oppName|YYYY-MM-DD with multiple candidates -> score each by:
//      - result agreement (Win/Victory, Loss/Defeat)              +3
//      - map agreement (g.Map / g.map vs meta.map)                +2
//      - game-length proximity within 60s                         +2
//      - timestamp proximity (same hour:minute)                   +1
//      Pick the highest score with score >= 1; otherwise no match.
//
// This fixes the long-standing bug where playing the same opponent
// twice on the same day silently lost map / build_log / opp_strategy
// / macro_score on the opponent profile page.
function _scoreMetaMatch(opp, meta) {
    let s = 0;
    const ro = _resultBucket(opp);
    const rm = _resultBucket(meta);
    if (ro && rm && ro === rm) s += 3;

    const mo = (opp.Map || opp.map || '').toString().toLowerCase();
    const mm = (meta.map || '').toString().toLowerCase();
    if (mo && mm && mo === mm) s += 2;

    const lo = Number(opp.game_length || opp.GameLength || 0);
    const lm = Number(meta.game_length || 0);
    if (lo > 0 && lm > 0 && Math.abs(lo - lm) <= 60) s += 2;

    // Timestamp proximity: only if both have a time-of-day component.
    const dRawO = String(opp.Date || opp.date || opp.DateTime || '');
    const dRawM = String(meta.date || '');
    if (dRawO.length > 10 && dRawM.length > 10) {
        const hmO = dRawO.slice(11, 16); // HH:MM
        const hmM = dRawM.slice(11, 16);
        if (hmO && hmM && hmO === hmM) s += 1;
    }
    return s;
}

function _enrichFromMeta(g, oppName) {
    const gid = g.id || g.game_id || g.GameId || g.gameId;
    let match = null;
    if (gid && _metaIndexById && _metaIndexById.has(gid)) {
        match = _metaIndexById.get(gid).game;
    }
    if (!match && _metaIndexByOppDate && oppName) {
        const dateRaw = g.Date || g.date || g.DateTime || '';
        const datePrefix = String(dateRaw).slice(0, 10);
        // Try the literal lowercased name first; if that misses (most
        // commonly because the opp record has a "#1234" battle.net
        // discriminator that the in-replay name doesn't), retry with the
        // normalized form. Both lookup keys are populated by
        // _buildMetaIndex so the literal hit covers the common case
        // without ever stripping anything.
        const literal = `${String(oppName).toLowerCase()}|${datePrefix}`;
        let candidates = _metaIndexByOppDate.get(literal);
        if (!candidates) {
            const norm = `${_normalizeOpponentName(oppName)}|${datePrefix}`;
            if (norm !== literal) candidates = _metaIndexByOppDate.get(norm);
        }
        if (candidates && candidates.length === 1) {
            match = candidates[0].game;
        } else if (candidates && candidates.length > 1) {
            // Multi-candidate disambiguation -- score each and pick the
            // best with score >= 1.
            let best = null, bestScore = 0;
            for (const c of candidates) {
                const s = _scoreMetaMatch(g, c.game);
                if (s > bestScore) { best = c.game; bestScore = s; }
            }
            if (best && bestScore >= 1) match = best;
        }
    }
    if (!match) return g;
    // Prefer Black-Book fields that are present, fill in the rest from meta.
    if (!g.opp_strategy && match.opp_strategy) g.opp_strategy = match.opp_strategy;
    // Opponent race -- meta_database.json stores the authoritative full
    // race name ("Terran"/"Protoss"/"Zerg"). Black-Book records often
    // lack opp_race entirely (only the "PROTOSSvTERRAN" Matchup key
    // carries it), which previously caused the opponent profile table
    // to fall back to charAt(0) of the Matchup -- yielding the USER's
    // race ("P") instead of the opponent's. Copy it here so the table,
    // race filters, and race-derived UI all see the right value.
    if (!g.opp_race && match.opp_race) g.opp_race = match.opp_race;
    if (!g.Map && match.map) g.Map = match.map;
    if (!g.map && match.map) g.map = match.map;
    if (!g.build_log && Array.isArray(match.build_log)) g.build_log = match.build_log;
    if (!g.my_build && match.my_build) g.my_build = match.my_build;
    if ((g.macro_score == null || g.macro_score === undefined) &&
            typeof match.macro_score === 'number') {
        g.macro_score = match.macro_score;
    }
    if (!g.top_3_leaks && Array.isArray(match.top_3_leaks)) g.top_3_leaks = match.top_3_leaks;
    if (!g.macro_breakdown && match.macro_breakdown && typeof match.macro_breakdown === 'object') {
        g.macro_breakdown = match.macro_breakdown;
    }
    if (!g.game_length && match.game_length) g.game_length = match.game_length;
    if (!g.id && (match.id || match.game_id)) g.id = match.id || match.game_id;
    if (!g.file_path && match.file_path) g.file_path = match.file_path;
    return g;
}

function flattenOpponentGames(rec) {
    const games = [];
    const oppName = rec && rec.Name ? rec.Name : '';
    _buildMetaIndex();
    if (Array.isArray(rec.Games)) {
        for (const g of rec.Games) games.push(_enrichFromMeta({ ...g }, oppName));
    }
    if (rec.Matchups) {
        for (const mu of Object.keys(rec.Matchups)) {
            const list = (rec.Matchups[mu] || {}).Games || [];
            for (const g of list) games.push(_enrichFromMeta({ ...g, Matchup: mu }, oppName));
        }
    }
    return games;
}

// Pull authoritative W/L totals from a MyOpponentHistory record.
// Sums top-level Wins/Losses plus each matchup's Wins/Losses --
// these are written by the PowerShell scanner *every game* so they
// are the source of truth, regardless of how individual game
// records have their `Result` field formatted (Victory / Defeat /
// Win / Loss / etc).
function totalsFromRecord(rec) {
    let wins = 0, losses = 0;
    if (Number.isFinite(Number(rec.Wins)))   wins   += Number(rec.Wins);
    if (Number.isFinite(Number(rec.Losses))) losses += Number(rec.Losses);
    if (rec.Matchups) {
        for (const mu of Object.keys(rec.Matchups)) {
            const m = rec.Matchups[mu] || {};
            if (Number.isFinite(Number(m.Wins)))   wins   += Number(m.Wins);
            if (Number.isFinite(Number(m.Losses))) losses += Number(m.Losses);
        }
    }
    return { wins, losses };
}

// Apply the global filter bar (since/until/race/opp_race/map/mmr) to one
// opponent game record. Returns true if the game should be kept.
//
// This is a relaxed version of `gameMatches`: opponent records don't
// carry a `build` (those live in meta_database.json), so we skip the
// build-derived race fallback and instead trust `g.my_race` when set.
// If `my_race` isn't recorded, the my-race filter is a no-op for that
// game rather than dropping it.
function opponentGameMatches(g, filters) {
    if (!filters || Object.keys(filters).length === 0) return true;
    if (filters.oppRace) {
        const r = (g.opp_race || '').charAt(0).toUpperCase();
        if (r !== filters.oppRace) return false;
    }
    if (filters.race && g.my_race) {
        const r = String(g.my_race).charAt(0).toUpperCase();
        if (r !== filters.race) return false;
    }
    if (filters.map) {
        const m = (g.map || g.Map || '').toLowerCase();
        if (!m.includes(filters.map)) return false;
    }
    if (filters.oppStrategy && (g.opp_strategy || 'Unknown') !== filters.oppStrategy) return false;
    if (filters.since || filters.until) {
        const t = parseGameDate(g.date || g.Date);
        if (!Number.isFinite(t)) return false;
        if (filters.since && t < filters.since) return false;
        if (filters.until && t > filters.until) return false;
    }
    if (filters.mmrMin && Number.isFinite(g.opp_mmr) && g.opp_mmr < filters.mmrMin) return false;
    if (filters.mmrMax && Number.isFinite(g.opp_mmr) && g.opp_mmr > filters.mmrMax) return false;
    return true;
}

function opponents(query) {
    return cachedAgg('opponents:' + JSON.stringify(query || {}), null, () => {
        const search = (query.search || '').toLowerCase();
        const minGames = Number(query.min_games) || 0;
        const limit = Math.min(Number(query.limit) || 200, 1000);
        const sortBy = query.sort || 'lastPlayed';
        // Re-parse the global filter bar (since/until/race/opp_race/map/mmr).
        // When any are present, we ignore the record-level stored totals
        // and re-count from the surviving subset of games -- otherwise the
        // "Last 7 days" view would still show the all-time W/L numbers.
        const filters = parseFilters(query);
        const filtersActive = filters && Object.keys(filters).length > 0;
        const out = [];
        const db = dbCache.opp.data;
        for (const pulseId of Object.keys(db)) {
            const r = db[pulseId] || {};
            const name = r.Name || '';
            if (search && !name.toLowerCase().includes(search) && !pulseId.includes(search)) continue;
            let games = flattenOpponentGames(r);
            if (filtersActive) {
                games = games.filter(g => opponentGameMatches(g, filters));
            }
            let wins = 0, losses = 0;
            if (filtersActive) {
                // Filtered window -- always recount from the surviving games.
                for (const g of games) {
                    if (isWin(g))  wins++;
                    else if (isLoss(g)) losses++;
                }
            } else {
                // Whole-history view -- prefer the stored totals on the
                // record (the PS scanner writes those every game). Fall
                // back to counting only when the record has no totals
                // (very old records).
                const stored = totalsFromRecord(r);
                wins = stored.wins; losses = stored.losses;
                if (wins === 0 && losses === 0 && games.length > 0) {
                    for (const g of games) {
                        if (isWin(g))  wins++;
                        else if (isLoss(g)) losses++;
                    }
                }
            }
            // "games played" is the larger of (counted records) and
            // (W+L), so we never under-report when the games array is
            // truncated but totals are intact. With filters active the
            // games array IS the source of truth so the max is moot.
            const total = filtersActive
                ? games.length
                : Math.max(games.length, wins + losses);
            if (total < minGames) continue;
            // If filters are active and the opponent has zero surviving
            // games, drop them entirely (they didn't appear in the window).
            if (filtersActive && total === 0) continue;
            let lastPlayed = 0;
            for (const g of games) {
                const t = gameDate(g);
                if (Number.isFinite(t) && t > lastPlayed) lastPlayed = t;
            }
            out.push({
                pulseId,
                name,
                games: total,
                wins,
                losses,
                winRate: total ? wins / total : 0,
                lastPlayed: lastPlayed || null,
            });
        }
        const cmp = {
            lastPlayed: (a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0),
            games:      (a, b) => b.games - a.games,
            winRate:    (a, b) => b.winRate - a.winRate,
            name:       (a, b) => a.name.localeCompare(b.name),
        }[sortBy] || ((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));
        out.sort(cmp);
        return out.slice(0, limit);
    });
}


// --------------------------------------------------------------
// DNA helpers (matchup-aware median timings + recency-weighted predict)
// --------------------------------------------------------------

// Build_log line regex: "[m:ss] BuildingName".
const _TIMING_RE = /^\[(\d+):(\d{2})\]\s+(\w+)/;

// Trend thresholds (mirror analytics.opponent_profiler._compute_trend).
const _TREND_ABS_SECONDS = 5.0;
const _TREND_REL_FRACTION = 0.05;

function _formatSeconds(sec) {
    const t = Math.max(0, Math.floor(sec));
    return `${Math.floor(t/60)}:${String(t%60).padStart(2,'0')}`;
}

function _median(arr) {
    if (!arr.length) return null;
    const s = [...arr].sort((a,b) => a-b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2;
}

// Inclusive method (matches Python statistics.quantiles(method='inclusive')).
// p=0.25 returns the 25th percentile, p=0.75 the 75th. Result stays inside
// [min, max] of the sample, which avoids confusing the UI.
function _percentileInclusive(sortedAsc, p) {
    const n = sortedAsc.length;
    if (n === 0) return null;
    if (n === 1) return sortedAsc[0];
    const rank = p * (n - 1);
    const lo = Math.floor(rank);
    const hi = Math.ceil(rank);
    if (lo === hi) return sortedAsc[lo];
    const frac = rank - lo;
    return sortedAsc[lo] + frac * (sortedAsc[hi] - sortedAsc[lo]);
}

// Mann-Kendall-lite over chronologically ordered samples. < 4 samples
// returns 'unknown'; otherwise compares the medians of the two halves
// against an absolute (5s) and relative (5%) threshold floor.
function _computeTrend(secondsChrono) {
    const n = secondsChrono.length;
    if (n < 4) return 'unknown';
    const mid = Math.floor(n / 2);
    const m1 = _median(secondsChrono.slice(0, mid));
    const m2 = _median(secondsChrono.slice(mid));
    const diff = m2 - m1;
    const threshold = Math.max(_TREND_ABS_SECONDS, _TREND_REL_FRACTION * m1);
    if (Math.abs(diff) < threshold) return 'stable';
    return diff > 0 ? 'later' : 'earlier';
}

function _emptyTokenRow(token, source) {
    return {
        sampleCount: 0,
        medianSeconds: null, medianDisplay: '-',
        p25Seconds: null,    p25Display:    '-',
        p75Seconds: null,    p75Display:    '-',
        minSeconds: null,    minDisplay:    '-',
        maxSeconds: null,    maxDisplay:    '-',
        lastSeenSeconds: null, lastSeenDisplay: '-',
        winRateWhenBuilt: null,
        trend: 'unknown',
        source: source,
        samples: [],
    };
}

// Build-log fields can come in several casings / formats from the
// upstream JSON files. Resolve once.
function _readBuildLog(g, key) {
    const cap = key.charAt(0).toUpperCase() + key.slice(1);
    return g[key] || g[cap] || g[key + 'Log'] || g[cap + 'Log'] || null;
}

// Walk a build_log and return the smallest seconds at which a line
// whose name contains `tokenSubstring` appears (first-occurrence wins).
function _firstOccurrenceSeconds(log, tokenSubstring) {
    if (!Array.isArray(log) || log.length === 0) return null;
    const tokLower = tokenSubstring.toLowerCase();
    let best = null;
    for (const line of log) {
        const m = _TIMING_RE.exec(String(line || ''));
        if (!m) continue;
        const name = m[3].toLowerCase();
        if (name.indexOf(tokLower) === -1) continue;
        const sec = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
        if (best === null || sec < best) best = sec;
    }
    return best;
}

/**
 * Compute matchup-aware median first-occurrence timings.
 *
 * Mirrors `OpponentProfiler._compute_median_timings` in
 * `analytics/opponent_profiler.py`. For each game in `games`:
 *   1. Derive the per-game matchup from `g.opp_race` and `myRace`.
 *   2. `relevantTokens(myRace, oppRace)` decides which tokens are eligible
 *      for THAT game (PvZ never collects Barracks samples).
 *   3. Source the timing from `opp_build_log` for opponent-race tokens
 *      and `build_log` for the user's-race tokens.
 *
 * Results are keyed by `internalName` and ordered by
 * `relevantTokens(myRace, modalOppRace)`. Tokens with no samples still
 * appear with `sampleCount === 0`.
 *
 * Returns `{}` if `myRace` is unknown.
 */
function computeMatchupAwareMedianTimings(games, myRace) {
    const my = TimingCatalog.normalizeRace(myRace);
    if (!my) return {};
    const list = games || [];

    // Modal opponent race for canonical ordering.
    const oppCount = Object.create(null);
    for (const g of list) {
        const r = TimingCatalog.normalizeRace(g.opp_race);
        if (r) oppCount[r] = (oppCount[r] || 0) + 1;
    }
    let modalOpp = '';
    let modalCount = -1;
    for (const r of Object.keys(oppCount)) {
        if (oppCount[r] > modalCount) { modalCount = oppCount[r]; modalOpp = r; }
    }

    const ownInternalSet = new Set(
        TimingCatalog.RACE_BUILDINGS[my].map(t => t.internalName)
    );

    if (!modalOpp) {
        // No usable opp_race in any game -- return own-race tokens with empty rows.
        const out = {};
        TimingCatalog.RACE_BUILDINGS[my].forEach(tok => {
            out[tok.internalName] = _emptyTokenRow(
                tok, ownInternalSet.has(tok.internalName) ? 'build_log' : 'opp_build_log'
            );
        });
        return out;
    }

    const ordering = TimingCatalog.relevantTokens(my, modalOpp);
    if (ordering.length === 0) return {};

    // Per-token sample collection.
    const samples = Object.create(null);
    for (const tok of ordering) samples[tok.internalName] = [];

    for (const g of list) {
        const oppRace = TimingCatalog.normalizeRace(g.opp_race);
        if (!oppRace) continue;
        const eligible = TimingCatalog.relevantTokens(my, oppRace);
        if (eligible.length === 0) continue;
        const dateStr = g.date || g.Date || '';
        const mapName = g.map || g.Map || '';
        const result = g.result || g.Result || '';
        const won = (result === 'Win' || result === 'Victory');
        const gameId = g.id || g.game_id || g.GameId || g.gameId || null;

        const myLog = _readBuildLog(g, 'build_log');
        const oppLog = _readBuildLog(g, 'opp_build_log');

        for (const tok of eligible) {
            if (samples[tok.internalName] === undefined) continue;
            const log = ownInternalSet.has(tok.internalName) ? myLog : oppLog;
            const sec = _firstOccurrenceSeconds(log, tok.token);
            if (sec === null) continue;
            samples[tok.internalName].push({
                seconds: sec,
                display: _formatSeconds(sec),
                date: dateStr,
                map: mapName,
                won: won,
                result: result || '',
                gameId: gameId,
                oppRace: oppRace,
                myRace: my,
            });
        }
    }

    // Build the output in canonical order.
    const out = {};
    for (const tok of ordering) {
        const source = ownInternalSet.has(tok.internalName) ? 'build_log' : 'opp_build_log';
        const list2 = samples[tok.internalName];
        if (!list2 || list2.length === 0) {
            out[tok.internalName] = _emptyTokenRow(tok, source);
            continue;
        }
        list2.sort((a, b) => String(a.date).localeCompare(String(b.date)));
        const secondsList = list2.map(s => s.seconds);
        const sortedAsc = [...secondsList].sort((a, b) => a - b);
        const n = secondsList.length;
        const med = _median(secondsList);
        const p25 = Math.round(_percentileInclusive(sortedAsc, 0.25));
        const p75 = Math.round(_percentileInclusive(sortedAsc, 0.75));
        const mn = sortedAsc[0];
        const mx = sortedAsc[n - 1];
        const lastSeen = list2[list2.length - 1].seconds;
        const winsCount = list2.reduce((a, s) => a + (s.won ? 1 : 0), 0);

        out[tok.internalName] = {
            sampleCount: n,
            medianSeconds: med,
            medianDisplay: _formatSeconds(med),
            p25Seconds: p25,
            p25Display: _formatSeconds(p25),
            p75Seconds: p75,
            p75Display: _formatSeconds(p75),
            minSeconds: mn,
            minDisplay: _formatSeconds(mn),
            maxSeconds: mx,
            maxDisplay: _formatSeconds(mx),
            lastSeenSeconds: lastSeen,
            lastSeenDisplay: _formatSeconds(lastSeen),
            winRateWhenBuilt: winsCount / n,
            trend: _computeTrend(secondsList),
            source: source,
            samples: list2.slice().reverse(),
        };
    }
    return out;
}


/**
 * Per-matchup wrapper around `computeMatchupAwareMedianTimings`.
 *
 * Mirrors `OpponentProfiler._compute_median_timings_for_matchup` in
 * `analytics/opponent_profiler.py`. Filters `games` to those whose
 * `opp_race` matches the requested race before delegating, so the
 * resulting timings dict is scoped to that matchup only. Token order
 * is forced to the requested matchup so the same building shows up in
 * the same column whether the matchup has 1 game or 100.
 *
 * Returns `{}` when `myRace` is unknown. When `oppRace` is unknown /
 * blank, falls back to the all-matchup view (matches the Python
 * wrapper's behavior - convenient for the "All" chip case).
 */
function computeMedianTimingsForMatchup(games, myRace, oppRace) {
    const my  = TimingCatalog.normalizeRace(myRace);
    const opp = TimingCatalog.normalizeRace(oppRace);
    if (!my) return {};
    if (!opp) return computeMatchupAwareMedianTimings(games, myRace);
    const filtered = (games || []).filter(g =>
        TimingCatalog.normalizeRace(g.opp_race) === opp
    );
    if (filtered.length === 0) {
        // Empty-shape: own-race tokens with sample_count=0, so the UI
        // can render "no samples in this matchup" cards in stable slots.
        const out = {};
        const ownInternalSet = new Set(
            TimingCatalog.RACE_BUILDINGS[my].map(t => t.internalName)
        );
        const ordering = TimingCatalog.relevantTokens(my, opp);
        for (const tok of ordering) {
            const source = ownInternalSet.has(tok.internalName)
                ? 'build_log' : 'opp_build_log';
            out[tok.internalName] = _emptyTokenRow(tok, source);
        }
        return out;
    }
    return computeMatchupAwareMedianTimings(filtered, myRace);
}

// Resolve `myRace` for a single game. Falls back through the layered
// schema this app sees in the wild:
//   1. Explicit `my_race` field (set by the live overlay watcher).
//   2. Black-Book `Matchup` key prefix ("PvT", "PROTOSSvTERRAN", ...).
//   3. `my_build` prefix ("Zerg - 12 Pool", "Protoss - Stargate Opener").
//   4. `build`/`build_name` prefix (per-game alias of the same).
// Returns 'P'/'T'/'Z' or '' if no signal is available.
function _resolveMyRaceFromGame(g) {
    if (!g) return '';
    const direct = TimingCatalog.normalizeRace(g.my_race);
    if (direct) return direct;
    const mu = g.Matchup || g.matchup || '';
    if (mu) {
        // "PvT" -> "P", "PROTOSSvTERRAN" -> "P", "ZvP" -> "Z".
        const head = String(mu).split(/[vV]/)[0].trim();
        if (head) {
            const r = TimingCatalog.normalizeRace(head);
            if (r) return r;
            // Try the very first character ("P", "T", "Z") so prefixes
            // like "PvT" still resolve when the head doesn't normalize.
            const first = TimingCatalog.normalizeRace(head[0]);
            if (first) return first;
        }
    }
    for (const field of ['my_build', 'build', 'build_name']) {
        const bn = String(g[field] || '');
        if (!bn) continue;
        // Build names start with "Zerg - ...", "Protoss - ...", "Terran - ...".
        if (/^zerg/i.test(bn))    return 'Z';
        if (/^protoss/i.test(bn)) return 'P';
        if (/^terran/i.test(bn))  return 'T';
        // Or PvT-style matchup prefix on the build itself.
        const mhead = bn.split(/[vV]/)[0].trim();
        const r = TimingCatalog.normalizeRace(mhead) || TimingCatalog.normalizeRace(mhead[0]);
        if (r) return r;
    }
    return '';
}

// Resolve `myRace` for an opponent-detail payload. Prefer the most
// recent game's resolved race, fall back to the most common one across
// all games. Returns 'P'/'T'/'Z' or '' if unknown. Reads through
// `_resolveMyRaceFromGame` so it picks up Matchup / my_build / build
// fallbacks when the explicit `my_race` field is missing (which is
// the common case for Black-Book-only records).
function _resolveMyRace(games) {
    if (!games || games.length === 0) return '';
    for (const g of games) {
        const r = _resolveMyRaceFromGame(g);
        if (r) return r;
    }
    const c = Object.create(null);
    for (const g of games) {
        const r = _resolveMyRaceFromGame(g);
        if (r) c[r] = (c[r] || 0) + 1;
    }
    let best = '';
    let bestN = -1;
    for (const r of Object.keys(c)) if (c[r] > bestN) { bestN = c[r]; best = r; }
    return best;
}

function _resolveModalOppRace(games) {
    if (!games || games.length === 0) return '';
    const c = Object.create(null);
    for (const g of games) {
        const r = TimingCatalog.normalizeRace(g.opp_race);
        if (r) c[r] = (c[r] || 0) + 1;
    }
    let best = '';
    let bestN = -1;
    for (const r of Object.keys(c)) if (c[r] > bestN) { bestN = c[r]; best = r; }
    return best;
}

// Recency-weighted distribution over `opp_strategy`. Last 10 games
// (most recent by date desc) count 2x, every other game 1x.
// `games` is expected to already be in newest-first order.
function recencyWeightedStrategies(games) {
    if (!games || games.length === 0) return [];
    const weighted = new Map();
    let totalW = 0;
    for (let i = 0; i < games.length; i++) {
        const w = i < 10 ? 2.0 : 1.0;
        const s = (games[i].opp_strategy || games[i].opp_strategy === '') ? (games[i].opp_strategy || 'Unknown') : 'Unknown';
        weighted.set(s, (weighted.get(s) || 0) + w);
        totalW += w;
    }
    if (totalW <= 0) return [];
    return [...weighted.entries()]
        .map(([strategy, w]) => ({ strategy, probability: w / totalW }))
        .sort((a, b) => b.probability - a.probability);
}

// --------------------------------------------------------------
// PER-BUILD DETAIL (deep dive)
// --------------------------------------------------------------
function buildDetail(buildName, filters) {
    if (!buildName) return null;
    const bd = dbCache.meta.data[buildName];
    if (!bd || typeof bd !== 'object' || !Array.isArray(bd.games)) return null;
    const games = bd.games.filter(g => gameMatches(g, buildName, filters || {}));
    games.sort((a, b) => parseGameDate(b.date) - parseGameDate(a.date));
    let wins = 0, losses = 0;
    const byOppStrategy = {}, byMap = {}, byOpponent = {};
    let lastPlayed = 0;
    for (const g of games) {
        if (isWin(g))  wins++;
        else if (isLoss(g)) losses++;
        const s = g.opp_strategy || 'Unknown';
        byOppStrategy[s] = byOppStrategy[s] || { wins: 0, losses: 0 };
        if (isWin(g))  byOppStrategy[s].wins++;
        else if (isLoss(g)) byOppStrategy[s].losses++;
        const m = g.map || 'Unknown';
        byMap[m] = byMap[m] || { wins: 0, losses: 0 };
        if (isWin(g))  byMap[m].wins++;
        else if (isLoss(g)) byMap[m].losses++;
        const o = g.opponent || 'Unknown';
        byOpponent[o] = byOpponent[o] || { wins: 0, losses: 0 };
        if (isWin(g))  byOpponent[o].wins++;
        else if (isLoss(g)) byOpponent[o].losses++;
        const t = parseGameDate(g.date);
        if (Number.isFinite(t) && t > lastPlayed) lastPlayed = t;
    }
    const total = games.length;
    // Stamp the parent build name on each game record before returning so the
    // SPA's GamesTableWithBuildOrder can render g.my_build in the "My Build"
    // column. Records under meta.data[buildName].games[] don't carry my_build
    // themselves -- the build is implicit in the parent key. We do not mutate
    // the cached objects (meta DB persists to disk; cross-mutation across
    // requests would be a data hazard) -- shallow-copy each game.
    const gamesWithBuild = games.map(g => ({ ...g, my_build: buildName }));
    return {
        name: buildName,
        totals: { wins, losses, total, winRate: total ? wins / total : 0, lastPlayed: lastPlayed || null },
        byOppStrategy,
        byMap,
        byOpponent,
        games: gamesWithBuild,  // newest-first; my_build stamped from parent key
    };
}

/**
 * Resolve a game's map name across the two storage shapes the codebase
 * carries simultaneously:
 *
 *   * meta-DB enriched (preferred): ``g.map`` -- the canonical name
 *     pulled from the SC2 replay header at scan time, e.g. "10000 feet".
 *   * legacy MyOpponentHistory.json: ``g.Map`` -- often stores the
 *     literal string "Unknown Map" because the early scanner couldn't
 *     parse the map header.
 *
 * Earlier code read ``g.Map || g.map``, which let the legacy literal
 * "Unknown Map" win even when the meta-DB enrichment had a real name.
 * This helper prefers the meta-DB field and treats the literal "Unknown"
 * placeholders as missing.
 *
 * Example:
 *   resolveGameMapName({ Map: 'Unknown Map', map: '10000 feet' })
 *     -> '10000 feet'
 *   resolveGameMapName({}) -> 'Unknown'
 *
 * @param {object} g Game record from the meta-DB or MyOpponentHistory.
 * @param {string} [fallback] Returned when neither field has a real name.
 * @returns {string}
 */
function resolveGameMapName(g, fallback) {
    const fb = (typeof fallback === 'string' && fallback.length > 0)
        ? fallback : 'Unknown';
    const isPlaceholder = (s) => {
        if (typeof s !== 'string') return true;
        const t = s.trim();
        if (t.length === 0) return true;
        const lc = t.toLowerCase();
        return lc === 'unknown' || lc === 'unknown map';
    };
    if (!isPlaceholder(g && g.map)) return g.map.trim();
    if (!isPlaceholder(g && g.Map)) return g.Map.trim();
    return fb;
}

function opponentDetail(pulseId) {
    const rec = dbCache.opp.data[pulseId];
    if (!rec) return null;
    const games = flattenOpponentGames(rec);
    games.sort((a, b) => gameDate(b) - gameDate(a));
    // Authoritative totals from the record (top-level + matchups).
    const stored = totalsFromRecord(rec);
    let wins = stored.wins, losses = stored.losses;
    // Per-map and per-strategy slicing still has to come from individual
    // games (the record doesn't index W/L by map/strategy directly).
    const byMap = {};
    const byStrategy = {};
    let countedW = 0, countedL = 0;
    for (const g of games) {
        const w = isWin(g);
        const l = isLoss(g);
        if (w) countedW++;
        if (l) countedL++;
        // Prefer the meta-DB-enriched ``g.map`` over legacy ``g.Map``
        // because MyOpponentHistory.json sometimes stores the literal
        // "Unknown Map" string in g.Map even when the real name lives
        // in g.map.
        const m = resolveGameMapName(g);
        byMap[m] = byMap[m] || { wins: 0, losses: 0 };
        if (w) byMap[m].wins++; else if (l) byMap[m].losses++;
        const s = g.opp_strategy || 'Unknown';
        byStrategy[s] = byStrategy[s] || { wins: 0, losses: 0 };
        if (w) byStrategy[s].wins++; else if (l) byStrategy[s].losses++;
    }
    // Fall back to counted W/L only if the record lacks stored totals.
    if (wins === 0 && losses === 0) { wins = countedW; losses = countedL; }
    const total = Math.max(games.length, wins + losses);

    // DNA additions ---------------------------------------------------
    // Top 5 strategies (sorted by total games), with W/L per strategy.
    const topStrategies = Object.entries(byStrategy)
        .map(([name, v]) => {
            const tot = v.wins + v.losses;
            return {
                strategy: name,
                wins: v.wins,
                losses: v.losses,
                count: tot,
                winRate: tot ? v.wins / tot : 0,
            };
        })
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);

    // Matchup-aware median timings. `myRace` and `oppRaceModal` drive
    // canonical token ordering and the matchup label the SPA renders.
    const myRace = _resolveMyRace(games);
    const oppRaceModal = _resolveModalOppRace(games);
    const medianTimings = computeMatchupAwareMedianTimings(games, myRace);
    const medianTimingsOrder = Object.keys(medianTimings);
    const matchupLabel = TimingCatalog.matchupLabel(myRace, oppRaceModal);

    // Per-matchup chip data + per-matchup timing payload. The SPA's
    // `MedianTimingsGrid` reads `matchupCounts` to render chip labels
    // (e.g. "PvZ (8)") and reads `matchupTimings[label]` when the user
    // selects a specific matchup. The default "All" chip continues to
    // use the unfiltered `medianTimings` field (so legacy clients keep
    // working unchanged).
    const matchupCounts = {};
    if (myRace) {
        for (const g of games) {
            const r = TimingCatalog.normalizeRace(g.opp_race);
            if (!r) continue;
            const ml = TimingCatalog.matchupLabel(myRace, r);
            if (!ml) continue;
            matchupCounts[ml] = (matchupCounts[ml] || 0) + 1;
        }
    }
    const matchupTimings = {};
    if (myRace) {
        for (const ml of Object.keys(matchupCounts)) {
            // Pull the opp_race out of the label tail ("PvZ" -> "Z").
            const opp = ml.slice(-1);
            const t = computeMedianTimingsForMatchup(games, myRace, opp);
            matchupTimings[ml] = {
                timings: t,
                order: Object.keys(t),
            };
        }
    }

    const last5Games = games.slice(0, 5);
    const predictedStrategies = recencyWeightedStrategies(games);

    return {
        pulseId,
        name: rec.Name || '',
        totals: { wins, losses, total, winRate: total ? wins / total : 0 },
        byMap,
        byStrategy,
        games,
        topStrategies,
        medianTimings,
        medianTimingsOrder,
        matchupLabel,
        matchupCounts,
        matchupTimings,
        myRace,
        oppRaceModal,
        last5Games,
        predictedStrategies,
    };
}

// --------------------------------------------------------------
// TIME SERIES
// --------------------------------------------------------------
function bucketKey(ms, bucket) {
    const d = new Date(ms);
    if (bucket === 'week') {
        // ISO-ish week start (Sun-anchored is fine for at-a-glance trends)
        const day = d.getUTCDay();
        const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
        return start.toISOString().slice(0, 10);
    }
    if (bucket === 'month') {
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    }
    return d.toISOString().slice(0, 10); // day
}

function timeseries(query, filters) {
    const bucket = ['day', 'week', 'month'].includes(query.bucket) ? query.bucket : 'day';
    return cachedAgg(`timeseries:${bucket}`, filters, () => {
        const buckets = {};
        for (const { game } of iterFilteredGames(filters)) {
            const t = parseGameDate(game.date);
            if (!Number.isFinite(t)) continue;
            const k = bucketKey(t, bucket);
            buckets[k] = buckets[k] || { date: k, wins: 0, losses: 0, games: 0 };
            buckets[k].games++;
            if (isWin(game))  buckets[k].wins++;
            else if (isLoss(game)) buckets[k].losses++;
        }
        return Object.values(buckets)
            .map(b => ({ ...b, winRate: b.games ? b.wins / b.games : 0 }))
            .sort((a, b) => a.date.localeCompare(b.date));
    });
}

// --------------------------------------------------------------
// EXPRESS ROUTER
// --------------------------------------------------------------
const router = express.Router();

router.use((req, _res, next) => {
    ensureLoaded();
    next();
});

router.get('/health', (_req, res) => res.json({
    ok: true,
    metaPath: META_DB_PATH,
    oppPath: OPP_HISTORY_PATH,
    metaRevision: dbCache.meta.revision,
    oppRevision: dbCache.opp.revision,
    metaLoadedAt: dbCache.meta.loadedAt,
    oppLoadedAt: dbCache.opp.loadedAt,
    cachedAggregations: dbCache.aggCache.size,
}));

router.get('/summary',           (req, res) => res.json(summarize(parseFilters(req.query))));
router.get('/games',             (req, res) => {
    // Full list of openable replays for the Map Intel selector.
    // Query params (all optional):
    //   ?search=string  - case-insensitive match against opponent/map/build/strategy
    //   ?sort=date_desc|date_asc|opponent_asc|opponent_desc|map_asc|map_desc|length_desc|length_asc
    //   ?race=Z|P|T|R   - global filter (my race; respected by parseFilters)
    //   ?opp_race=Z|P|T|R
    //   ?map=MapName    - global filter
    //   ?result=win|loss
    //   ?limit=N        - cap response size (default 2000, max 10000)
    //   ?offset=N       - pagination offset (default 0)
    let rows = gamesList(parseFilters(req.query));

    const result = String(req.query.result || '').toLowerCase();
    if (result === 'win' || result === 'loss') {
        rows = rows.filter(g => _resultBucket(g) === result);
    }

    const search = String(req.query.search || '').trim().toLowerCase();
    if (search) {
        rows = rows.filter(g =>
            String(g.opponent || '').toLowerCase().includes(search) ||
            String(g.map || '').toLowerCase().includes(search) ||
            String(g.build || '').toLowerCase().includes(search) ||
            String(g.opp_strategy || '').toLowerCase().includes(search)
        );
    }

    const sort = String(req.query.sort || 'date_desc').toLowerCase();
    const cmps = {
        date_desc:    (a, b) => parseGameDate(b.date) - parseGameDate(a.date),
        date_asc:     (a, b) => parseGameDate(a.date) - parseGameDate(b.date),
        opponent_asc: (a, b) => String(a.opponent || '').localeCompare(String(b.opponent || '')),
        opponent_desc:(a, b) => String(b.opponent || '').localeCompare(String(a.opponent || '')),
        map_asc:      (a, b) => String(a.map || '').localeCompare(String(b.map || '')),
        map_desc:     (a, b) => String(b.map || '').localeCompare(String(a.map || '')),
        length_desc:  (a, b) => (b.game_length || 0) - (a.game_length || 0),
        length_asc:   (a, b) => (a.game_length || 0) - (b.game_length || 0),
    };
    if (cmps[sort] && sort !== 'date_desc') {
        // Default already sorted date_desc inside gamesList; only re-sort if asked.
        rows = rows.slice().sort(cmps[sort]);
    }

    const total = rows.length;
    const limit  = Math.max(0, Math.min(10000, parseInt(req.query.limit, 10) || 2000));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const paged  = rows.slice(offset, offset + limit);

    res.json({ ok: true, total, offset, limit, count: paged.length, games: paged });
});
router.get('/builds',            (req, res) => res.json(builds(parseFilters(req.query))));
router.get('/builds/:name',      (req, res) => {
    const r = buildDetail(req.params.name, parseFilters(req.query));
    if (!r) return res.status(404).json({ ok: false, error: 'build not found' });
    res.json(r);
});
router.get('/opp-strategies',    (req, res) => res.json(oppStrategies(parseFilters(req.query))));
router.get('/build-vs-strategy', (req, res) => res.json(buildVsStrategy(parseFilters(req.query))));
router.get('/maps',              (req, res) => res.json(maps(parseFilters(req.query))));
router.get('/matchups',          (req, res) => res.json(matchups(parseFilters(req.query))));
router.get('/opponents',         (req, res) => res.json(opponents(req.query)));
router.get('/opponents/:pulseId', (req, res) => {
    const r = opponentDetail(req.params.pulseId);
    if (!r) return res.status(404).json({ ok: false, error: 'opponent not found' });
    res.json(r);
});
router.get('/timeseries', (req, res) => res.json(timeseries(req.query, parseFilters(req.query))));

// --------------------------------------------------------------
// BUILD-ORDER TIMELINE
// --------------------------------------------------------------
// Returns the parsed build_log for a single game with each event enriched
// from the SC2 catalog (display name, race, category, tier). The frontend
// uses this to render the full per-game build-order timeline.
//
// Game lookup keys: a stable game_id ("date|opp|map|len") OR the path
// (build_name + index-within-build). We accept either form so the React
// SPA can pass whichever it has on hand.
function findGameById(gameId) {
    if (!gameId) return null;
    const meta = dbCache.meta.data || {};
    for (const buildName of Object.keys(meta)) {
        const bd = meta[buildName];
        if (!bd || typeof bd !== 'object') continue;
        for (const g of bd.games || []) {
            if (g && (g.id === gameId || g.game_id === gameId)) {
                return { game: g, build: buildName };
            }
        }
    }
    return null;
}

const _BUILD_LOG_LINE_RE = /^\[(\d+):(\d{2})\]\s+(.+?)\s*$/;

function parseBuildLogLines(lines) {
    const events = [];
    for (const line of lines || []) {
        const m = _BUILD_LOG_LINE_RE.exec(String(line || ''));
        if (!m) continue;
        const minutes = parseInt(m[1], 10);
        const seconds = parseInt(m[2], 10);
        const rawName = m[3].trim();
        let entry = null;
        if (SC2_CATALOG && typeof SC2_CATALOG.lookup === 'function') {
            entry = SC2_CATALOG.lookup(rawName);
        }
        events.push({
            time: minutes * 60 + seconds,
            time_display: `${minutes}:${String(seconds).padStart(2, '0')}`,
            name: rawName,
            display: entry ? entry.display : rawName,
            race: entry ? entry.race : 'Neutral',
            category: entry ? entry.category : 'unknown',
            tier: entry ? entry.tier : 0,
            is_building: entry ? !!entry.isBuilding : false,
            comp: entry ? (entry.comp || null) : null,
        });
    }
    events.sort((a, b) => a.time - b.time);
    return events;
}

router.get('/games/:gameId/build-order', (req, res) => {
    const found = findGameById(req.params.gameId);
    if (!found) return res.status(404).json({ ok: false, error: 'game not found' });
    const { game, build } = found;
    const events = parseBuildLogLines(game.build_log || []);
    const earlyEvents = parseBuildLogLines(game.early_build_log || []);
    // Opponent build log -- captured by buildorder_cli.py (manually or via
    // /games/:id/opp-build-order). When absent, opp_events comes back
    // empty and the frontend offers a button to extract on demand.
    const oppEvents = parseBuildLogLines(game.opp_build_log || []);
    const oppEarlyEvents = parseBuildLogLines(game.opp_early_build_log || []);
    // Derive the user's race from the build-name prefix ("Protoss - X",
    // "Terran - Y", "Zerg - Z", or matchup-prefixed "PvT - ..."). Used by
    // the frontend to label the timeline as YOUR build, since the
    // build_log only ever contains the user's milestones.
    const _myRace = (function () {
        if (game.my_race) return game.my_race;
        const b = String(build || '');
        if (/^Protoss\b/i.test(b) || /^P[vV]/.test(b)) return 'Protoss';
        if (/^Terran\b/i.test(b)  || /^T[vV]/.test(b)) return 'Terran';
        if (/^Zerg\b/i.test(b)    || /^Z[vV]/.test(b)) return 'Zerg';
        return '';
    })();
    res.json({
        ok: true,
        game_id: game.id || game.game_id,
        my_build: build,
        my_race: _myRace,
        opp_strategy: game.opp_strategy || null,
        opponent: game.opponent,
        opp_race: game.opp_race,
        map: game.map,
        result: game.result,
        date: game.date,
        game_length: game.game_length || 0,
        macro_score: typeof game.macro_score === 'number' ? game.macro_score : null,
        top_3_leaks: Array.isArray(game.top_3_leaks) ? game.top_3_leaks : [],
        // Full breakdown is what the macro click-to-expand panel renders.
        // Newly-parsed games have it stored; older games rely on top_3_leaks
        // alone and can be backfilled via /macro/backfill.
        macro_breakdown: (game.macro_breakdown && typeof game.macro_breakdown === 'object')
                            ? game.macro_breakdown : null,
        // YOUR full timeline + 5-minute slice (the build_log captured at
        // replay-watch time only contains the user's milestones).
        events,
        early_events: earlyEvents.length > 0 ? earlyEvents : events.filter(e => e.time <= 300),
        // OPPONENT's timeline + 5-minute slice. Empty arrays mean the
        // opp build log hasn't been extracted yet for this game; the
        // frontend can call POST /games/:id/opp-build-order to populate.
        opp_events: oppEvents,
        opp_early_events: oppEarlyEvents.length > 0
            ? oppEarlyEvents
            : oppEvents.filter(e => e.time <= 300),
        opp_build_available: oppEvents.length > 0,
        catalog_available: !!SC2_CATALOG,
    });
});

// --------------------------------------------------------------
// OPPONENT BUILD-ORDER EXTRACTION
// --------------------------------------------------------------
// Re-parse a single replay file via scripts/buildorder_cli.py to extract
// the OPPONENT's first-5-min build log (and full build log), then
// persist them to meta_database.json so subsequent reads are cheap.
// Mirrors the macro recompute pattern below.
function spawnBuildOrderCli(args) {
    return new Promise((resolve, reject) => {
        const scriptPath = path.join(ROOT, 'scripts', 'buildorder_cli.py');
        if (!fs.existsSync(scriptPath)) {
            return reject(new Error(
                `buildorder_cli.py not found at ${scriptPath}`
            ));
        }
        // Prefer the SC2_PYTHON env var if set (lets users pin a venv);
        // otherwise fall back to "python" / "python3" on the PATH.
        const pyCmd = process.env.SC2_PYTHON
            || (process.platform === 'win32' ? 'python' : 'python3');
        const proc = spawn(pyCmd, [scriptPath, ...args], {
            cwd: ROOT, windowsHide: true,
            env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }),
        });
        let stdout = '', stderr = '';
        proc.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
        proc.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
        proc.on('error', (err) => reject(err));
        proc.on('close', (code) => {
            const records = stdout.split('\n')
                .map(l => l.trim()).filter(Boolean)
                .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
                .filter(Boolean);
            if (code !== 0 && records.length === 0) {
                return reject(new Error(stderr.trim() || `buildorder_cli exit ${code}`));
            }
            resolve(records);
        });
    });
}

router.post('/games/:gameId/opp-build-order', (req, res) => {
    const found = findGameById(req.params.gameId);
    if (!found) return res.status(404).json({ ok: false, error: 'game not found' });
    const { game } = found;
    const fp = game.file_path;
    if (!fp) return res.status(400).json({ ok: false, error: 'no file_path on this game' });
    if (!fs.existsSync(fp)) {
        return res.status(404).json({
            ok: false, error: `replay file not found on disk: ${fp}`,
        });
    }
    const playerName = (req.body && req.body.player) || getDefaultPlayerName();
    const cliArgs = ['extract', '--replay', fp];
    if (playerName) { cliArgs.push('--player', playerName); }
    spawnBuildOrderCli(cliArgs)
        .then((records) => {
            const r = records.find(x => x && x.ok);
            if (!r) {
                const err = (records.find(x => x && x.error) || {}).error
                    || 'no result from buildorder_cli';
                return res.status(500).json({ ok: false, error: err });
            }
            // Persist back to meta DB so we don't re-parse the next read.
            game.opp_build_log       = Array.isArray(r.opp_build_log)
                ? r.opp_build_log : [];
            game.opp_early_build_log = Array.isArray(r.opp_early_build_log)
                ? r.opp_early_build_log : [];
            // Backfill the user's logs if they happen to be missing too.
            if ((!Array.isArray(game.build_log) || game.build_log.length === 0)
                    && Array.isArray(r.build_log)) {
                game.build_log = r.build_log;
            }
            if ((!Array.isArray(game.early_build_log) || game.early_build_log.length === 0)
                    && Array.isArray(r.early_build_log)) {
                game.early_build_log = r.early_build_log;
            }
            try { persistMetaDb(); } catch (_) { /* best-effort */ }

            const events      = parseBuildLogLines(game.opp_build_log || []);
            const earlyEvents = parseBuildLogLines(game.opp_early_build_log || []);
            res.json({
                ok: true,
                opp_events: events,
                opp_early_events: earlyEvents.length > 0
                    ? earlyEvents
                    : events.filter(e => e.time <= 300),
                opp_race: r.opp_race || game.opp_race || null,
                opp_name: r.opp_name || game.opponent || null,
                my_race:  r.my_race || null,
            });
        })
        .catch((err) => {
            res.status(500).json({
                ok: false,
                error: String((err && err.message) || err),
            });
        });
});

// On-demand macro recompute for a single game. Spawns the python
// macro_cli.py to re-parse the replay file and return the full breakdown.
// Mutates the in-memory + persisted DB so subsequent reads are cheap.
router.post('/games/:gameId/macro-breakdown', (req, res) => {
    const found = findGameById(req.params.gameId);
    if (!found) return res.status(404).json({ ok: false, error: 'game not found' });
    const { game, build } = found;
    const fp = game.file_path;
    if (!fp) return res.status(400).json({ ok: false, error: 'no file_path on this game' });
    if (!fs.existsSync(fp)) {
        return res.status(404).json({
            ok: false, error: `replay file not found on disk: ${fp}`,
        });
    }
    const playerName = (req.body && req.body.player) || getDefaultPlayerName();
    runMacroCli('compute', ['--replay', fp, '--player', playerName])
        .then((records) => {
            const r = records.find(x => x && x.ok && typeof x.macro_score === 'number');
            if (!r) {
                const err = (records.find(x => x && x.error) || {}).error || 'no result';
                return res.status(500).json({ ok: false, error: err });
            }
            const breakdown = {
                score: r.macro_score,
                race: r.race || null,
                game_length_sec: r.game_length_sec || 0,
                raw: r.raw || {},
                all_leaks: Array.isArray(r.all_leaks) ? r.all_leaks : [],
                top_3_leaks: Array.isArray(r.top_3_leaks) ? r.top_3_leaks : [],
            };
            // Mutate in-memory game record + persist back to meta_database.json.
            game.macro_score = r.macro_score;
            game.top_3_leaks = breakdown.top_3_leaks;
            game.macro_breakdown = breakdown;
            try { persistMetaDb(); } catch (e) { /* best-effort */ }
            res.json({ ok: true, build, macro_score: r.macro_score, ...breakdown });
        })
        .catch((err) => {
            res.status(500).json({ ok: false, error: String(err && err.message || err) });
        });
});

// Bulk macro backfill -- streams progress events over Socket.io and tracks
// state on the server so the UI can poll status. Mirrors the ML training
// pattern at runMlCli below.
const MACRO_STATE = {
    running: false,
    phase: 'idle',
    done: 0,
    total: 0,
    updated: 0,
    errors: 0,
    lastMessage: '',
    startedAt: null,
    finishedAt: null,
    proc: null,
};

router.post('/macro/backfill/start', (req, res) => {
    if (MACRO_STATE.running) {
        return res.status(409).json({ ok: false, error: 'backfill already running' });
    }
    const projDir = pythonProjectDirOrErr();
    if (projDir.error) return res.status(500).json({ ok: false, error: projDir.error });
    const py = pickPythonExe();
    const playerName = (req.body && req.body.player) || getDefaultPlayerName();
    const limit = Number((req.body && req.body.limit) || 0);
    const force = !!(req.body && req.body.force);
    const args = ['scripts/macro_cli.py', 'backfill', '--db', META_DB_PATH,
                  '--player', playerName];
    if (limit > 0) args.push('--limit', String(limit));
    if (force) args.push('--force');

    MACRO_STATE.running = true;
    MACRO_STATE.phase = 'running';
    MACRO_STATE.done = 0;
    MACRO_STATE.total = 0;
    MACRO_STATE.updated = 0;
    MACRO_STATE.errors = 0;
    MACRO_STATE.lastMessage = '';
    MACRO_STATE.startedAt = new Date().toISOString();
    MACRO_STATE.finishedAt = null;

    const proc = spawn(py, args, { cwd: projDir.dir, env: mlEnv(), windowsHide: true });
    MACRO_STATE.proc = proc;

    let buf = '';
    proc.stdout.on('data', (b) => {
        buf += b.toString('utf8');
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            try {
                const obj = JSON.parse(line);
                if (obj.progress) {
                    MACRO_STATE.done = obj.progress.i || MACRO_STATE.done;
                    MACRO_STATE.total = obj.progress.total || MACRO_STATE.total;
                    if (obj.progress.ok) MACRO_STATE.updated += 1;
                    else MACRO_STATE.errors += 1;
                    MACRO_STATE.lastMessage =
                        `${obj.progress.i}/${obj.progress.total} ${obj.progress.file || ''}`;
                    if (_ioRef && _ioRef.emit) {
                        try { _ioRef.emit('macro_backfill_progress', obj.progress); }
                        catch (_) { /* best-effort */ }
                    }
                } else if (obj.result) {
                    MACRO_STATE.phase = 'done';
                    MACRO_STATE.lastMessage = `done: updated ${obj.result.updated || 0}`;
                }
            } catch (_) { /* skip malformed line */ }
        }
    });
    proc.stderr.on('data', (b) => { MACRO_STATE.lastMessage = b.toString('utf8').slice(0, 200); });
    proc.on('close', (code) => {
        MACRO_STATE.running = false;
        MACRO_STATE.proc = null;
        MACRO_STATE.finishedAt = new Date().toISOString();
        if (MACRO_STATE.phase !== 'done') MACRO_STATE.phase = code === 0 ? 'done' : 'error';
        try {
            // Refresh the in-process meta DB so the new macro fields are
            // visible without restarting the server.
            reloadIfChanged('meta');
            dbCache.aggCache.clear();
        } catch (_) { /* best-effort */ }
        if (_ioRef && _ioRef.emit) {
            try { _ioRef.emit('macro_backfill_done', { code, ...MACRO_STATE }); }
            catch (_) { /* best-effort */ }
        }
    });

    res.json({ ok: true, started: true });
});

router.get('/macro/backfill/status', (_req, res) => {
    res.json({ ok: true, ...MACRO_STATE, proc: undefined });
});

// ----- Build/strategy DEFINITIONS (read-only catalog used by the SPA's
// Definitions tab). Source of truth lives in the Python project at
// detectors/definitions.py; we mirror it as data/build_definitions.json
// so the Node side can serve it without spawning Python.
router.get('/definitions', (_req, res) => {
    const candidates = [
        path.join(DATA_DIR, 'build_definitions.json'),
    ];
    const projDir = pickPythonProjectDir();
    if (projDir) candidates.push(path.join(projDir, 'data', 'build_definitions.json'));
    for (const p of candidates) {
        try {
            if (fs.existsSync(p)) {
                const text = fs.readFileSync(p, 'utf8');
                const data = JSON.parse(text);
                const items = Object.keys(data || {}).sort()
                    .map(k => ({ name: k, description: String(data[k] || '') }));
                return res.json({ ok: true, items, count: items.length, source: p });
            }
        } catch (e) { /* try the next path */ }
    }
    res.status(404).json({
        ok: false,
        error: 'build_definitions.json not found. Generate it from the python project.',
    });
});

// ----- SPATIAL / MAP-INTEL endpoints -----------------------------
// The Map Intel tab (heatmaps, death zones, opponent proxy locations)
// needs scipy + the per-replay spatial extractor, both of which live in
// the python project. We shell out to scripts/spatial_cli.py rather
// than re-implementing KDE in Node. Each endpoint just translates query
// params into CLI args, runs the CLI, and forwards its single JSON
// record. Results are cached briefly per query string so a click-spam
// doesn't spawn N processes.
const _SPATIAL_CACHE = new Map();   // key: cli-args string -> { exp, value }
const _SPATIAL_TTL_MS = 60_000;     // 1 minute is plenty - DB watcher busts on reload

// --------------------------------------------------------------
// MAP IMAGE FETCHER
// --------------------------------------------------------------
// Cache real SC2 map images on disk under data/map-images/. On a cache
// miss we hit Liquipedia's MediaWiki parse API to find the page, then
// pluck the first thumbnail src out of the rendered HTML and download it.
// Frontend draws this as the canvas background so the playback viewer
// matches the actual map terrain instead of an empty dark rectangle.
const _https = require('https');
const _http  = require('http');
const MAP_IMAGE_CACHE_DIR = path.join(DATA_DIR, 'map-images');
try { fs.mkdirSync(MAP_IMAGE_CACHE_DIR, { recursive: true }); } catch (_) {}

function _slugMapName(name) {
    return String(name || '')
        .trim()
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toLowerCase()
        .slice(0, 96);
}

function _httpsGetBuffer(url, headers, redirectsLeft) {
    // Liquipedia's API enforces gzip on api.* paths (HTTP 406 otherwise),
    // so we always advertise gzip/deflate/br and decompress on the way in.
    if (redirectsLeft === undefined) redirectsLeft = 5;
    const _zlib = require('zlib');
    return new Promise((resolve, reject) => {
        let parsed;
        try { parsed = new URL(url); } catch (e) { return reject(e); }
        const lib = parsed.protocol === 'http:' ? _http : _https;
        const req = lib.get({
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
            path: parsed.pathname + parsed.search,
            headers: Object.assign({
                'User-Agent': 'sc2tools-analyzer/1.0 (+https://github.com/ReSpOnSeSC2/sc2tools)',
                'Accept': '*/*',
                'Accept-Encoding': 'gzip, deflate, br',
            }, headers || {}),
            timeout: 8000,
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
                const next = new URL(res.headers.location, url).toString();
                res.resume();
                return resolve(_httpsGetBuffer(next, headers, redirectsLeft - 1));
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            }
            const enc = String(res.headers['content-encoding'] || '').toLowerCase();
            let stream = res;
            if (enc === 'gzip') stream = res.pipe(_zlib.createGunzip());
            else if (enc === 'deflate') stream = res.pipe(_zlib.createInflate());
            else if (enc === 'br') stream = res.pipe(_zlib.createBrotliDecompress());
            const chunks = [];
            stream.on('data', c => chunks.push(c));
            stream.on('end', () => resolve({
                body: Buffer.concat(chunks),
                contentType: res.headers['content-type'] || 'application/octet-stream',
            }));
            stream.on('error', reject);
        });
        req.on('timeout', () => { req.destroy(new Error('timeout')); });
        req.on('error', reject);
    });
}

const _MAP_IMAGE_INFLIGHT = new Map(); // slug -> Promise

async function _fetchMapImageFromLiquipedia(name) {
    // Liquipedia hosts SC2 map images on a shared MediaWiki commons CDN.
    // The directory layout is the standard MediaWiki MD5-of-filename
    // bucketing: for "Taito_Citadel.jpg",
    //   md5 = "97e9..." -> /commons/images/9/97/Taito_Citadel.jpg
    // We can compute the URL locally and skip the API entirely on the
    // fast path. If that 404s for every variant, we fall back to the
    // imageinfo API and finally to scraping the rendered map page.
    const baseName = name.replace(/\s+LE$/i, '').trim();
    const titleVariants = Array.from(new Set([
        baseName.replace(/ /g, '_'),
        baseName,
        name.replace(/ /g, '_'),
        name,
    ].filter(Boolean)));
    const exts = ['jpg', 'png', 'jpeg', 'webp'];

    const tryDownload = async (url) => {
        try {
            const dl = await _httpsGetBuffer(url);
            // Liquipedia returns small "no file" placeholders sometimes;
            // require at least 1 KB for a real map image.
            if (dl && dl.body && dl.body.length > 1024) {
                return { body: dl.body, contentType: dl.contentType, sourceUrl: url };
            }
        } catch (_) { /* fall through */ }
        return null;
    };

    // Fast path: direct CDN URL via MD5 bucketing.
    for (const title of titleVariants) {
        for (const ext of exts) {
            const filename = `${title}.${ext}`;
            const md5 = require('crypto').createHash('md5').update(filename).digest('hex');
            const url = `https://liquipedia.net/commons/images/${md5[0]}/${md5.slice(0, 2)}/${filename}`;
            const got = await tryDownload(url);
            if (got) return got;
        }
    }

    // Slow path #1: imageinfo API resolves File:Name.ext -> direct URL.
    for (const title of titleVariants) {
        for (const ext of exts) {
            const fileTitle = `File:${title}.${ext}`;
            try {
                const apiUrl = `https://liquipedia.net/starcraft2/api.php?action=query&titles=${encodeURIComponent(fileTitle)}&prop=imageinfo&iiprop=url&format=json&redirects=1`;
                const { body } = await _httpsGetBuffer(apiUrl, { 'Accept': 'application/json' });
                const j = JSON.parse(body.toString('utf8'));
                const pages = (j && j.query && j.query.pages) || {};
                let imgUrl = null;
                for (const k of Object.keys(pages)) {
                    if (Number(k) < 0) continue;
                    const ii = pages[k] && pages[k].imageinfo && pages[k].imageinfo[0];
                    if (ii && ii.url) { imgUrl = ii.url; break; }
                }
                if (!imgUrl) continue;
                const got = await tryDownload(imgUrl);
                if (got) { got.sourcePage = fileTitle; return got; }
            } catch (_) {}
        }
    }

    // Slow path #2: scrape the map's regular page for the first thumbnail.
    for (const title of titleVariants) {
        try {
            const apiUrl = `https://liquipedia.net/starcraft2/api.php?action=parse&page=${encodeURIComponent(title)}&format=json&prop=text&redirects=1`;
            const { body } = await _httpsGetBuffer(apiUrl, { 'Accept': 'application/json' });
            const j = JSON.parse(body.toString('utf8'));
            const html = (j && j.parse && j.parse.text && j.parse.text['*']) || '';
            if (!html) continue;
            const mm = html.match(/<img[^>]+src="([^"]+\.(?:jpg|jpeg|png|webp))"/i);
            if (!mm) continue;
            let imgUrl = mm[1];
            if (imgUrl.startsWith('//')) imgUrl = 'https:' + imgUrl;
            else if (imgUrl.startsWith('/')) imgUrl = 'https://liquipedia.net' + imgUrl;
            const got = await tryDownload(imgUrl);
            if (got) { got.sourcePage = title; return got; }
        } catch (_) {}
    }
    return null;
}

async function getMapImage(name) {
    if (!name || typeof name !== 'string') return null;
    const slug = _slugMapName(name);
    if (!slug) return null;

    // 1. On-disk cache (any of the common image extensions)
    for (const ext of ['jpg', 'png', 'webp', 'jpeg']) {
        const candidate = path.join(MAP_IMAGE_CACHE_DIR, `${slug}.${ext}`);
        if (fs.existsSync(candidate)) {
            return {
                path: candidate,
                contentType: ext === 'png' ? 'image/png'
                            : ext === 'webp' ? 'image/webp'
                            : 'image/jpeg',
            };
        }
    }

    // 2. Coalesce concurrent requests for the same slug.
    if (_MAP_IMAGE_INFLIGHT.has(slug)) return _MAP_IMAGE_INFLIGHT.get(slug);
    const promise = (async () => {
        const fetched = await _fetchMapImageFromLiquipedia(name);
        if (!fetched) return null;
        const ext = (fetched.contentType.includes('png')) ? 'png'
                   : (fetched.contentType.includes('webp')) ? 'webp'
                   : 'jpg';
        const out = path.join(MAP_IMAGE_CACHE_DIR, `${slug}.${ext}`);
        try { fs.writeFileSync(out, fetched.body); } catch (_) { return null; }
        return { path: out, contentType: fetched.contentType };
    })();
    _MAP_IMAGE_INFLIGHT.set(slug, promise);
    promise.finally(() => _MAP_IMAGE_INFLIGHT.delete(slug));
    return promise;
}


function runSpatialCli(subcmd, cliArgs = []) {
    const cacheKey = subcmd + '|' + cliArgs.join('|');
    const hit = _SPATIAL_CACHE.get(cacheKey);
    if (hit && hit.exp > Date.now()) return Promise.resolve(hit.value);

    return new Promise((resolve, reject) => {
        const projDir = pythonProjectDirOrErr();
        if (projDir.error) return reject(new Error(projDir.error));
        const py = pickPythonExe();
        // We override this slightly for playback, as it uses playback_cli instead of spatial_cli
        const isPlayback = subcmd === 'playback';

        let pyArgs;
        if (isPlayback) {
            pyArgs = ['scripts/playback_cli.py', 'extract',
                      '--player', getDefaultPlayerName(),
                      ...cliArgs];
        } else {
            pyArgs = ['scripts/spatial_cli.py', subcmd,
                      '--db', META_DB_PATH,
                      '--player', getDefaultPlayerName(),
                      ...cliArgs];
        }
        const proc = spawn(py, pyArgs, {
            cwd: projDir.dir, env: mlEnv(), windowsHide: true,
        });
        let stdout = '', stderr = '';
        proc.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
        proc.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
        proc.on('error', (err) => reject(err));
        proc.on('close', (code) => {
            const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
            const last = lines.length > 0 ? lines[lines.length - 1] : '';
            let parsed = null;
            try { parsed = last ? JSON.parse(last) : null; } catch (_) { /* below */ }
            if (parsed == null) {
                return reject(new Error(stderr.trim() || `spatial_cli exit ${code}`));
            }
            // Cache only successful results so a transient error doesn't pin a 404.
            if (parsed && parsed.ok !== false) {
                _SPATIAL_CACHE.set(cacheKey, { exp: Date.now() + _SPATIAL_TTL_MS, value: parsed });
            }
            resolve(parsed);
        });
    });
}

// Bust the spatial cache whenever the meta DB reloads (handled by the
// existing watcher's analyzer_db_changed event). We hook it via a
// trivial periodic re-check tied to dbCache.meta.revision.
let _spatialCacheRev = -1;
setInterval(() => {
    if (dbCache.meta && dbCache.meta.revision !== _spatialCacheRev) {
        _spatialCacheRev = dbCache.meta.revision;
        _SPATIAL_CACHE.clear();
    }
}, 4000).unref?.();

router.get('/spatial/maps', (req, res) => {
    const minGames = String(req.query.min_games || '3');
    runSpatialCli('maps', ['--min-games', minGames])
        .then(j => res.json(j))
        .catch(err => res.status(500).json({ ok: false, error: String(err.message || err) }));
});

router.get('/spatial/buildings', (req, res) => {
    const map = String(req.query.map || '');
    if (!map) return res.status(400).json({ ok: false, error: 'map is required' });
    const owner = (req.query.owner === 'opponent') ? 'opponent' : 'me';
    runSpatialCli('buildings', ['--map', map, '--owner', owner])
        .then(j => res.json(j))
        .catch(err => res.status(500).json({ ok: false, error: String(err.message || err) }));
});

router.get('/spatial/proxy', (req, res) => {
    const map = String(req.query.map || '');
    if (!map) return res.status(400).json({ ok: false, error: 'map is required' });
    runSpatialCli('proxy', ['--map', map])
        .then(j => res.json(j))
        .catch(err => res.status(500).json({ ok: false, error: String(err.message || err) }));
});

router.get('/spatial/battle', (req, res) => {
    const map = String(req.query.map || '');
    if (!map) return res.status(400).json({ ok: false, error: 'map is required' });
    runSpatialCli('battle', ['--map', map])
        .then(j => res.json(j))
        .catch(err => res.status(500).json({ ok: false, error: String(err.message || err) }));
});

router.get('/spatial/death-zone', (req, res) => {
    const map = String(req.query.map || '');
    if (!map) return res.status(400).json({ ok: false, error: 'map is required' });
    const myRace = String(req.query.my_race || '');
    runSpatialCli('death-zone', ['--map', map, '--my-race', myRace])
        .then(j => res.json(j))
        .catch(err => res.status(500).json({ ok: false, error: String(err.message || err) }));
});

router.get('/spatial/opponent-proxies', (req, res) => {
    const opponent = String(req.query.opponent || '');
    if (!opponent) return res.status(400).json({ ok: false, error: 'opponent is required' });
    const maxGames = String(req.query.max_games || '200');
    runSpatialCli('opponent-proxies', ['--opponent', opponent, '--max-games', maxGames])
        .then(j => res.json(j))
        .catch(err => res.status(500).json({ ok: false, error: String(err.message || err) }));
});

// Returns the catalog itself so the frontend can render race/category
// chips and other static UI without bundling the data twice.
router.get('/catalog', (_req, res) => {
    if (!SC2_CATALOG) {
        return res.status(503).json({ ok: false, error: 'catalog not loaded' });
    }
    res.json({ ok: true, catalog: SC2_CATALOG.CATALOG });
});

// CSV export -- generic "any aggregation" pipe.
router.get('/export.csv', (req, res) => {
    const kind = String(req.query.kind || 'builds').toLowerCase();
    const handlers = {
        builds:           () => builds(parseFilters(req.query)),
        'opp-strategies': () => oppStrategies(parseFilters(req.query)),
        'build-vs-strategy': () => buildVsStrategy(parseFilters(req.query)),
        maps:             () => maps(parseFilters(req.query)),
        matchups:         () => matchups(parseFilters(req.query)),
        opponents:        () => opponents(req.query),
        'build-detail':   () => {
            const d = buildDetail(req.query.build, parseFilters(req.query));
            return d ? d.games : [];
        },
    };
    const h = handlers[kind];
    if (!h) return res.status(400).json({ ok: false, error: 'unknown export kind' });
    const rows = h() || [];
    if (rows.length === 0) {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${kind}.csv"`);
        return res.send('');
    }
    const cols = Object.keys(rows[0]);
    const esc = v => {
        if (v === null || v === undefined) return '';
        const s = String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [cols.join(',')]
        .concat(rows.map(r => cols.map(c => esc(r[c])).join(',')))
        .join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${kind}.csv"`);
    res.send(csv);
});

// Manual reload (debugging).
router.post('/reload', (_req, res) => {
    const m = reloadIfChanged('meta');
    const o = reloadIfChanged('opp');
    dbCache.aggCache.clear();
    res.json({ ok: true, meta: m, opp: o, revisions: {
        meta: dbCache.meta.revision, opp: dbCache.opp.revision
    } });
});

// Force-bust the aggregation cache without rereading files.
router.post('/bust-cache', (_req, res) => {
    const n = dbCache.aggCache.size;
    dbCache.aggCache.clear();
    res.json({ ok: true, busted: n });
});

// Diagnose a single opponent record.
router.get('/opponents/:pulseId/raw', (req, res) => {
    const pulseId = req.params.pulseId;
    const rec = dbCache.opp.data[pulseId];
    if (!rec) return res.status(404).json({ ok: false, error: 'opponent not found', pulseId });
    const games = flattenOpponentGames(rec);
    const stored = totalsFromRecord(rec);
    let countedW = 0, countedL = 0, countedOther = 0;
    const resultBreakdown = {};
    for (const g of games) {
        const r = (g.result || g.Result || '__missing__');
        resultBreakdown[r] = (resultBreakdown[r] || 0) + 1;
        if (isWin(g))  countedW++;
        else if (isLoss(g)) countedL++;
        else countedOther++;
    }
    res.json({
        ok: true,
        pulseId,
        name: rec.Name || '',
        rawRecord: rec,
        derived: {
            storedTotals: stored,
            counted: { wins: countedW, losses: countedL, unrecognised: countedOther },
            gameResultFieldDistribution: resultBreakdown,
            flattenedGameCount: games.length,
            firstGameSample: games[0] || null,
        },
    });
});

// --------------------------------------------------------------
// FILE WATCHERS -- broadcast a Socket.io event when either DB
// changes so connected SPAs can refresh in real time.
// --------------------------------------------------------------
let _ioRef = null;  // captured by startWatching so the ML routes can broadcast
                    // training progress without piping io through every closure.

function startWatching(io) {
    _ioRef = io;
    dbCache.aggCache.clear();
    let last = { meta: dbCache.meta.signature, opp: dbCache.opp.signature };
    setInterval(() => {
        const changedMeta = reloadIfChanged('meta');
        const changedOpp  = reloadIfChanged('opp');
        if (changedMeta || changedOpp) {
            try {
                io.emit('analyzer_db_changed', {
                    metaRevision: dbCache.meta.revision,
                    oppRevision:  dbCache.opp.revision,
                });
            } catch (_) {}
            last = { meta: dbCache.meta.signature, opp: dbCache.opp.signature };
        }
    }, 4000);
}

// --------------------------------------------------------------
// ML LAYER -- spawns the Python ML CLI in the SC2Replay-Analyzer
// project and streams training progress over Socket.io.
// --------------------------------------------------------------
//
// The ML model lives in Python (analytics/win_probability.py). Rather
// than re-implement logistic regression in Node, we spawn a thin CLI
// (scripts/ml_cli.py in the SC2Replay-Analyzer project) for each ML
// request. Training streams ndjson progress lines that we forward as
// Socket.io 'ml_train_progress' events.
//
// To find the Python project + interpreter we honour env vars first,
// then fall back to the common SC2TOOLS layout where both projects are
// siblings.

function pickPythonProjectDir() {
    if (process.env.SC2REPLAY_ANALYZER_DIR
        && fs.existsSync(process.env.SC2REPLAY_ANALYZER_DIR)) {
        return process.env.SC2REPLAY_ANALYZER_DIR;
    }
    const sibling = path.resolve(ROOT, '..', 'SC2Replay-Analyzer');
    if (fs.existsSync(sibling)) return sibling;
    const winDefault = 'C:\\SC2TOOLS\\SC2Replay-Analyzer';
    if (fs.existsSync(winDefault)) return winDefault;
    return null;
}

function pickPythonExe() {
    if (process.env.PYTHON) return process.env.PYTHON;
    // On Windows the launcher 'py' is more reliable than 'python';
    // on Linux/macOS 'python3' wins. We just prefer 'python' since the
    // SC2Replay-Analyzer venv is typically activated by a wrapper.
    return process.platform === 'win32' ? 'py' : 'python3';
}

const ML_STATE = {
    running: false,
    phase: 'idle',
    done: 0,
    total: 0,
    lastMessage: '',
    startedAt: null,
    finishedAt: null,
    lastResult: null,
    proc: null,
};

function mlEnv() {
    return {
        ...process.env,
        // Force unbuffered stdout so progress lines arrive promptly.
        PYTHONUNBUFFERED: '1',
    };
}

function pythonProjectDirOrErr() {
    const dir = pickPythonProjectDir();
    if (!dir) {
        return {
            error: (
                'Could not locate the SC2Replay-Analyzer Python project. '
                + 'Set the SC2REPLAY_ANALYZER_DIR env var, or place the '
                + 'project as a sibling of the overlay backend.'
            ),
        };
    }
    return { dir };
}

/**
 * Spawn the Python ML CLI with the given subcommand+args, collect
 * stdout, parse line-delimited JSON, and resolve with the parsed
 * objects. Used for short-running commands (status / predict / pregame
 * / options). Training uses a streaming variant below.
 */
function runMlCli(subcmd, args = [], { db = META_DB_PATH } = {}) {
    return new Promise((resolve, reject) => {
        const projDir = pythonProjectDirOrErr();
        if (projDir.error) return reject(new Error(projDir.error));
        const py = pickPythonExe();
        const pyArgs = [
            'scripts/ml_cli.py', subcmd, '--db', db, ...args,
        ];
        // On Windows the 'py' launcher takes the script path directly,
        // so we don't need 'python -m'. Using the script path keeps it
        // identical across platforms.
        const proc = spawn(py, pyArgs, {
            cwd: projDir.dir, env: mlEnv(), windowsHide: true,
        });

        let stdout = '', stderr = '';
        proc.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
        proc.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
        proc.on('error', (err) => reject(err));
        proc.on('close', (code) => {
            const records = stdout.split('\n')
                .map(l => l.trim()).filter(Boolean)
                .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
                .filter(Boolean);
            if (code !== 0 && records.length === 0) {
                return reject(new Error(
                    `ml_cli ${subcmd} exited ${code}: ${stderr.trim() || '(no output)'}`
                ));
            }
            resolve({ code, records, stderr });
        });
    });
}

/**
 * Streaming variant for training. Spawns ml_cli.py train, forwards each
 * progress line over Socket.io as 'ml_train_progress', and updates
 * ML_STATE so the /api/analyzer/ml/status endpoint shows live numbers.
 */
function runTrainingStream({ db = META_DB_PATH, player = null }) {
    const projDir = pythonProjectDirOrErr();
    if (projDir.error) {
        ML_STATE.running = false;
        ML_STATE.phase = 'idle';
        ML_STATE.lastMessage = projDir.error;
        return null;
    }
    const py = pickPythonExe();
    const args = ['scripts/ml_cli.py', 'train', '--db', db];
    if (player) args.push('--player', player);

    const proc = spawn(py, args, {
        cwd: projDir.dir, env: mlEnv(), windowsHide: true,
    });

    ML_STATE.running = true;
    ML_STATE.phase = 'train';
    ML_STATE.done = 0;
    ML_STATE.total = 0;
    ML_STATE.lastMessage = 'Starting...';
    ML_STATE.startedAt = new Date().toISOString();
    ML_STATE.finishedAt = null;
    ML_STATE.lastResult = null;
    ML_STATE.proc = proc;

    let buf = '';
    function consumeLine(line) {
        if (!line) return;
        let obj;
        try { obj = JSON.parse(line); } catch (_) { return; }
        if (obj.progress) {
            ML_STATE.done = obj.progress.done | 0;
            ML_STATE.total = obj.progress.total | 0;
            const pct = ML_STATE.total
                ? Math.round(100 * ML_STATE.done / ML_STATE.total) : 0;
            ML_STATE.lastMessage =
                `Parsing replay ${ML_STATE.done}/${ML_STATE.total} (${pct}%)`;
            if (_ioRef) {
                try {
                    _ioRef.emit('ml_train_progress', {
                        done: ML_STATE.done, total: ML_STATE.total,
                        pct, phase: 'train',
                    });
                } catch (_) {}
            }
        } else if (obj.result) {
            ML_STATE.lastResult = obj.result;
            ML_STATE.lastMessage = obj.result.message || 'Training complete.';
        }
    }

    proc.stdout.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) !== -1) {
            consumeLine(buf.slice(0, i).trim());
            buf = buf.slice(i + 1);
        }
    });
    proc.stderr.on('data', (chunk) => {
        ML_STATE.lastMessage =
            (ML_STATE.lastMessage + ' | ' + chunk.toString('utf8')).slice(-300);
    });
    proc.on('close', (code) => {
        if (buf.trim()) consumeLine(buf.trim());
        ML_STATE.running = false;
        ML_STATE.phase = 'idle';
        ML_STATE.finishedAt = new Date().toISOString();
        ML_STATE.proc = null;
        if (code !== 0 && !ML_STATE.lastResult) {
            ML_STATE.lastMessage =
                `Training process exited with code ${code}.`;
        }
        if (_ioRef) {
            try {
                _ioRef.emit('ml_train_complete', {
                    code, result: ML_STATE.lastResult,
                    message: ML_STATE.lastMessage,
                });
                // Trigger a refresh of analyzer aggregations too -- the
                // model file changed, and any UI showing cached AUC etc.
                // should re-pull /ml/status.
                _ioRef.emit('analyzer_db_changed', {
                    metaRevision: dbCache.meta.revision,
                    oppRevision:  dbCache.opp.revision,
                    mlChanged: true,
                });
            } catch (_) {}
        }
    });
    return proc;
}

// ---------------------------- ML routes ----------------------------

router.get('/ml/status', async (_req, res) => {
    try {
        const { records } = await runMlCli('status');
        const stat = records[0] || { trained: false, message: 'no output' };
        // Merge in live training state so the UI shows in-flight progress.
        const live = {
            running: ML_STATE.running,
            phase: ML_STATE.phase,
            done: ML_STATE.done,
            total: ML_STATE.total,
            startedAt: ML_STATE.startedAt,
            finishedAt: ML_STATE.finishedAt,
            lastMessage: ML_STATE.lastMessage,
        };
        res.json({ ok: true, ...stat, live });
    } catch (err) {
        res.status(500).json({ ok: false, message: err.message });
    }
});

router.post('/ml/train', (req, res) => {
    if (ML_STATE.running) {
        return res.status(409).json({
            ok: false, message: 'Training already in progress.',
            live: ML_STATE,
        });
    }
    const player = (req.query.player || req.body && req.body.player) || null;
    const proc = runTrainingStream({ player });
    if (!proc) {
        return res.status(500).json({
            ok: false, message: ML_STATE.lastMessage || 'Could not start training.',
        });
    }
    res.status(202).json({
        ok: true,
        message: 'Training started.',
        // Echo where progress will land:
        events: ['ml_train_progress', 'ml_train_complete'],
    });
});

router.get('/ml/predict', async (req, res) => {
    const numeric = [
        'minute', 'supply_diff', 'army_value_diff',
        'income_min_diff', 'income_gas_diff',
        'nexus_count_diff', 'tech_score_self', 'tech_score_opp',
    ];
    const args = [];
    for (const k of numeric) {
        if (req.query[k] !== undefined && req.query[k] !== '') {
            args.push('--' + k, String(req.query[k]));
        }
    }
    if (req.query.matchup) args.push('--matchup', String(req.query.matchup));
    try {
        const { records } = await runMlCli('predict', args);
        res.json(records[0] || { ok: false, message: 'no output' });
    } catch (err) {
        res.status(500).json({ ok: false, message: err.message });
    }
});

router.get('/ml/pregame', async (req, res) => {
    const args = [];
    for (const k of ['myrace', 'opprace', 'opponent', 'map', 'strategy']) {
        if (req.query[k]) args.push('--' + k, String(req.query[k]));
    }
    try {
        const { records } = await runMlCli('pregame', args);
        res.json(records[0] || { ok: false, message: 'no output' });
    } catch (err) {
        res.status(500).json({ ok: false, message: err.message });
    }
});

router.get('/ml/options', async (_req, res) => {
    try {
        const { records } = await runMlCli('options');
        res.json(records[0] || { races: [], opponents: [], maps: [], strategies: [] });
    } catch (err) {
        res.status(500).json({ ok: false, message: err.message });
    }
});

// ---------------------------- Spatial heatmap routes ----------------------------
//
// All five spatial endpoints proxy through the Python ml_cli `spatial`
// subcommand which wraps `analytics.spatial.SpatialAggregator`. We keep
// these on the same router so the React SPA can call /api/analyzer/spatial/*
// alongside the rest of the analyzer surface.
//
// The Python side caches per-replay spatial extracts on disk under
// data/spatial_cache.json so the first call on a given map is slow (full
// replay parse for every game on that map) but subsequent calls are cheap.
// We DON'T add a Node-side cache on top because the React UI debounces
// toggle clicks and the Python disk cache already covers the heavy case.

function _spatialArgs(req, mode) {
    const args = ['--mode', mode];
    if (req.query.map)       args.push('--map',       String(req.query.map));
    if (req.query.owner)     args.push('--owner',     String(req.query.owner));
    if (req.query.myrace)    args.push('--myrace',    String(req.query.myrace));
    if (req.query.min_games) args.push('--min_games', String(req.query.min_games));
    if (req.query.opponent)  args.push('--opponent',  String(req.query.opponent));
    if (req.query.player)    args.push('--player',    String(req.query.player));
    return args;
}

router.get('/spatial/maps', async (req, res) => {
    try {
        const { records } = await runMlCli('spatial', _spatialArgs(req, 'maps'));
        res.json(records[0] || { ok: false, maps: [] });
    } catch (err) {
        res.status(500).json({ ok: false, message: err.message });
    }
});

router.get('/spatial/buildings', async (req, res) => {
    if (!req.query.map) {
        return res.status(400).json({ ok: false, message: 'map query param required' });
    }
    try {
        const { records } = await runMlCli('spatial', _spatialArgs(req, 'buildings'));
        res.json(records[0] || { ok: false });
    } catch (err) {
        res.status(500).json({ ok: false, message: err.message });
    }
});

router.get('/spatial/proxy', async (req, res) => {
    if (!req.query.map) {
        return res.status(400).json({ ok: false, message: 'map query param required' });
    }
    try {
        const { records } = await runMlCli('spatial', _spatialArgs(req, 'proxy'));
        res.json(records[0] || { ok: false });
    } catch (err) {
        res.status(500).json({ ok: false, message: err.message });
    }
});

router.get('/spatial/battle', async (req, res) => {
    if (!req.query.map) {
        return res.status(400).json({ ok: false, message: 'map query param required' });
    }
    try {
        const { records } = await runMlCli('spatial', _spatialArgs(req, 'battle'));
        res.json(records[0] || { ok: false });
    } catch (err) {
        res.status(500).json({ ok: false, message: err.message });
    }
});

router.get('/spatial/death-zone', async (req, res) => {
    if (!req.query.map) {
        return res.status(400).json({ ok: false, message: 'map query param required' });
    }
    try {
        const { records } = await runMlCli('spatial', _spatialArgs(req, 'death_zone'));
        res.json(records[0] || { ok: false });
    } catch (err) {
        res.status(500).json({ ok: false, message: err.message });
    }
});

router.get('/spatial/opponent-proxies', async (req, res) => {
    if (!req.query.opponent) {
        return res.status(400).json({ ok: false, message: 'opponent query param required' });
    }
    try {
        const { records } = await runMlCli(
            'spatial', _spatialArgs(req, 'opponent_proxies'),
        );
        res.json(records[0] || { ok: false });
    } catch (err) {
        res.status(500).json({ ok: false, message: err.message });
    }
});

router.get('/map-image', async (req, res) => {
    // GET /api/analyzer/map-image?name=Taito%20Citadel%20LE
    // Streams a real SC2 map image (cached on disk under data/map-images/),
    // fetched on first miss from Liquipedia. 404 if no image is available
    // for the requested name; the frontend should fall back to its dark
    // background in that case.
    const name = String(req.query.name || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'missing ?name=' });
    try {
        const found = await getMapImage(name);
        if (!found) return res.status(404).json({ ok: false, error: 'no image found' });
        // Cache aggressively in the browser; the underlying file is content-
        // addressed by slug so a name change implies a new URL.
        res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
        res.setHeader('Content-Type', found.contentType);
        return fs.createReadStream(found.path).pipe(res);
    } catch (err) {
        return res.status(500).json({ ok: false, error: String(err && err.message || err) });
    }
});

router.get('/playback', async (req, res) => {
    // playback_cli.py emits a single NDJSON line of the shape
    //   { ok: true, result: { map_name, game_length, bounds, me_name, opp_name,
    //                         result, my_events, opp_events, my_stats, opp_stats,
    //                         analysis } }
    // ...or { ok: false, error: "..." } on failure.
    //
    // runSpatialCli already JSON.parses that single line and returns the
    // resulting object directly. Earlier code here destructured `records`
    // (which doesn't exist on that shape) and re-wrapped, producing
    // `{ ok: true, result: undefined }` -- the frontend then crashed on
    // `data.map_name`. Pass the parsed object through unchanged so the
    // shape the frontend is built for is what arrives on the wire.
    try {
        if (!req.query.replay) {
            return res.status(400).json({ ok: false, error: 'missing ?replay= file path' });
        }
        const j = await runSpatialCli('playback', ['--replay', req.query.replay]);
        // If the CLI itself reported failure, surface its error verbatim.
        if (!j || j.ok === false) {
            return res.status(500).json({ ok: false, error: (j && j.error) || 'playback CLI failed' });
        }
        res.json(j);
    } catch (err) {
        res.status(500).json({ ok: false, error: String(err && err.message || err) });
    }
});


module.exports = { router, startWatching };
