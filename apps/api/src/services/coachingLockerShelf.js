"use strict";

/** @typedef {Record<string, any>} State */
/** @typedef {{role:string,coachId?:string}} Actor */
const MAX_ATTACHMENT = 6 * 1024 * 1024;
const ATTACHMENT_KEY = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const isShelf = (/** @type {unknown} */ value) => value == null || Array.isArray(value);
const isObject = (/** @type {unknown} */ value) => !!value && typeof value === "object" && !Array.isArray(value);

/** @param {unknown} value @returns {value is {n:string,mime:string,b64:string,size:number}} */
function safeAttachment(value) {
  if (!isObject(value)) return false;
  const { n, mime, b64, size } = /** @type {State} */ (value);
  return typeof n === "string" && n.length > 0 && n.length <= 240
    && typeof mime === "string" && /^[\w.+-]+\/[\w.+-]+(?:;codecs=[\w.+-]+)?$/.test(mime)
    && typeof b64 === "string" && b64.length > 0 && b64.length <= MAX_ATTACHMENT * 4 / 3
    && b64.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(b64)
    && Number.isSafeInteger(size) && size === Buffer.byteLength(b64, "base64");
}

/** Read actual Locker attachment fields without treating arbitrary text as an asset reference.
 * @param {unknown} value @param {Set<string>} found */
function collectRefs(value, found) {
  const queue = [value];
  while (queue.length) {
    const entry = queue.pop();
    if (!entry || typeof entry !== "object") continue;
    for (const [key, child] of Object.entries(entry)) {
      if ((key === "asset" || key === "refAsset") && typeof child === "string") found.add(child);
      if (child && typeof child === "object") queue.push(child);
    }
  }
}

/** @param {State} state @param {unknown} visible */
function selectLockerAssets(state, visible) {
  /** @type {Set<string>} */
  const refs = new Set();
  collectRefs(visible, refs);
  const assets = state.assets || {};
  return Object.fromEntries([...refs].filter(key => Object.hasOwn(assets, key)).map(key => [key, assets[key]]));
}

/** Accept only card-list changes on existing visible students and the shared library.
 * All other top-level and per-student data comes from the server's snapshot.
 * @param {State} current @param {State} incoming @param {Actor} actor @param {State} allowedAssets
 * @returns {State|null} */
function mergeShelfWrite(current, incoming, actor, allowedAssets) {
  const members = Array.isArray(current.students) ? current.students : [];
  const patch = new Map((Array.isArray(incoming.students) ? incoming.students : [])
    .filter(row => row && typeof row.id === "string" && isShelf(row.shelf)).map(row => [row.id, row]));
  const library = incoming.shelfLibrary;
  if (!isShelf(library)) return null;
  /** @type {unknown[]} */
  const previous = [];
  /** @type {unknown[]} */
  const changed = [];
  const students = members.map(student => {
    if (!student || (actor.role !== "admin" && student.coachId !== actor.coachId) || !patch.has(student.id)) return student;
    const incomingStudent = patch.get(student.id);
    const { shelf, ...unchanged } = student;
    previous.push(shelf);
    changed.push(incomingStudent.shelf);
    return Object.hasOwn(incomingStudent, "shelf") ? { ...unchanged, shelf: incomingStudent.shelf } : unchanged;
  });
  const oldRefs = new Set(), nextRefs = new Set();
  collectRefs([previous, current.shelfLibrary], oldRefs);
  collectRefs([changed, library], nextRefs);
  const assets = { ...(current.assets || {}) };
  let addedAttachment = false;
  const offered = incoming.assets || {};
  for (const key of nextRefs) {
    if (Object.hasOwn(allowedAssets, key) || oldRefs.has(key)) continue;
    if (Object.hasOwn(assets, key) || !Object.hasOwn(offered, key) || !ATTACHMENT_KEY.test(key) || !safeAttachment(offered[key])) return null;
    const { n, mime, b64, size } = offered[key];
    assets[key] = { n, mime, b64, size };
    addedAttachment = true;
  }
  /** @type {State} */
  const next = { ...current, students };
  if (Object.keys(assets).length || Object.hasOwn(current, "assets")) next.assets = assets;
  if (Object.hasOwn(incoming, "shelfLibrary")) next.shelfLibrary = library;
  else delete next.shelfLibrary;
  if (addedAttachment && Buffer.byteLength(JSON.stringify(next)) > 12 * 1024 * 1024) {
    throw Object.assign(new Error("The Locker does not have room for this file."), { status: 413, code: "locker_storage_full" });
  }
  return next;
}

module.exports = { mergeShelfWrite, selectLockerAssets };
