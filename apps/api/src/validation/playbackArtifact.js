"use strict";

const MAX_SEGMENT_BYTES = 2 * 1024 * 1024;
const MAX_SEGMENT_POINTS = 60000;
const MAX_MANIFEST_BYTES = 200000;
const SHA = /^[a-f0-9]{64}$/;
/** @param {any} v */
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const fail = () => { throw Object.assign(new Error("invalid_playback_artifact"), { status: 400, code: "invalid_playback_artifact" }); };
/** @param {any} v */
const object = (v) => v && typeof v === "object" && !Array.isArray(v);

/** Validate the complete admission plan before accepting any segment. @param {any} m */
function validateManifest(m) {
  if (!object(m) || m.schema !== "sc2tools-playback-manifest-v1" || !SHA.test(m.replaySha256)
      || !SHA.test(m.sourceArtifactSha256) || typeof m.mapName !== "string" || m.mapName.length > 200
      || !finite(m.gameLength) || m.gameLength <= 0 || m.gameLength > 86400
      || !object(m.fidelity) || m.fidelity.positions !== "engine" || m.fidelity.complete !== true
      || !finite(m.fidelity.positionError) || m.fidelity.positionError < 0 || m.fidelity.positionError > 0.5
      || !Array.isArray(m.segments) || !m.segments.length || m.segments.length > 512
      || Buffer.byteLength(JSON.stringify(m)) > MAX_MANIFEST_BYTES) fail();
  let end = 0;
  m.segments.forEach((/** @type {any} */ s, /** @type {number} */ index) => {
    if (!object(s) || s.index !== index || s.start !== end || !finite(s.end) || s.end <= s.start
        || s.end > m.gameLength || !Number.isInteger(s.sizeBytes) || s.sizeBytes <= 0 || s.sizeBytes > MAX_SEGMENT_BYTES
        || !Number.isInteger(s.points) || s.points < 0 || s.points > MAX_SEGMENT_POINTS || !SHA.test(s.sha256)) fail();
    end = s.end;
  });
  if (end !== m.gameLength) fail();
  return m;
}

/** @param {any[]} values @param {number} limit */
function triples(values, limit) {
  if (!Array.isArray(values) || values.length % 3 || values.length / 3 > limit) fail();
  let last = -1;
  for (let i = 0; i < values.length; i += 3) {
    if (!values.slice(i, i + 3).every(finite) || values[i] <= last || values[i] > 86400) fail();
    last = values[i];
  }
  return values.length / 3;
}

/** Every admitted byte is parsed/validated; no metadata-only completion. @param {any} s @param {any} m @param {any} descriptor */
function validateSegment(s, m, descriptor) {
  if (!object(s) || s.schema !== "sc2tools-playback-segment-v1" || s.replaySha256 !== m.replaySha256
      || s.index !== descriptor.index || s.start !== descriptor.start || s.end !== descriptor.end) fail();
  const p = s.playback;
  if (!object(p) || p.v !== 7 || p.terminalAttackInclusive !== true || p.replaySha256 !== m.replaySha256
      || p.gameLength !== m.gameLength || p.mapName !== m.mapName || !object(p.fidelity)
      || p.fidelity.complete !== true || p.fidelity.positions !== "engine"
      || !finite(p.fidelity.positionError) || p.fidelity.positionError < 0 || p.fidelity.positionError > 0.5
      || !object(p.bounds) || !Object.values(p.bounds).every(finite)
      || !(p.bounds.maxX > p.bounds.minX) || !(p.bounds.maxY > p.bounds.minY)) fail();
  let points = 0;
  for (const [key, max, track] of /** @type {[string, number, string][]} */ ([["units", 4000, "wp"], ["buildings", 1000, "moves"]])) {
    if (!Array.isArray(p[key]) || p[key].length > max) fail();
    const ids = new Set();
    for (const e of p[key]) {
      if (!object(e) || !["me", "opp"].includes(e.owner) || typeof e.name !== "string" || e.name.length > 200) fail();
      const birth = key === "units" ? e.born : e.t;
      if (!finite(birth) || birth < 0 || (e.died != null && (!finite(e.died) || e.died < birth))) fail();
      if (e.id != null) {
        if (!/^\d{1,20}$/.test(String(e.id)) || ids.has(String(e.id))) fail();
        ids.add(String(e.id));
      }
      points += triples(e[track] || [], 16384);
      if (e.attacks != null) {
        if (!Array.isArray(e.attacks) || e.attacks.length > 16384) fail();
        let previous = -1;
        for (const t of e.attacks) {
          if (!finite(t) || t <= previous || t < birth || (e.died != null && t > e.died)
              || t < s.start - 0.001 || t > s.end + 0.001) fail();
          previous = t;
        }
      }
      if (e.aim) {
        triples(e.aim, 16384);
        const shots = new Set(e.attacks || []);
        for (let i = 0; i < e.aim.length; i += 3) if (!shots.has(e.aim[i])) fail();
      }
      if (e.forms && (!Array.isArray(e.forms) || e.forms.length > 512
          || e.forms.some((/** @type {any} */ f) => !object(f) || !finite(f.t) || typeof f.name !== "string" || f.name.length > 200))) fail();
      if (e.hidden && (!Array.isArray(e.hidden) || e.hidden.length % 2 || e.hidden.length > 16384
          || e.hidden.some((/** @type {any} */ v, /** @type {number} */ i) => !finite(v) || v < 0 || (i % 2 && v < e.hidden[i - 1])))) fail();
    }
  }
  if (points !== descriptor.points || points > MAX_SEGMENT_POINTS) fail();
  for (const [key, max] of /** @type {[string, number][]} */ ([["casts", 2000], ["effects", 10000], ["resources", 600], ["battles", 200], ["spawns", 16]])) {
    if (p[key] != null && (!Array.isArray(p[key]) || p[key].length > max)) fail();
  }
  if (p.creep) {
    const c = p.creep;
    if (!Number.isInteger(c.width) || !Number.isInteger(c.height) || c.width < 1 || c.height < 1
        || c.width > 512 || c.height > 512 || !Array.isArray(c.frames) || c.frames.length > 12000) fail();
    let previous = -1;
    for (const frame of c.frames) {
      if (!finite(frame.t) || frame.t <= previous || !Array.isArray(frame.runs) || frame.runs.length % 2) fail();
      previous = frame.t;
      let end = 0;
      for (let i = 0; i < frame.runs.length; i += 2) {
        const [start, size] = frame.runs.slice(i, i + 2);
        if (!Number.isInteger(start) || !Number.isInteger(size) || start < end || size < 1 || start + size > c.width * c.height) fail();
        end = start + size;
      }
    }
  }
  if (p.stats && Object.values(p.stats).some((rows) => !Array.isArray(rows) || rows.length > 800)) fail();
  return s;
}

module.exports = { validateManifest, validateSegment, MAX_SEGMENT_BYTES, MAX_MANIFEST_BYTES, SHA };
