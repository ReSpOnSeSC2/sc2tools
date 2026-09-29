/**
 * The Match timeline's selection rule, shared by every host of
 * ``ActiveArmyChart`` (the analyzer's ``MacroChartSection`` and the
 * /try page's ``OfflineMacroChart``) so the chart behaves the same
 * everywhere:
 *
 *   - hover previews a moment until a click or tap locks one;
 *   - the mouse leaving keeps the last moment and its read-out card;
 *   - a click or tap on the chart locks (or moves) the moment;
 *   - a click or tap anywhere off the chart closes the card and
 *     releases the lock, but keeps the moment, so the crosshair,
 *     read-out and roster stay put. Scrolling never counts as a tap.
 */

/**
 * Single hover dispatch — the chart emits these to its host. Mouse
 * moves emit "hover" and the host keeps the last value on "leave";
 * clicks, taps and sideways touch drags lock the selection ("tap"); a
 * tap off the chart emits "dismiss". Scrolling never emits anything.
 */
export type HoverEvent =
  | { type: "hover"; time: number }
  | { type: "tap"; time: number }
  | { type: "leave" }
  | { type: "dismiss" };

/** The inspected moment the chart and roster share. */
export interface HoverState {
  /** Game-time second being inspected, or null for "game end". */
  time: number | null;
  /** A click or tap locked ``time``; hover previews wait until released. */
  sticky: boolean;
  /** The dark read-out card is showing (a tap off the chart closes it). */
  card: boolean;
}

export const INITIAL_HOVER: HoverState = { time: null, sticky: false, card: false };

/**
 * Next selection after ``event``.
 *
 * Example:
 *   nextHover({ time: 30, sticky: true, card: true }, { type: "hover", time: 90 });
 *   // -> unchanged: a locked moment ignores hover previews
 */
export function nextHover(prev: HoverState, event: HoverEvent): HoverState {
  switch (event.type) {
    case "tap":
      return { time: event.time, sticky: true, card: true };
    case "hover":
      return prev.sticky ? prev : { time: event.time, sticky: false, card: true };
    case "dismiss":
      return prev.card || prev.sticky ? { ...prev, sticky: false, card: false } : prev;
    default:
      return prev;
  }
}
