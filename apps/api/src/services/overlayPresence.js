"use strict";
const { KNOWN_WIDGETS } = require("./overlayTokens");
const rules = require("../../../web/lib/overlayPresenceRules.json");
const widgets = new Set([...KNOWN_WIDGETS, "ghost-build"]), scenes = new Set(rules.scenes);

/** Legacy or malformed descriptors stay visible as unknown, never as a
 * different trusted surface. These fields are labels, not authorization.
 * @param {unknown} raw @returns {{surface:string,widget:string|null}} */
function overlayDescriptor(raw) {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? /** @type {Record<string,unknown>} */ (raw) : {};
  const surface = typeof value.surface === "string" && rules.surfaces.includes(value.surface) ? value.surface : "unknown";
  if (surface === "widget") return typeof value.widget === "string" && widgets.has(value.widget) ? { surface, widget: value.widget } : { surface: "unknown", widget: null };
  if (surface === "scene") return typeof value.widget === "string" && scenes.has(value.widget) ? { surface, widget: value.widget } : { surface: "unknown", widget: null };
  return { surface, widget: null };
}

/** Counts only: never serialize a socket, room, bearer token or user identity.
 * @param {Array<{data?:Record<string,any>}>} overlaySockets
 * @param {Array<{data?:Record<string,any>}>} userSockets
 * @param {string} token @param {string} userId @param {number|null} lastLiveAt
 * @param {number} [now] */
function summarizeOverlayPresence(overlaySockets, userSockets, token, userId, lastLiveAt, now = Date.now()) {
  /** @type {Record<string,{count:number,oldestConnectedAt:string|null}>} */
  const surfaces = Object.fromEntries([...rules.surfaces, "unknown"].map(id => [id, { count: 0, oldestConnectedAt: null }]));
  /** @type {Record<string,{count:number,oldestConnectedAt:string|null}>} */
  const byWidget = {};
  /** @type {Record<string,{count:number,oldestConnectedAt:string|null}>} */
  const byScene = {};
  /** @param {Record<string,{count:number,oldestConnectedAt:string|null}>} target @param {string} id @param {string|null} at */
  const add = (target, id, at) => {
    const bucket = target[id] || (target[id] = { count: 0, oldestConnectedAt: null }); bucket.count++;
    if (at && (!bucket.oldestConnectedAt || at < bucket.oldestConnectedAt)) bucket.oldestConnectedAt = at;
  };
  let totalSources = 0;
  for (const socket of overlaySockets) {
    const data = socket.data;
    if (!data || data.kind !== "overlay" || data.overlayToken !== token || data.overlayUserId !== userId) continue;
    const descriptor = overlayDescriptor(data.overlayPresence);
    const stamp = data.overlayConnectedAt;
    const connectedAt = typeof stamp === "number" && Number.isFinite(stamp) && stamp > 0 && stamp <= now ? new Date(stamp).toISOString() : null;
    add(surfaces, descriptor.surface, connectedAt); totalSources++;
    if (descriptor.widget) add(descriptor.surface === "widget" ? byWidget : byScene, descriptor.widget, connectedAt);
  }
  return { surfaces, widgets: byWidget, scenes: byScene, totalSources,
    agent: { online: userSockets.some(socket => socket.data?.kind === "device" && socket.data?.userId === userId) },
    lastLiveAt: typeof lastLiveAt === "number" && Number.isFinite(lastLiveAt) && lastLiveAt > 0 && lastLiveAt <= now ? new Date(lastLiveAt).toISOString() : null,
    sampledAt: new Date(now).toISOString(),
  };
}

/** Socket.IO uses the existing single-instance in-memory adapter. No database
 * aggregation, provider lookup or new persistent collection is involved.
 * @param {import('socket.io').Server|undefined} io @param {string} token @param {string} userId
 * @param {{latestOverlayLiveAt?:(userId:string)=>number|null}} [broker] */
async function readOverlayPresence(io, token, userId, broker) {
  if (!io) throw Object.assign(new Error("Overlay presence is temporarily unavailable."), { status: 503, code: "overlay_presence_unavailable" });
  let timer;
  try {
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("Overlay presence is temporarily unavailable."), { status: 503, code: "overlay_presence_unavailable" })), 1000); });
    const [overlaySockets, userSockets] = await Promise.race([Promise.all([io.in(`overlay:${token}`).fetchSockets(), io.in(`user:${userId}`).fetchSockets()]), timeout]);
    return summarizeOverlayPresence(overlaySockets, userSockets, token, userId, broker?.latestOverlayLiveAt?.(userId) ?? null);
  } finally { clearTimeout(timer); }
}
module.exports = { overlayDescriptor, summarizeOverlayPresence, readOverlayPresence };
