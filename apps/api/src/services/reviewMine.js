"use strict";

/** @typedef {Record<string, any>} Doc */
/** @typedef {{card:(doc:Doc,replay:boolean)=>Doc,encode:(cursor:Doc)=>string,decode:(raw:unknown)=>Doc|null,snippet:(text:unknown)=>string,replayReady:(docs:Doc[])=>Promise<Set<string>>}} Helpers */
/** @typedef {import('../db/connect').DbContext} Db */

const ASKED_TABS = Object.freeze({
  needs: { status: "open", reviewCount: { $gt: 0 } },
  waiting: { status: "open", reviewCount: 0 },
  answered: { status: "answered" },
  closed: { status: "closed" },
  all: { status: { $ne: "removed" } },
});

/** @param {unknown} value */
function pageLimit(value) {
  const parsed = Number(value);
  return value == null || value === "" || !Number.isFinite(parsed)
    ? 20 : Math.max(1, Math.min(50, Math.trunc(parsed)));
}

/** @param {Db} db @param {string} userId */
async function askedCounts(db, userId) {
  return Object.fromEntries(await Promise.all(Object.entries(ASKED_TABS).map(async ([tab, filter]) => [
    tab, await db.reviewRequests.countDocuments({ userId, ...filter }),
  ])));
}

/** @param {Doc} row @param {string} section @param {string} sort @param {Helpers} helpers @param {Doc} [extra] */
function nextCursor(row, section, sort, helpers, extra = {}) {
  return helpers.encode({ s: sort, section, id: row._id,
    v: sort === "top" ? Number(row.upvotes) || 0 : new Date(row.createdAt).toISOString(),
    ...(sort === "top" ? { at: new Date(row.createdAt).toISOString() } : {}), ...extra });
}

/** @param {Db} db @param {string} userId @param {Doc} query @param {Helpers} helpers */
async function askedPage(db, userId, query, helpers) {
  const tab = Object.hasOwn(ASKED_TABS, query.tab) ? /** @type {keyof typeof ASKED_TABS} */ (query.tab) : "all";
  const limit = pageLimit(query.limit);
  /** @type {Doc} */
  const filter = { userId, ...ASKED_TABS[tab] };
  const cursor = helpers.decode(query.cursor);
  if (cursor?.s === "new" && cursor.section === "asked" && cursor.tab === tab) {
    const at = new Date(cursor.v);
    filter.$or = [{ createdAt: { $lt: at } }, { createdAt: at, _id: { $lt: cursor.id } }];
  }
  const rows = await db.reviewRequests.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).toArray();
  const page = rows.slice(0, limit);
  const ready = await helpers.replayReady(page);
  return {
    items: page.map((doc) => ({ ...helpers.card(doc, ready.has(doc._id)), visibility: doc.visibility, hidden: doc.hidden === true, isOwn: true })),
    nextCursor: rows.length > limit ? nextCursor(page[page.length - 1], "asked", "new", helpers, { tab }) : null,
  };
}

/** @param {Doc|null} cursor @param {string} sort @returns {Doc|undefined} */
function authoredCursorFilter(cursor, sort) {
  if (!cursor || cursor.section !== "answered" || cursor.s !== sort) return;
  const at = new Date(sort === "top" ? cursor.at : cursor.v);
  if (!Number.isFinite(at.getTime())) return;
  if (sort === "new") return { $or: [{ createdAt: { $lt: at } }, { createdAt: at, _id: { $lt: cursor.id } }] };
  const upvotes = Number(cursor.v);
  return { $or: [{ upvotes: { $lt: upvotes } }, { upvotes, createdAt: { $lt: at } }, { upvotes, createdAt: at, _id: { $lt: cursor.id } }] };
}

/** @param {Db} db @param {Doc[]} authored @param {string} userId @param {Helpers} helpers */
async function authoredItems(db, authored, userId, helpers) {
  const ids = [...new Set(authored.map((comment) => comment.requestId))];
  const requests = ids.length ? await db.reviewRequests.find({ _id: { $in: ids }, status: { $ne: "removed" } }).toArray() : [];
  const byId = new Map(requests.map((doc) => [doc._id, doc]));
  const ready = await helpers.replayReady(requests);
  return authored.flatMap((comment) => {
    const doc = byId.get(comment.requestId);
    if (!doc || (doc.hidden && doc.userId !== userId)) return [];
    return [{ request: helpers.card(doc, ready.has(doc._id)), commentId: comment._id, snippet: helpers.snippet(comment.body),
      helpful: comment.helpful === true, best: comment.best === true, upvotes: Number(comment.upvotes) || 0,
      createdAt: comment.createdAt ? new Date(comment.createdAt).toISOString() : null }];
  });
}

/** @param {Db} db @param {string} userId @param {Doc} query @param {Helpers} helpers */
async function answeredPage(db, userId, query, helpers) {
  const sort = query.sort === "top" ? "top" : "new";
  const limit = pageLimit(query.limit);
  const filter = { authorId: userId, parentId: null, isAskerComment: { $ne: true }, status: { $in: ["visible", "hidden"] },
    ...authoredCursorFilter(helpers.decode(query.cursor), sort) };
  /** @type {Record<string, 1|-1>} */
  const order = sort === "top" ? { upvotes: -1, createdAt: -1, _id: -1 } : { createdAt: -1, _id: -1 };
  const rows = await db.reviewComments.find(filter).sort(order).limit(limit + 1).toArray();
  const page = rows.slice(0, limit);
  return { items: await authoredItems(db, page, userId, helpers),
    nextCursor: rows.length > limit ? nextCursor(page[page.length - 1], "answered", sort, helpers) : null };
}

/** Personal lists remain bounded; cursors always retain the authenticated owner filter.
 * @param {Db} db @param {string} userId @param {Doc} query @param {Helpers} helpers */
async function mineReviews(db, userId, query, helpers) {
  if (query.section === "asked") return askedPage(db, userId, query, helpers);
  if (query.section === "answered") return answeredPage(db, userId, query, helpers);
  const [asked, answered, counts] = await Promise.all([
    askedPage(db, userId, { tab: "all", limit: 20 }, helpers),
    answeredPage(db, userId, { sort: "new", limit: 20 }, helpers),
    askedCounts(db, userId),
  ]);
  return { asked: asked.items, answered: answered.items, counts,
    askedNextCursor: asked.nextCursor, answeredNextCursor: answered.nextCursor };
}

module.exports = { mineReviews };
