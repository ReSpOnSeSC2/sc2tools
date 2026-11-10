/**
 * Typed GA4 event for a share card leaving the app (wrapper over `gaEvent`).
 *
 * Parameters are fixed enums ONLY: which card, how it was delivered and,
 * for an Arcade round, which built-in mode. Never names, ids, ratings,
 * results or any text from the card. `gaEvent` is a no-op until the
 * visitor consents to analytics.
 *
 * The event also states its own page, normalized the same way page views
 * are (lib/analytics/pageLocation). Left to itself gtag would attach the
 * browser's address, and a battle card is shared from /app/game/<gameId>,
 * where the id can contain the opponent's name.
 *
 * The parameter names are GA4's standard ones (`content_type`, `method`,
 * `content_id`, `page_location`).
 *
 * Example:
 *   trackCardShared({ card: "battle_card", method: "web_share" });
 *   trackCardShared({ card: "arcade_round", method: "download", modeId: "buildle" });
 */
import { gaEvent } from "@/lib/analytics/gtag";
import { analyticsPageLocation, isUntrackedPath } from "@/lib/analytics/pageLocation";

/** The share surfaces that produce a card. */
export type SharedCardKind = "arcade_round" | "season_recap" | "battle_card";

/** How a card actually left the app (see `deliverShareCard`). */
export type CardShareMethod =
  | "web_share"
  | "clipboard_image"
  | "clipboard_text"
  | "download";

/** Arcade mode ids are code constants such as "rivalry-ranker". */
const MODE_ID = /^[a-z][a-z0-9-]{1,39}$/;

/**
 * A card was delivered. Call it only after delivery succeeded, never for
 * a preview or a dismissed share sheet.
 *
 * `modeId` is sent only when it has the shape of a built-in mode id, so
 * nothing typed by a player can ride along.
 */
export function trackCardShared(params: {
  card: SharedCardKind;
  method: CardShareMethod;
  modeId?: string;
}): void {
  if (typeof window === "undefined") return;
  const { origin, pathname, search } = window.location;
  if (isUntrackedPath(pathname)) return;
  const event: Record<string, string> = {
    content_type: params.card,
    method: params.method,
    page_location: analyticsPageLocation(origin, pathname, search),
  };
  if (params.modeId && MODE_ID.test(params.modeId)) {
    event.content_id = params.modeId;
  }
  gaEvent("card_shared", event);
}
