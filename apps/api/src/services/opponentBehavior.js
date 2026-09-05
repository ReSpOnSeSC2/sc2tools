"use strict";

/**
 * Replay-observable behavior comparisons. Each replay contributes one normalized
 * observation, so a spam-heavy game cannot overwhelm a player's other games.
 * Missing channels never become zero-valued matches. No keyboard bindings,
 * physical key presses, chat, or absolute map coordinates are used.
 */
/** @typedef {Record<string, any>} Row */
/** @typedef {{key:string,label:string,score:number|null,targetSamples:number,candidateSamples:number,targetValue?:number,candidateValue?:number,unit?:string,weight:number}} Dimension */

/** @param {unknown} value @returns {number} */
function count(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(99999, value) : 0;
}
/** @param {unknown} value @returns {boolean} */
function slotId(value) { return Number.isInteger(value) && Number(value) >= 0 && Number(value) < 10; }
/** @param {number[]} rows @returns {number} */
function mean(rows) { return rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : 0; }
/** @param {number[]} rows @returns {number} */
function median(rows) {
  const sorted = rows.slice().sort((a, b) => a - b);
  return sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2 : 0;
}
/** @param {number} value @returns {number} */
function round(value) { return Math.round(value * 10000) / 10000; }
/** @param {number[]} values @returns {number[]|null} */
function normalize(values) {
  const total = values.reduce((a, b) => a + count(b), 0);
  return total > 0 ? values.map((v) => count(v) / total) : null;
}
/** @param {number[]} a @param {number[]} b @returns {number} */
function overlap(a, b) { return a.reduce((sum, value, i) => sum + Math.min(value, b[i] || 0), 0); }
/** @param {number[][]} rows @returns {number[]} */
function averageVector(rows) {
  return Array.from({ length: Math.max(0, ...rows.map((r) => r.length)) }, (_, i) => mean(rows.map((r) => r[i] || 0)));
}
/** @param {Row} signature @returns {boolean} */
function supported(signature) { return signature?.version === 1 || signature?.version === 2; }
/** @param {unknown} value @returns {boolean} */
function validControlGroups(value) {
  const row = /** @type {Row|null} */ (value && typeof value === "object" ? value : null);
  return Boolean(row && count(row.events) > 0 && count(row.activeSeconds) > 0
    && Array.isArray(row.slots) && row.slots.slice(0, 10).some((/** @type {Row} */ s) =>
      slotId(s?.slot) && count(s.set) + count(s.add) + count(s.recall) + count(s.stealSet) + count(s.stealAdd) > 0));
}
/** @param {unknown} value @returns {boolean} */
function validActions(value) {
  const row = /** @type {Row|null} */ (value && typeof value === "object" ? value : null);
  return Boolean(row && count(row.activeSeconds) > 0 && count(row.events) > 0
    && count(row.commands) + count(row.selectionChanges) + count(row.cameraMoves) > 0);
}

/** @param {Row[]} games @param {'controlGroups'|'actions'} family @returns {Row[]} */
function observations(games, family) {
  return games.flatMap((game) => {
    const signature = game?.opponent?.playSignature;
    if (!supported(signature) || (family === "actions" && signature.version !== 2)) return [];
    const row = signature[family];
    if (!(family === "actions" ? validActions(row) : validControlGroups(row))) return [];
    return [{ ...row, version: signature.version }];
  });
}

/** @param {Row} row @param {string[]} fields @returns {number[]|null} */
function slotVector(row, fields) {
  const out = Array(10 * fields.length).fill(0);
  for (const slot of (Array.isArray(row.slots) ? row.slots : []).slice(0, 10)) {
    if (!slotId(slot?.slot)) continue;
    fields.forEach((field, i) => { out[slot.slot * fields.length + i] += count(slot[field]); });
  }
  return normalize(out);
}
/** @param {Row} row @returns {number[]|null} */
function transitionVector(row) {
  const out = Array(100).fill(0);
  for (const t of (Array.isArray(row.transitions) ? row.transitions : []).slice(0, 12)) {
    if (slotId(t?.from) && slotId(t?.to)) out[t.from * 10 + t.to] += count(t.count);
  }
  return normalize(out);
}
/** @param {unknown} value @returns {number[]|null} */
function histogram(value) {
  return Array.isArray(value) && value.length === 6 ? normalize(value.map(count)) : null;
}
/** @param {Row[]} left @param {Row[]} right @param {(row:Row)=>number[]|null} feature
 * @param {string} key @param {string} label @param {number} weight @returns {Dimension} */
function vectorDimension(left, right, feature, key, label, weight) {
  const a = left.map(feature).filter((v) => v !== null);
  const b = right.map(feature).filter((v) => v !== null);
  return { key, label, weight, targetSamples: a.length, candidateSamples: b.length,
    score: a.length && b.length ? round(overlap(averageVector(a), averageVector(b))) : null };
}
/** @param {Row[]} left @param {Row[]} right @param {(row:Row)=>number|null} feature
 * @param {string} key @param {string} label @param {number} weight @param {string} unit
 * @param {number} [scale] @returns {Dimension} */
function scalarDimension(left, right, feature, key, label, weight, unit, scale) {
  const a = left.map(feature).filter((v) => v !== null).filter(Number.isFinite);
  const b = right.map(feature).filter((v) => v !== null).filter(Number.isFinite);
  const av = median(a); const bv = median(b);
  return { key, label, weight, unit, targetSamples: a.length, candidateSamples: b.length,
    ...(a.length ? { targetValue: round(av) } : {}), ...(b.length ? { candidateValue: round(bv) } : {}),
    score: a.length && b.length ? round(scale
      ? Math.exp(-Math.abs(av - bv) / scale)
      : Math.exp(-Math.abs(Math.log((av + 0.05) / (bv + 0.05))))) : null };
}
/** @param {Row} row @param {string} numerator @param {string} denominator @returns {number|null} */
function fraction(row, numerator, denominator) {
  return count(row[denominator]) > 0 ? Math.min(1, count(row[numerator]) / count(row[denominator])) : null;
}
/** @param {Row} row @returns {number|null} */
function doubleTapRate(row) {
  const totals = row.slots.slice(0, 10).reduce((/** @type {number[]} */ a, /** @type {Row} */ s) =>
    [a[0] + count(s.doubleTap), a[1] + count(s.recall)], [0, 0]);
  return totals[1] > 0 ? Math.min(1, totals[0] / totals[1]) : null;
}
/** @param {Row} row @param {number} start @returns {Row|null} */
function fullPhase(row, start) {
  const end = start === 0 ? 120 : start === 120 ? 300 : 600;
  if (count(row.activeSeconds) < end) return null;
  // A short game has no evidence about phases it never reached. Require the
  // complete interval on both sides before comparing its slot distribution.
  return (Array.isArray(row.phases) ? row.phases : []).slice(0, 3)
    .find((/** @type {Row} */ p) => p?.startSec === start && p?.endSec === end) || null;
}

/** @param {number[]|null} values @param {number} size @returns {number[]} */
function observedPhase(values, size) {
  // A completely observed phase with no such activity is evidence of absence.
  // This sentinel is used only after fullPhase confirms observation coverage.
  return values ? [...values, 0] : [...Array(size).fill(0), 1];
}

/** @param {Row[]} left @param {Row[]} right @returns {Dimension[]} */
function advancedControlDimensions(left, right) {
  const a = left.filter((r) => r.version === 2);
  const b = right.filter((r) => r.version === 2);
  const dims = [vectorDimension(a, b, (r) => r.slots.every((/** @type {Row} */ s) => typeof s.stealSet === "number" && typeof s.stealAdd === "number" && typeof s.clear === "number")
    ? slotVector(r, ["set", "add", "stealSet", "stealAdd", "clear"]) : null,
    "group_updates", "Set, add, steal and clear by slot", 0.10),
  vectorDimension(a, b, (r) => histogram(r.recallIntervals), "recall_intervals", "Time between group recalls", 0.10)];
  for (const start of [0, 120, 300]) {
    dims.push(vectorDimension(a, b, (r) => { const p = fullPhase(r, start); return p ? observedPhase(slotVector(p, ["set", "add", "recall", "stealSet", "stealAdd"]), 50) : null; },
      `phase_${start}`, `Group usage at ${start / 60}–${start === 0 ? 2 : start === 120 ? 5 : 10} minutes`, 0.06));
  }
  // First use is compared only for slots observed on both sides, not absent
  // slots treated as time zero. The slot-distribution dimension covers those.
  const firstUse = [];
  for (let slot = 0; slot < 10; slot += 1) {
    const dimension = scalarDimension(a, b, (r) => {
      const s = r.slots.find((/** @type {Row} */ v) => v.slot === slot);
      return typeof s?.firstUseSec === "number" && s.firstUseSec >= 0 && s.firstUseSec <= 600 ? s.firstUseSec : null;
    }, `first_use_${slot}`, `First use of group ${slot}`, 0.01, "seconds", 30);
    if (dimension.score !== null) firstUse.push(dimension);
  }
  dims.push(...firstUse);
  dims.push(vectorDimension(a, b, (r) => {
    const values = Array(60).fill(0);
    for (const slot of r.slots.slice(0, 10)) {
      if (!slotId(slot.slot) || !Array.isArray(slot.recallIntervals) || slot.recallIntervals.length !== 6) continue;
      slot.recallIntervals.forEach((/** @type {unknown} */ value, /** @type {number} */ i) => { values[slot.slot * 6 + i] += count(value); });
    }
    return normalize(values);
  }, "slot_recall_intervals", "Recall rhythm for each group", 0.08));
  dims.push(vectorDimension(a, b, followupVector, "group_commands", "Commands and queue use after each group recall", 0.10));
  dims.push(abilityDimension(a, b, true));
  return dims;
}
/** @param {Row} row @returns {number[]|null} */
function followupVector(row) {
  const out = Array(30).fill(0);
  for (const s of (Array.isArray(row.commandFollowup) ? row.commandFollowup : []).slice(0, 10)) {
    if (!slotId(s?.slot)) continue;
    out[s.slot * 3] += count(s.commands);
    out[s.slot * 3 + 1] += count(s.queued);
    out[s.slot * 3 + 2] += count(s.rapidRepeat);
  }
  return normalize(out);
}
/** @param {Row} row @param {boolean} bySlot @returns {Map<string,number>} */
function abilities(row, bySlot) {
  const out = new Map();
  /** @param {unknown} list @param {string} prefix @param {number} limit */
  const add = (list, prefix, limit) => {
    for (const item of (Array.isArray(list) ? list : []).slice(0, limit)) {
      if (typeof item?.name !== "string" || !item.name.trim() || item.name.length > 64 || !count(item.count)) continue;
      const key = prefix + item.name;
      out.set(key, (out.get(key) || 0) + count(item.count));
    }
  };
  if (bySlot) {
    for (const s of (Array.isArray(row.commandFollowup) ? row.commandFollowup : []).slice(0, 10)) {
      if (slotId(s?.slot)) add(s.abilities, `${s.slot}:`, 6);
    }
  } else add(row.abilityUsage, "", 12);
  return out;
}
/** @param {Row[]} left @param {Row[]} right @param {boolean} bySlot @returns {Dimension} */
function abilityDimension(left, right, bySlot) {
  const keys = [...new Set([...left, ...right].flatMap((r) => [...abilities(r, bySlot).keys()]))];
  return vectorDimension(left, right, (r) => { const values = abilities(r, bySlot); return normalize(keys.map((k) => values.get(k) || 0)); },
    bySlot ? "group_abilities" : "abilities", bySlot ? "Ability use after each group recall" : "Command ability mix", bySlot ? 0.10 : 0.08);
}

/** @param {Row[]} rows @param {number} slot @returns {string[]} */
function primaryGroupAbilities(rows, slot) {
  const totals = new Map();
  for (const row of rows.filter((r) => r.version === 2)) {
    const matching = [...abilities(row, true)].filter(([key]) => key.startsWith(`${slot}:`));
    const total = matching.reduce((n, [, value]) => n + value, 0);
    for (const [key, value] of matching) {
      const name = key.slice(key.indexOf(":") + 1);
      totals.set(name, (totals.get(name) || 0) + value / total);
    }
  }
  return [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 2).map(([name]) => name);
}
/** @param {Row[]} rows @param {(row:Row)=>number[]|null} feature @returns {number|null} */
function consistency(rows, feature) {
  const vectors = rows.map(feature).filter((r) => r !== null).slice(0, 8);
  if (vectors.length < 2) return null;
  const scores = [];
  for (let i = 0; i < vectors.length; i += 1) {
    for (let j = i + 1; j < vectors.length; j += 1) scores.push(overlap(vectors[i], vectors[j]));
  }
  return round(mean(scores));
}
/** @param {Dimension[]} dimensions @param {number} targetCount @param {number} candidateCount @returns {number|null} */
function weightedScore(dimensions, targetCount, candidateCount) {
  const usable = dimensions.filter((d) => d.score !== null);
  const weight = (/** @type {Dimension} */ d) => d.weight
    * Math.sqrt(Math.min(d.targetSamples / targetCount, d.candidateSamples / candidateCount));
  const total = usable.reduce((sum, d) => sum + weight(d), 0);
  return total > 0 ? round(usable.reduce((sum, d) => sum + (d.score || 0) * weight(d), 0) / total) : null;
}
/** @param {Row[]} target @param {Row[]} candidate @param {Dimension[]} dimensions
 * @param {(row:Row)=>number[]|null} stabilityFeature @param {number} eventThreshold @returns {Row|null} */
function finishComponent(target, candidate, dimensions, stabilityFeature, eventThreshold) {
  const score = weightedScore(dimensions, target.length, candidate.length);
  if (score === null) return null;
  const targetConsistency = consistency(target, stabilityFeature);
  const candidateConsistency = consistency(candidate, stabilityFeature);
  const stability = Math.min(targetConsistency ?? 1, candidateConsistency ?? 1);
  const eventQuality = Math.min(
    mean(target.map((r) => Math.min(1, count(r.events) / eventThreshold) * Math.min(1, count(r.activeSeconds) / 120))),
    mean(candidate.map((r) => Math.min(1, count(r.events) / eventThreshold) * Math.min(1, count(r.activeSeconds) / 120))));
  const measuredWeight = dimensions.filter((d) => d.score !== null).reduce((sum, d) => sum
    + d.weight * Math.sqrt(Math.min(d.targetSamples / target.length, d.candidateSamples / candidate.length)), 0);
  const quality = eventQuality * (0.5 + 0.5 * Math.min(1, measuredWeight)) * (0.5 + 0.5 * stability);
  return { score, targetSamples: target.length, candidateSamples: candidate.length,
    reliability: round(quality), targetEvents: target.reduce((n, r) => n + count(r.events), 0),
    candidateEvents: candidate.reduce((n, r) => n + count(r.events), 0),
    consistency: { target: targetConsistency, candidate: candidateConsistency },
    dimensions: dimensions.map(({ weight: _weight, ...d }) => d),
    highlights: dimensions.filter((d) => d.score !== null && d.score >= 0.85).slice(0, 4).map((d) => `Similar ${d.label.toLowerCase()}`) };
}

/** @param {Row[]} targetGames @param {Row[]} candidateGames @returns {Row|null} */
function controlGroupComponent(targetGames, candidateGames) {
  const a = observations(targetGames, "controlGroups"); const b = observations(candidateGames, "controlGroups");
  if (!a.length || !b.length) return null;
  // v1 used unbounded transitions and looser double-tap semantics. Compare
  // these channels only within the same version, preferring detailed v2.
  const rhythmVersion = a.some((r) => r.version === 2) && b.some((r) => r.version === 2) ? 2 : 1;
  const rhythmA = a.filter((r) => r.version === rhythmVersion);
  const rhythmB = b.filter((r) => r.version === rhythmVersion);
  const dimensions = [
    vectorDimension(a, b, (r) => slotVector(r, ["recall"]), "recall_slots", "Preferred recall slots", 0.14),
    vectorDimension(a, b, (r) => slotVector(r, ["set", "add", "recall"]), "slot_actions", "Set, add and recall by slot", 0.10),
    vectorDimension(rhythmA, rhythmB, transitionVector, "transitions", "Switching between groups", 0.07),
    scalarDimension(rhythmA, rhythmB, doubleTapRate, "double_tap", "Consecutive same-group recall rate", 0.05, "ratio", 0.2),
    scalarDimension(a, b, (r) => Math.max(0, count(r.events) - (r.version === 2 ? r.slots.reduce((/** @type {number} */ sum, /** @type {Row} */ s) => sum + count(s.clear), 0) : 0))
      * 60 / Math.max(1, count(r.activeSeconds)), "event_rate", "Control-group actions per minute", 0.04, "per_minute"),
    ...advancedControlDimensions(a, b),
  ];
  const result = finishComponent(a, b, dimensions, (r) => slotVector(r, ["set", "add", "recall", "stealSet", "stealAdd"]), 80);
  if (!result) return null;
  const recall = (/** @type {Row[]} */ rows) => averageVector(rows.map((r) => slotVector(r, ["recall"])).filter((r) => r !== null));
  const av = recall(a); const bv = recall(b);
  const top = (/** @type {number[]} */ values) => values.map((v, i) => ({ v, i })).filter((r) => r.v > 0).sort((x, y) => y.v - x.v).slice(0, 3).map((r) => r.i);
  const commandHighlights = [...new Set([...top(av), ...top(bv)])].slice(0, 3).flatMap((slot) => {
    const targetAbilities = primaryGroupAbilities(a, slot);
    const candidateAbilities = primaryGroupAbilities(b, slot);
    if (!targetAbilities.length || !candidateAbilities.length) return [];
    return [`Group ${slot} commands after recall: target ${targetAbilities.join(", ")}; candidate ${candidateAbilities.join(", ")}`];
  });
  return { ...result, highlights: [...commandHighlights, ...result.highlights].slice(0, 6),
    matchedSlots: top(av).filter((slot) => top(bv).includes(slot)),
    advancedSamples: { target: a.filter(hasAdvancedControls).length, candidate: b.filter(hasAdvancedControls).length } };
}

/** @param {Row} row @returns {boolean} */
function hasAdvancedControls(row) {
  return row.version === 2 && Array.isArray(row.phases) && row.phases.length > 0
    && Array.isArray(row.recallIntervals);
}

/** @param {Row} row @returns {number[]|null} */
function actionMix(row) { return normalize([count(row.commands), count(row.selectionChanges), count(row.cameraMoves)]); }
/** @param {Row[]} targetGames @param {Row[]} candidateGames @returns {Row|null} */
function actionComponent(targetGames, candidateGames) {
  const a = observations(targetGames, "actions"); const b = observations(candidateGames, "actions");
  if (!a.length || !b.length) return null;
  const dimensions = [
    vectorDimension(a, b, actionMix, "action_mix", "Commands, selection changes and camera events", 0.16),
    vectorDimension(a, b, (r) => histogram(r.actionIntervals), "action_intervals", "Time between commands and group actions", 0.22),
    vectorDimension(a, b, (r) => histogram(r.cameraIntervals), "camera_intervals", "Time between camera events", 0.10),
    vectorDimension(a, b, (r) => normalize(["none", "point", "unit", "data"].map((key) => count(r.targetCommands?.[key]))), "command_targets", "Command target types", 0.10),
    scalarDimension(a, b, (r) => fraction(r, "queuedCommands", "commands"), "queued_commands", "Queued command share", 0.07, "ratio", 0.15),
    scalarDimension(a, b, (r) => fraction(r, "repeatCommands", "commands"), "repeated_commands", "Repeated command share", 0.07, "ratio", 0.2),
    scalarDimension(a, b, (r) => count(r.commands) * 60 / Math.max(1, count(r.activeSeconds)), "command_rate", "Command events per minute", 0.08, "per_minute"),
    abilityDimension(a, b, false),
  ];
  for (const start of [0, 120, 300]) {
    dimensions.push(vectorDimension(a, b, (r) => { const p = fullPhase(r, start); return p ? observedPhase(actionMix(p), 3) : null; },
      `action_phase_${start}`, `Action mix at ${start / 60}–${start === 0 ? 2 : start === 120 ? 5 : 10} minutes`, 0.04));
  }
  return finishComponent(a, b, dimensions, actionMix, 200);
}

module.exports = { controlGroupComponent, actionComponent, validControlGroups, validActions };
