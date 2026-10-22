"use client";

import { useCallback } from "react";
import { useToastOptional } from "@/components/ui/Toast";
import {
  INELIGIBLE_REASON_COPY,
  NEW_BUILD_CHECKED_IN,
  NEW_BUILD_NOT_CHECKED_IN,
  newBuildCheckinFailure,
  type GameIntentState,
} from "@/lib/buildIntent";
import type { NewBuildSaved } from "./CheckInNewBuild";
import type { CheckInActions, CheckInCopy } from "./useCheckInActions";

export interface NewBuildCheckInOutcome {
  state: GameIntentState | null;
  /** API error code on failure; "not_eligible" when the game can't take any check-in. */
  errorCode: string | null;
}

/** The parts of a game's check-in state that decide what a new build can do. */
export type NewBuildGame = Pick<GameIntentState, "eligible" | "ineligibleReason" | "opponent">;

/**
 * After "Add new build" saves a build, make it the game's check-in for
 * that side right away: your own build is confirmed (`custom:<slug>`),
 * the opponent's goes in as the corrected opponent build. The build stays
 * in the library either way; when the game can't take it the player is
 * told why ("Saved to your library, but…").
 */
export function useNewBuildCheckIn(actions: CheckInActions) {
  const toastContext = useToastOptional();
  const { confirm, setOpponent } = actions;

  return useCallback(
    async (
      saved: NewBuildSaved,
      game: NewBuildGame | null | undefined,
      notes?: string,
    ): Promise<NewBuildCheckInOutcome> => {
      // Only a game known to refuse is skipped; anything else is the
      // server's call (an unknown state may be stale).
      if (game && (!game.eligible || (saved.side === "opponent" && game.opponent === null))) {
        const reason = game.eligible
          ? "This game has no known matchup, so it has no opponent build to set."
          : game.ineligibleReason
            ? INELIGIBLE_REASON_COPY[game.ineligibleReason]
            : "This game can't take a check-in.";
        toastContext?.toast.error(NEW_BUILD_NOT_CHECKED_IN, { description: reason });
        return { state: null, errorCode: "not_eligible" };
      }
      const copy: CheckInCopy = {
        success: NEW_BUILD_CHECKED_IN,
        failure: (code, text) => {
          const failure = newBuildCheckinFailure(code, text, game?.ineligibleReason);
          return {
            title: failure.title,
            description: failure.reason,
            inline: `${failure.title}. ${failure.reason}`,
          };
        },
      };
      const outcome =
        saved.side === "you"
          ? await confirm(saved.key, saved.name, notes, { copy })
          : await setOpponent(saved.key, saved.name, notes, { copy });
      return { state: outcome.state, errorCode: outcome.errorCode };
    },
    [confirm, setOpponent, toastContext],
  );
}
