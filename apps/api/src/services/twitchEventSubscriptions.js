"use strict";

/**
 * Twitch EventSub subscription reconciliation.
 *
 * Twitch identifies a subscription by type + version + condition. The transport
 * callback is NOT part of that identity, so a create collides with any existing
 * row for the same event — whatever callback it points at and whatever state it
 * is in. There is no update call either. Reconciling therefore means releasing
 * whatever holds a slot before recreating it, which is what this module does.
 */

const {
  PlatformOauthError,
  fetchJson,
  fetchNoContent,
  safeMessage,
} = require("./platformOauthHttp");

// A Twitch EventSub conflict names the subscription already holding the slot,
// e.g. "subscription already exists; id=d5ad6ba1-…". Matching the documented id
// shape keeps a surprising body from turning into a delete of something else.
const TWITCH_CONFLICT_ID_PATTERN =
  /\bid[=:]\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

const TWITCH_EVENT_TYPES = Object.freeze([
  {
    type: "channel.follow",
    version: "2",
    condition: (/** @type {string} */ id) => ({ broadcaster_user_id: id, moderator_user_id: id }),
  },
  {
    type: "channel.channel_points_custom_reward_redemption.add",
    version: "1",
    condition: (/** @type {string} */ id) => ({ broadcaster_user_id: id }),
  },
  {
    type: "channel.channel_points_automatic_reward_redemption.add",
    version: "2",
    condition: (/** @type {string} */ id) => ({ broadcaster_user_id: id }),
  },
  {
    type: "channel.subscribe",
    version: "1",
    condition: (/** @type {string} */ id) => ({ broadcaster_user_id: id }),
  },
  {
    type: "channel.subscription.message",
    version: "1",
    condition: (/** @type {string} */ id) => ({ broadcaster_user_id: id }),
  },
  {
    type: "channel.subscription.gift",
    version: "1",
    condition: (/** @type {string} */ id) => ({ broadcaster_user_id: id }),
  },
  {
    type: "channel.cheer",
    version: "1",
    condition: (/** @type {string} */ id) => ({ broadcaster_user_id: id }),
  },
  {
    type: "channel.raid",
    version: "1",
    condition: (/** @type {string} */ id) => ({ to_broadcaster_user_id: id }),
  },
]);

/** @typedef {{broadcasterUserId:string,appAccessToken:string,clientId:string,callbackUrl:string,webhookSecret:string,fetchImpl?:typeof fetch}} TwitchReconcileArgs */

/** @param {TwitchReconcileArgs} args */
async function reconcileTwitchEventSubscriptions(args) {
  const existing = await listTwitchSubscriptions(args);
  // Every row holding one of our slots has to be indexed here, not only the
  // healthy ones: a dead status or a callback from an earlier deployment
  // otherwise becomes a conflict that no reconnect can clear.
  /** @type {Map<string, Record<string, any>[]>} */
  const owners = new Map();
  for (const row of existing) {
    const key = twitchSubscriptionKey(row);
    const rows = owners.get(key);
    if (rows) rows.push(row);
    else owners.set(key, [row]);
  }
  const created = [];
  const removed = [];
  for (const spec of TWITCH_EVENT_TYPES) {
    const condition = spec.condition(args.broadcasterUserId);
    const key = `${spec.type}:${spec.version}:${conditionKey(condition)}`;
    const owned = owners.get(key) || [];
    const keeper = owned.find((row) => twitchSubscriptionIsUsable(row, args.callbackUrl));
    const stale = owned.filter((row) => row !== keeper && row?.id);
    if (keeper) {
      // Tidy-up beside a subscription that already works: a leftover row on a
      // retired callback would double every alert that callback still reaches.
      // A provider hiccup here must not fail a healthy connection, so a failed
      // delete is left for the next reconcile.
      removed.push(...await releaseTwitchSlot(args, stale, true));
      continue;
    }
    // A slot held by a failed verification, an exhausted delivery budget or a
    // retired callback has to be released before the replacement can be created.
    removed.push(...await releaseTwitchSlot(args, stale, false));
    created.push(...await createTwitchSubscription(args, spec, condition));
  }
  return { existing, created, removed };
}

/** @param {TwitchReconcileArgs} args @param {{type:string,version:string}} spec @param {Record<string,any>} condition */
async function createTwitchSubscription(args, spec, condition) {
  try {
    return await postTwitchSubscription(args, spec, condition);
  } catch (err) {
    if (Number(/** @type {any} */ (err)?.status) !== 409) throw err;
    // A row the reconcile never saw still owns this slot — a concurrent
    // reconnect can win the race, and the listing above is filtered to one
    // broadcaster. Release the real owner and try once more instead of parking
    // the connection on "needs retry" until someone reconciles Twitch by hand.
    const released = await releaseTwitchConflict(args, spec, condition, err);
    if (!released) {
      throw new PlatformOauthError(
        "twitch_eventsub_conflict",
        `Twitch reports an existing ${spec.type} subscription that could not be replaced`
        + ` (${safeMessage(err)})`,
        409,
      );
    }
    return await postTwitchSubscription(args, spec, condition);
  }
}

/** @param {TwitchReconcileArgs} args @param {{type:string,version:string}} spec @param {Record<string,any>} condition */
async function postTwitchSubscription(args, spec, condition) {
  const response = await fetchJson(
    args.fetchImpl || fetch,
    "https://api.twitch.tv/helix/eventsub/subscriptions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.appAccessToken}`,
        "Client-Id": args.clientId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: spec.type,
        version: spec.version,
        condition,
        transport: {
          method: "webhook",
          callback: args.callbackUrl,
          secret: args.webhookSecret,
        },
      }),
    },
    "twitch_eventsub_create",
  );
  const rows = Array.isArray(response.data) ? response.data : [];
  if (!rows.some((/** @type {any} */ row) => twitchSubscriptionIsActive(row))) {
    throw new PlatformOauthError(
      "twitch_eventsub_create",
      `Twitch did not confirm the ${spec.type} subscription`,
    );
  }
  return rows;
}

/**
 * Deletes the subscriptions still holding a slot. `tolerant` marks opportunistic
 * cleanup that must not break an otherwise healthy reconcile.
 * @param {TwitchReconcileArgs} args
 * @param {Record<string,any>[]} rows
 * @param {boolean} tolerant
 */
async function releaseTwitchSlot(args, rows, tolerant) {
  const removed = [];
  for (const row of rows) {
    try {
      if (await deleteTwitchSubscription(args, String(row.id))) removed.push(row);
    } catch (err) {
      if (!tolerant) throw err;
    }
  }
  return removed;
}

/**
 * Finds and deletes whatever Twitch says already occupies a slot. Twitch names
 * the conflicting id in the 409 body; when it does not, a type-filtered listing
 * locates the owner by matching its condition.
 * @param {TwitchReconcileArgs} args
 * @param {{type:string,version:string}} spec
 * @param {Record<string,any>} condition
 * @param {unknown} err
 */
async function releaseTwitchConflict(args, spec, condition, err) {
  const named = TWITCH_CONFLICT_ID_PATTERN.exec(safeMessage(err));
  if (named && await deleteTwitchSubscription(args, named[1])) return true;
  const key = `${spec.type}:${spec.version}:${conditionKey(condition)}`;
  const rows = await listTwitchSubscriptions({ ...args, broadcasterUserId: "", type: spec.type });
  let released = false;
  for (const row of rows) {
    if (twitchSubscriptionKey(row) !== key || !row?.id) continue;
    if (await deleteTwitchSubscription(args, String(row.id))) released = true;
  }
  return released;
}

/** @param {TwitchReconcileArgs} args @param {string} subscriptionId */
async function deleteTwitchSubscription(args, subscriptionId) {
  if (!subscriptionId) return false;
  const url = new URL("https://api.twitch.tv/helix/eventsub/subscriptions");
  url.searchParams.set("id", subscriptionId);
  try {
    await fetchNoContent(
      args.fetchImpl || fetch,
      url.toString(),
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${args.appAccessToken}`,
          "Client-Id": args.clientId,
        },
      },
      "twitch_eventsub_delete",
    );
    return true;
  } catch (deleteErr) {
    // Already gone is the outcome this call wanted, but it frees no slot that
    // was not free before, so the caller must not treat it as progress.
    if (Number(/** @type {any} */ (deleteErr)?.status) === 404) return false;
    throw deleteErr;
  }
}

/** @param {{appAccessToken:string,clientId:string,broadcasterUserId?:string,type?:string,fetchImpl?:typeof fetch}} args */
async function listTwitchSubscriptions(args) {
  const rows = [];
  let cursor = "";
  for (let page = 0; page < 100; page += 1) {
    const url = new URL("https://api.twitch.tv/helix/eventsub/subscriptions");
    // EventSub accepts one filter per call. The user_id condition filter avoids
    // scanning every customer subscription owned by the app as the installation
    // grows; the type filter is the bounded way to locate a conflicting row that
    // the broadcaster-scoped listing did not return.
    if (args.type) {
      url.searchParams.set("type", args.type);
    } else if (args.broadcasterUserId) {
      url.searchParams.set("user_id", args.broadcasterUserId);
    }
    if (cursor) url.searchParams.set("after", cursor);
    const json = await fetchJson(
      args.fetchImpl || fetch,
      url.toString(),
      {
        headers: {
          Authorization: `Bearer ${args.appAccessToken}`,
          "Client-Id": args.clientId,
        },
      },
      "twitch_eventsub_list",
    );
    rows.push(...(Array.isArray(json.data) ? json.data : []));
    cursor = String(json.pagination?.cursor || "");
    if (!cursor) break;
  }
  if (cursor) {
    throw new PlatformOauthError(
      "twitch_eventsub_list",
      "Twitch returned more EventSub pages than could be reconciled safely",
    );
  }
  return rows;
}

/** @param {Record<string, any>} row */
function twitchSubscriptionKey(row) {
  return `${String(row?.type || "")}:${String(row?.version || "")}:${conditionKey(row?.condition || {})}`;
}

/** @param {Record<string, any>} row */
function twitchSubscriptionIsActive(row) {
  return row?.status === "enabled"
    || row?.status === "webhook_callback_verification_pending";
}

/** @param {Record<string, any>} row @param {string} callbackUrl */
function twitchSubscriptionIsUsable(row, callbackUrl) {
  return twitchSubscriptionIsActive(row)
    && row?.transport?.method === "webhook"
    && row?.transport?.callback === callbackUrl;
}

/** @param {Record<string, any>} condition */
function conditionKey(condition) {
  return Object.entries(condition || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

module.exports = {
  TWITCH_EVENT_TYPES,
  reconcileTwitchEventSubscriptions,
  listTwitchSubscriptions,
  deleteTwitchSubscription,
  conditionKey,
};
