"use strict";

// Shared synthetic fixtures only. This pure builder opens no account, socket or store.
const samples = require("../../../web/lib/overlaySamples.json");
const PER_WIDGET_KEYS = /** @type {Record<string, string[]>} */ (samples.widgetKeys);
const SHARED_KEYS = samples.sharedKeys;

/** @param {string} [widget] @param {string} [scenario] @returns {Record<string, any>} */
function buildSamplePayload(widget, scenario = "victory") {
  const full = /** @type {Record<string, any>} */ (structuredClone(samples.payload));
  const selected = samples.scenarios.find(item => item.id === scenario);
  if (selected) Object.assign(full, structuredClone(selected.patch));
  full.session.sessionStartedAt = new Date(Date.now() - samples.sessionAgeSec * 1000).toISOString();
  const keys = widget && Object.hasOwn(PER_WIDGET_KEYS, widget) ? PER_WIDGET_KEYS[widget] : null;
  if (!keys) return full;
  return Object.fromEntries([...SHARED_KEYS, ...keys].filter(key => full[key] !== undefined).map(key => [key, full[key]]));
}

module.exports = { buildSamplePayload, PER_WIDGET_KEYS, SHARED_KEYS };
