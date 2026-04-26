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
            const k = `${build} ${game.opp_strategy || 'Unknown'}`;
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
function flattenOpponentGames(rec) {
    const games = [];
    if (Array.isArray(rec.Games)) {
        for (const g of rec.Games) games.push({ ...g });
    }
    if (rec.Matchups) {
        for (const mu of Object.keys(rec.Matchups)) {
            const list = (rec.Matchups[mu] || {}).Games || [];
            for (const g of list) games.push({ ...g, Matchup: mu });
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

function opponents(query) {
    return cachedAgg('opponents:' + JSON.stringify(query || {}), null, () => {
        const search = (query.search || '').toLowerCase();
        const minGames = Number(query.min_games) || 0;
        const limit = Math.min(Number(query.limit) || 200, 1000);
        const sortBy = query.sort || 'lastPlayed';
        const out = [];
        const db = dbCache.opp.data;
        for (const pulseId of Object.keys(db)) {
            const r = db[pulseId] || {};
            const name = r.Name || '';
            if (search && !name.toLowerCase().includes(search) && !pulseId.includes(search)) continue;
            const games = flattenOpponentGames(r);
            // Source of truth for W/L is the stored totals on the record
            // (top-level + per-matchup) -- the PS scanner writes those
            // every game. Fall back to counting Result fields only if
            // the record has no totals (very old records).
            const stored = totalsFromRecord(r);
            let wins = stored.wins, losses = stored.losses;
            if (wins === 0 && losses === 0 && games.length > 0) {
                for (const g of games) {
                    if (isWin(g))  wins++;
                    else if (isLoss(g)) losses++;
                }
            }
            // "games played" is the larger of (counted records) and
            // (W+L), so we never under-report when the games array is
            // truncated but totals are intact.
            const total = Math.max(games.length, wins + losses);
            if (total < minGames) continue;
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
// DNA helpers (median build-log timings + recency-weighted predict)
// --------------------------------------------------------------

// Build_log line regex: "[m:ss] BuildingName".
const _TIMING_RE = /^\[(\d+):(\d{2})\]\s+(\w+)/;

// Tokens we report median timings for. Substring match against the
// building name token, so "Pool" matches "SpawningPool", "Robo" matches
// "RoboticsFacility", "Twilight" matches "TwilightCouncil", etc.
const KEY_TIMING_BUILDINGS = [
    'Pool','Gateway','Barracks','Hatchery','Nexus','CommandCenter',
    'Robo','Stargate','Spire','Twilight','Forge'
];

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

// Pull median first-occurrence timings out of `games[i].build_log`.
// `build_log` can be either snake_case (meta_database) or capitalised
// (MyOpponentHistory). Falls back gracefully if the field is absent.
function parseBuildLogTimings(games) {
    const perToken = Object.fromEntries(KEY_TIMING_BUILDINGS.map(t => [t, []]));
    for (const g of games || []) {
        const log = g.build_log || g.BuildLog || g.Build_Log || g.buildLog;
        if (!Array.isArray(log) || log.length === 0) continue;
        const seenInGame = {};
        for (const line of log) {
            const m = _TIMING_RE.exec(String(line || ''));
            if (!m) continue;
            const sec = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
            const lower = m[3].toLowerCase();
            for (const tok of KEY_TIMING_BUILDINGS) {
                if (lower.includes(tok.toLowerCase())) {
                    if (seenInGame[tok] === undefined || sec < seenInGame[tok]) {
                        seenInGame[tok] = sec;
                    }
                }
            }
        }
        for (const [tok, sec] of Object.entries(seenInGame)) perToken[tok].push(sec);
    }
    const out = {};
    for (const tok of KEY_TIMING_BUILDINGS) {
        const samples = perToken[tok];
        const med = _median(samples);
        out[tok] = (med == null)
            ? { medianSeconds: null, medianDisplay: '-', sampleCount: 0 }
            : { medianSeconds: med, medianDisplay: _formatSeconds(med), sampleCount: samples.length };
    }
    return out;
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
    return {
        name: buildName,
        totals: { wins, losses, total, winRate: total ? wins / total : 0, lastPlayed: lastPlayed || null },
        byOppStrategy,
        byMap,
        byOpponent,
        games,  // newest-first
    };
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
        const m = g.Map || 'Unknown';
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

    const medianTimings = parseBuildLogTimings(games);
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
function startWatching(io) {
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

module.exports = { router, startWatching };

module.exports.__internals__ = { buildDetail, opponentDetail, parseBuildLogTimings, recencyWeightedStrategies, ensureLoaded, dbCache };
