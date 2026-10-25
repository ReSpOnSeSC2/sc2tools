import { apiCall } from "./clientApi";
import rules from "../../api/src/config/gameControls.json";

export type ReplayControlTarget = { gameId: string; map?: string | null; date?: string | null; excluded?: boolean; pendingDeletion?: boolean };
export type ReplayControlChange = { gameId: string; excluded?: boolean; deleted?: boolean };
export type ReplayControlAction = "hide" | "unhide" | "delete";
export const REPLAY_HIDE_REASONS = rules.reasons;
export const MAX_REPLAY_SELECTION = rules.maximumSelection;
export const deletionWord = (count: number) => count === 1 ? rules.deleteConfirmation : `DELETE ${count} GAMES`;

/** A delayed Clerk lookup cannot attach a new account's token to an old
 * account's action. Both cancellation and the deadline settle the browser
 * operation even if authentication or a response body never resolves. */
export async function applyReplayControl({ gameId, action, reason, getToken, allowed, controller }: {
  gameId: string; action: ReplayControlAction; reason?: string;
  getToken: () => Promise<string | null>; allowed: () => boolean; controller: AbortController;
}): Promise<ReplayControlChange> {
  if (!gameId || gameId.length > 200 || !["hide", "unhide", "delete"].includes(action)) throw new Error("Choose a valid replay action.");
  if (action === "hide" && !rules.reasons.some(value => value.value === reason)) throw new Error("Choose a reason for hiding the game.");
  const check = () => {
    if (!allowed()) throw new DOMException("Account or replay selection changed", "AbortError");
    controller.signal.throwIfAborted();
  };
  check();
  const guardedToken = async () => { check(); const token = await getToken(); check(); if (!token) throw new Error("Sign in again before changing a replay."); return token; };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(controller.signal.reason || new DOMException("Cancelled", "AbortError"));
    controller.signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => controller.abort(new DOMException("This request took too long. Retry, or check pending deletions in Hidden games.", "TimeoutError")), 30_000);
  });
  try {
    const result = await Promise.race([apiCall<ReplayControlChange>(guardedToken, `/v1/games/${encodeURIComponent(gameId)}`, {
      method: action === "delete" ? "DELETE" : "PATCH", signal: controller.signal,
      body: JSON.stringify(action === "delete" ? { confirmation: rules.deleteConfirmation } : { excluded: action === "hide", ...(action === "hide" ? { reason } : {}) }),
    }), cancelled]);
    check(); return result;
  } finally { clearTimeout(timer); controller.signal.removeEventListener("abort", onAbort); }
}
