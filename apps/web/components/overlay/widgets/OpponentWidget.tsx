"use client";

import type { LiveGameEnvelope, LiveGamePayload } from "../types";
import {
  Dim,
  RaceIcon,
  WidgetFooter,
  WidgetHeader,
  WidgetShell,
} from "../WidgetShell";

/**
 * Opponent identity widget — pre-game / in-game dossier.
 *
 * Two payload sources, in priority order:
 *
 *   1. ``live`` (post-game ``LiveGamePayload``) — authoritative once
 *      the replay parses ~30 s after the match ends. Carries the
 *      cloud-derived head-to-head, MMR, matchup label.
 *   2. ``liveGame`` (pre-game ``LiveGameEnvelope``) — emitted by the
 *      desktop agent the moment the SC2 loading screen lands and
 *      enriched with Pulse profile data ~150–500 ms later.
 *
 * The post-game payload wins whenever it's present so the streamer's
 * scene shows authoritative replay-derived data once the game ends.
 * The pre-game envelope fills the gap that previously left widgets
 * blank from queue-into-game until the replay parsed.
 *
 * Progressive rendering of the live envelope:
 *
 *   * ``match_loading`` with no ``opponent.profile`` yet → render
 *     opponent name + race; show "MMR loading…" in the slot the
 *     post-game widget would put MMR.
 *   * ``match_loading`` / ``match_started`` with profile → render
 *     opponent name + race + MMR. No H2H (the cloud doesn't push
 *     it through the live envelope; the post-game payload backfills
 *     it later).
 *   * ``match_ended`` and we still don't have a post-game payload —
 *     keep showing the live envelope so the streamer's panel doesn't
 *     blank between game-end and replay-parse.
 */
export function OpponentWidget({
  live,
  liveGame,
}: {
  live: LiveGamePayload | null;
  liveGame?: LiveGameEnvelope | null;
}) {
  if (live) {
    const wins = live.headToHead?.wins ?? 0;
    const losses = live.headToHead?.losses ?? 0;
    return (
      <WidgetShell
        slot="top-center"
        race={live.oppRace}
        halo
        visible
        width={480}
      >
        <WidgetHeader>
          <span
            style={{
              display: "inline-flex",
              gap: 10,
              alignItems: "center",
              minWidth: 0,
            }}
          >
            <RaceIcon race={live.oppRace} size={26} />
            <span
              style={{
                fontSize: 20,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {live.oppName || "Opponent"}
            </span>
          </span>
          <span
            style={{
              fontSize: 16,
              opacity: 0.85,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {typeof live.oppMmr === "number" ? `${live.oppMmr} MMR` : ""}
          </span>
        </WidgetHeader>
        <WidgetFooter>
          <Dim>
            {live.matchup || `${live.myRace || "?"}v${live.oppRace || "?"}`}
          </Dim>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {wins}-{losses} <Dim>head-to-head</Dim>
          </span>
        </WidgetFooter>
      </WidgetShell>
    );
  }

  // Live envelope path — render whatever the agent has so far.
  if (!liveGame) return null;
  if (liveGame.phase === "idle" || liveGame.phase === "menu") return null;

  const oppName = liveGame.opponent?.name || null;
  const oppRace = liveGame.opponent?.race || null;
  const profile = liveGame.opponent?.profile || null;
  const mmr =
    profile && typeof profile.mmr === "number" && profile.mmr > 0
      ? profile.mmr
      : null;

  // Empty / unknown opponent (e.g. agent reported MATCH_LOADING with no
  // game_state yet) — render the skeleton outline rather than blank so
  // the streamer sees the panel reserve its slot in OBS.
  const hasOpp = Boolean(oppName);
  const matchupLabel = oppRace ? `vs ${formatRaceShort(oppRace)}` : "Loading…";

  return (
    <WidgetShell
      slot="top-center"
      race={oppRace || undefined}
      halo
      visible
      width={480}
    >
      <WidgetHeader>
        <span
          style={{
            display: "inline-flex",
            gap: 10,
            alignItems: "center",
            minWidth: 0,
          }}
        >
          <RaceIcon race={oppRace || undefined} size={26} />
          <span
            style={{
              fontSize: 20,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {hasOpp ? oppName : "Opponent loading…"}
          </span>
        </span>
        <span
          style={{
            fontSize: 16,
            opacity: 0.85,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {mmr !== null
            ? `${mmr} MMR`
            : profile
              ? "MMR unavailable"
              : "MMR loading…"}
        </span>
      </WidgetHeader>
      <WidgetFooter>
        <Dim>{matchupLabel}</Dim>
        <span style={{ fontVariantNumeric: "tabular-nums" }}>
          {liveGame.phase === "match_ended" ? (
            <Dim>match over</Dim>
          ) : (
            <Dim>live</Dim>
          )}
        </span>
      </WidgetFooter>
    </WidgetShell>
  );
}

function formatRaceShort(race: string): string {
  const r = race.trim().toLowerCase();
  if (r === "terran") return "Terran";
  if (r === "zerg") return "Zerg";
  if (r === "protoss") return "Protoss";
  if (r === "random") return "Random";
  return race;
}
