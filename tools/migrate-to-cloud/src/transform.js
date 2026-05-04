"use strict";

const crypto = require("node:crypto");

const RACE_FROM_TOKEN = Object.freeze({
  PROTOSS: "Protoss",
  TERRAN: "Terran",
  ZERG: "Zerg",
  RANDOM: "Random",
});

/**
 * Transform raw local files into cloud-shaped payloads.
 *
 *   MyOpponentHistory.json[pulseId].Matchups[matchup].Games[i]
 *   → one entry in `games` (basic fields)
 *
 *   meta_database.json[buildName].games[i]
 *   → enrichment of the matching game entry (myBuild, buildLog, ...)
 *     OR a standalone game record if no MyOpponentHistory match exists
 *
 *   custom_builds.json.builds[i]
 *   → entries in `customBuilds`
 *
 *   profile.json
 *   → single profile object
 *
 * @param {ReturnType<typeof import('./read').readAll> extends Promise<infer R> ? R : never} raw
 */
function transform(raw) {
  const games = [];
  const seenGameIds = new Set();
  const enrichmentIndex = new Map();

  for (const [pulseId, oppRec] of Object.entries(raw.opponents || {})) {
    const matchups = (oppRec && oppRec.Matchups) || {};
    for (const [matchupKey, mu] of Object.entries(matchups)) {
      const { myRace, oppRace } = parseMatchup(matchupKey, oppRec.Race);
      const list = (mu && mu.Games) || [];
      if (!Array.isArray(list)) continue;
      for (const g of list) {
        const date = parseLocalDate(g.Date);
        if (!date) continue;
        const result = normalizeResult(g.Result);
        if (!result) continue;
        const map = (g.Map && String(g.Map)) || "Unknown Map";
        const gameId = makeGameId(pulseId, date, map);
        if (seenGameIds.has(gameId)) continue;
        seenGameIds.add(gameId);

        const game = {
          gameId,
          date: date.toISOString(),
          result,
          myRace,
          map,
          opponent: {
            pulseId: String(pulseId),
            displayName: oppRec.Name || "",
            race: oppRace,
          },
        };
        games.push(game);

        const idxKey = enrichKey({
          dateMin: trimToMinute(date),
          opponent: oppRec.Name || "",
          map,
        });
        if (!enrichmentIndex.has(idxKey)) enrichmentIndex.set(idxKey, []);
        enrichmentIndex.get(idxKey).push(game);
      }
    }
  }

  for (const [buildName, rec] of Object.entries(raw.meta || {})) {
    const list = (rec && rec.games) || [];
    if (!Array.isArray(list)) continue;
    for (const m of list) {
      const date = parseIso(m.date);
      if (!date) continue;
      const map = (m.map && String(m.map)) || "Unknown Map";
      const idxKey = enrichKey({
        dateMin: trimToMinute(date),
        opponent: m.opponent || "",
        map,
      });
      const matches = enrichmentIndex.get(idxKey) || [];
      const enrichment = {
        myBuild: buildName,
        durationSec:
          typeof m.game_length === "number" ? m.game_length : undefined,
        buildLog: Array.isArray(m.build_log) ? m.build_log : undefined,
        macroScore:
          m.macro_breakdown && typeof m.macro_breakdown.macro_score === "number"
            ? m.macro_breakdown.macro_score
            : typeof m.macro_score === "number"
              ? m.macro_score
              : undefined,
      };
      Object.keys(enrichment).forEach((k) => {
        if (enrichment[k] === undefined) delete enrichment[k];
      });
      if (matches.length > 0) {
        for (const target of matches) {
          Object.assign(target, enrichment);
          target.opponent = {
            ...target.opponent,
            strategy: m.opp_strategy || target.opponent.strategy,
            race: capitalizeRace(m.opp_race) || target.opponent.race,
          };
        }
      } else {
        const result = normalizeResult(m.result);
        if (!result) continue;
        const myRace = guessMyRaceFromBuildName(buildName);
        const gameId = m.id ? `meta:${m.id}` : makeGameId(m.opponent, date, map);
        if (seenGameIds.has(gameId)) continue;
        seenGameIds.add(gameId);
        games.push({
          gameId,
          date: date.toISOString(),
          result,
          myRace,
          map,
          ...enrichment,
          opponent: {
            displayName: m.opponent || "",
            race: capitalizeRace(m.opp_race) || "U",
            strategy: m.opp_strategy || undefined,
          },
        });
      }
    }
  }

  const customBuilds = transformCustomBuilds(raw.customBuilds);
  const profile = transformProfile(raw.profile);

  return { games, customBuilds, profile };
}

function transformCustomBuilds(raw) {
  if (!raw || typeof raw !== "object") return [];
  const arr = Array.isArray(raw.builds) ? raw.builds : [];
  return arr.map((b) => ({
    slug: String(b.id || slugify(b.name) || ""),
    name: String(b.name || ""),
    race: String(b.race || ""),
    vs_race: String(b.vs_race || ""),
    skill_level: b.skill_level || undefined,
    description: b.description || undefined,
    win_conditions: Array.isArray(b.win_conditions) ? b.win_conditions : [],
    loses_to: Array.isArray(b.loses_to) ? b.loses_to : [],
    transitions_into: Array.isArray(b.transitions_into) ? b.transitions_into : [],
    rules: Array.isArray(b.rules) ? b.rules : [],
    source_replay_id: b.source_replay_id || undefined,
    author: b.author || undefined,
  })).filter((b) => b.slug.length > 0 && b.name.length > 0);
}

function transformProfile(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = {};
  if (raw.battlenet) {
    out.battleTag = raw.battlenet.battle_tag || undefined;
    out.characterId = raw.battlenet.character_id || undefined;
    out.accountId = raw.battlenet.account_id || undefined;
    out.region = raw.battlenet.region || undefined;
  }
  if (Array.isArray(raw.races)) out.races = raw.races;
  if (typeof raw.mmr_target === "number") out.mmrTarget = raw.mmr_target;
  if (raw.preferred_player_name_in_replays) {
    out.preferredName = String(raw.preferred_player_name_in_replays);
  }
  Object.keys(out).forEach((k) => {
    if (out[k] === undefined) delete out[k];
  });
  return Object.keys(out).length > 0 ? out : null;
}

function parseMatchup(key, fallbackOppRace) {
  const m = String(key || "").toUpperCase().match(/^([A-Z]+)V([A-Z]+)$/);
  if (!m) {
    return {
      myRace: "Unknown",
      oppRace: capitalizeRace(fallbackOppRace) || "U",
    };
  }
  return {
    myRace: RACE_FROM_TOKEN[m[1]] || "Unknown",
    oppRace: RACE_FROM_TOKEN[m[2]] || capitalizeRace(fallbackOppRace) || "U",
  };
}

function capitalizeRace(s) {
  if (!s) return "";
  const u = String(s).toUpperCase();
  if (RACE_FROM_TOKEN[u]) return RACE_FROM_TOKEN[u];
  const t = String(s);
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

function normalizeResult(r) {
  if (!r) return null;
  const s = String(r).toLowerCase();
  if (s === "victory" || s === "win") return "Victory";
  if (s === "defeat" || s === "loss") return "Defeat";
  if (s === "tie" || s === "draw") return "Tie";
  return null;
}

function parseLocalDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseIso(raw) {
  if (!raw) return null;
  const d = new Date(String(raw));
  return Number.isNaN(d.getTime()) ? null : d;
}

function trimToMinute(d) {
  return d.toISOString().slice(0, 16);
}

function enrichKey({ dateMin, opponent, map }) {
  return `${dateMin}|${opponent}|${map}`;
}

function makeGameId(seed1, date, seed2) {
  const h = crypto.createHash("sha256");
  h.update(String(seed1));
  h.update("|");
  h.update(date.toISOString());
  h.update("|");
  h.update(String(seed2));
  return h.digest("hex").slice(0, 24);
}

function guessMyRaceFromBuildName(name) {
  const s = String(name || "");
  if (/^Protoss\b|^P[vV]|^P\s/.test(s)) return "Protoss";
  if (/^Terran\b|^T[vV]|^T\s/.test(s)) return "Terran";
  if (/^Zerg\b|^Z[vV]|^Z\s/.test(s)) return "Zerg";
  return "Unknown";
}

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

module.exports = { transform };
