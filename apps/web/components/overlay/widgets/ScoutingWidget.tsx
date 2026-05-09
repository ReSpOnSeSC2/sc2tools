"use client";

import type {
  LiveGameEnvelope,
  LiveGameEnvelopeProfile,
  LiveGamePayload,
} from "../types";
import { Dim, WidgetShell } from "../WidgetShell";

/**
 * Scouting Report card — visual rebuild matching the legacy SPA's
 * `scouting.html`. The card is the streamer's pre-game dossier on the
 * current opponent and shows, in order:
 *
 *   1. Header: large opponent name + small W-L H2H record / win-rate.
 *   2. Familiar / Rival label (gold) — only when this is a repeat
 *      opponent (`rival` populated by the cloud).
 *   3. "LAST GAMES" list — newest-first rows of (result-chip, length,
 *      map, YOU build, OPP build) for this matchup. Driven by the new
 *      cloud-derived `live.recentGames` field.
 *   4. Optional "YOUR BEST ANSWER" + "CHEESE" rows (kept compact for
 *      the bottom of the card so the LAST GAMES list dominates).
 *
 * Sized 600px wide on the bottom-center slot — matches the screenshot
 * the streamer uses on stream and leaves the top of the screen free for
 * the OBS scene's main UI.
 *
 * Two payload sources, in priority order:
 *
 *   1. ``live`` (post-game ``LiveGamePayload``) — full LAST GAMES list,
 *      best-answer, cheese probability, head-to-head. Authoritative
 *      whenever it's set.
 *   2. ``liveGame`` (pre-game ``LiveGameEnvelope``) — opponent name,
 *      race, optional Pulse profile (MMR, league). Used to render a
 *      reduced-fidelity scouting card from the loading screen onward
 *      so the streamer's overlay doesn't sit blank pre-replay.
 *
 * The post-game payload wins by design — it carries strictly more
 * data than the live envelope. When only the live envelope is present
 * we render the trimmed pre-game variant (no LAST GAMES, no best-
 * answer; just the opponent's identity and basic Pulse info).
 */
export function ScoutingWidget({
  live,
  liveGame,
}: {
  live: LiveGamePayload | null;
  liveGame?: LiveGameEnvelope | null;
}) {
  if (!live) {
    return <ScoutingPreGameCard liveGame={liveGame ?? null} />;
  }

  const wins = live.headToHead?.wins ?? 0;
  const losses = live.headToHead?.losses ?? 0;
  const totalH2H = wins + losses;
  const winRatePct =
    totalH2H > 0 ? Math.round((wins / totalH2H) * 100) : null;

  const rivalNote = formatRival(live);
  const recentGames = (live.recentGames || []).slice(0, 5);
  const bestAnswer = live.bestAnswer || null;
  const cheeseHigh =
    typeof live.cheeseProbability === "number" && live.cheeseProbability >= 0.4;

  const hasAnyContent =
    Boolean(live.oppName)
    || totalH2H > 0
    || recentGames.length > 0
    || bestAnswer != null
    || cheeseHigh
    || rivalNote != null;
  if (!hasAnyContent) return null;

  return (
    <WidgetShell slot="bottom-center" accent="cyan" halo visible width={600}>
      {/* Header — large opponent name with the H2H record pinned right. */}
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 16,
          marginBottom: 4,
        }}
      >
        <span
          style={{
            fontSize: 36,
            fontWeight: 800,
            letterSpacing: "-0.02em",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
          }}
        >
          {live.oppName || "Unknown opponent"}
        </span>
        <span
          style={{
            fontSize: 14,
            opacity: 0.85,
            fontVariantNumeric: "tabular-nums",
            flexShrink: 0,
          }}
        >
          {totalH2H > 0
            ? `${wins}W-${losses}L${winRatePct !== null ? ` ${winRatePct}%` : ""}`
            : "first meeting"}
        </span>
      </div>

      {rivalNote ? (
        <div
          style={{
            fontSize: 22,
            fontWeight: 800,
            color: "#e6b450",
            letterSpacing: "0.02em",
            marginTop: 6,
            marginBottom: 10,
          }}
        >
          {rivalNote}
        </div>
      ) : null}

      {recentGames.length > 0 ? (
        <div style={{ marginTop: rivalNote ? 0 : 10 }}>
          <div
            style={{
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: 1.5,
              opacity: 0.55,
              marginBottom: 6,
            }}
          >
            LAST GAMES
          </div>
          <div
            style={{ display: "flex", flexDirection: "column", gap: 6 }}
          >
            {recentGames.map((g, i) => (
              <RecentGameRow key={`${g.date || ""}-${i}`} game={g} />
            ))}
          </div>
        </div>
      ) : null}

      {bestAnswer ? (
        <FooterRow label="YOUR BEST ANSWER">
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {bestAnswer.build}
          </span>
          <span
            style={{
              fontVariantNumeric: "tabular-nums",
              fontWeight: 700,
              color: "#3ec07a",
              flexShrink: 0,
            }}
          >
            {Math.round((bestAnswer.winRate || 0) * 100)}%
          </span>
        </FooterRow>
      ) : null}

      {cheeseHigh ? (
        <FooterRow label="CHEESE">
          <span style={{ color: "#d16ba5", fontWeight: 700 }}>
            scout natural early — {Math.round((live.cheeseProbability || 0) * 100)}% likely
          </span>
        </FooterRow>
      ) : null}
    </WidgetShell>
  );
}

function RecentGameRow({
  game,
}: {
  game: NonNullable<LiveGamePayload["recentGames"]>[number];
}) {
  const isWin = game.result === "Win";
  const chipBg = isWin
    ? "#3ec07a"
    : game.result === "Loss"
      ? "#ff6b6b"
      : "rgba(255,255,255,0.18)";
  const chipFg = isWin ? "#06241B" : game.result === "Loss" ? "#2A0708" : "#e6e8ee";
  return (
    <div
      style={{
        background: "rgba(255,255,255,0.04)",
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)",
        borderRadius: 6,
        padding: "6px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 2,
        minWidth: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          fontSize: 13,
        }}
      >
        <span
          aria-label={game.result}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            minWidth: 22,
            padding: "1px 6px",
            borderRadius: 4,
            fontSize: 12,
            fontWeight: 800,
            background: chipBg,
            color: chipFg,
          }}
        >
          {game.result === "Win" ? "W" : game.result === "Loss" ? "L" : "T"}
        </span>
        <span
          style={{
            fontVariantNumeric: "tabular-nums",
            fontWeight: 700,
          }}
        >
          {game.lengthText || "—"}
        </span>
        {game.map ? (
          <span
            style={{
              marginLeft: "auto",
              opacity: 0.7,
              fontSize: 12,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              minWidth: 0,
            }}
          >
            {game.map}
          </span>
        ) : null}
      </div>
      <BuildLine side="YOU" build={game.myBuild} sideColor="#3ec0c7" />
      <BuildLine side="OPP" build={game.oppBuild} sideColor="#e6b450" />
    </div>
  );
}

function BuildLine({
  side,
  sideColor,
  build,
}: {
  side: string;
  sideColor: string;
  build?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 8,
        fontSize: 12.5,
        lineHeight: 1.35,
        minWidth: 0,
      }}
    >
      <span
        style={{
          flex: "0 0 28px",
          fontSize: 10,
          letterSpacing: 1.2,
          fontWeight: 800,
          color: sideColor,
          textTransform: "uppercase",
        }}
      >
        {side}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {build || "(unclassified)"}
      </span>
    </div>
  );
}

function FooterRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        marginTop: 8,
        fontSize: 13,
      }}
    >
      <Dim>
        <span style={{ minWidth: 130, display: "inline-block" }}>{label}</span>
      </Dim>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Pre-game scouting card — fed by the desktop agent's
 * ``LiveGameEnvelope`` (Socket.io ``overlay:liveGame``). Carries less
 * data than the post-game card (no recent games, no best-answer; the
 * cloud's ``OverlayLiveService`` doesn't run pre-game) but enough that
 * the streamer's OBS scene shows the opponent's identity and Pulse
 * info from the loading screen onward.
 *
 * Rendering rules:
 *   * No envelope or ``idle``/``menu`` phase → render nothing.
 *   * Envelope without an ``opponent.name`` (very brief gap between
 *     MATCH_LOADING and the first /game response) → render a slim
 *     skeleton placeholder so the panel reserves its slot in OBS.
 *   * Envelope with name, no profile yet → name + race only.
 *   * Envelope with profile → name + race + MMR + league (when set).
 */
function ScoutingPreGameCard({
  liveGame,
}: {
  liveGame: LiveGameEnvelope | null;
}) {
  if (!liveGame) return null;
  if (liveGame.phase === "idle" || liveGame.phase === "menu") return null;
  const oppName = liveGame.opponent?.name || null;
  const oppRace = liveGame.opponent?.race || null;
  const profile = liveGame.opponent?.profile || null;
  const mmr =
    profile && typeof profile.mmr === "number" && profile.mmr > 0
      ? profile.mmr
      : null;
  const league = profile?.league || null;

  const headlineRight =
    mmr !== null
      ? `${mmr} MMR${league ? ` · ${league}` : ""}`
      : profile
        ? "Profile lookup unavailable"
        : "Looking up opponent…";

  return (
    <WidgetShell slot="bottom-center" accent="cyan" halo visible width={600}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 16,
          marginBottom: 4,
        }}
      >
        <span
          style={{
            fontSize: 36,
            fontWeight: 800,
            letterSpacing: "-0.02em",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
          }}
        >
          {oppName || "Opponent loading…"}
        </span>
        <span
          style={{
            fontSize: 14,
            opacity: 0.85,
            fontVariantNumeric: "tabular-nums",
            flexShrink: 0,
          }}
        >
          {headlineRight}
        </span>
      </div>
      <div
        style={{
          fontSize: 13,
          opacity: 0.7,
          marginTop: 4,
        }}
      >
        <Dim>
          {liveGame.phase === "match_ended"
            ? "match over — replay parsing"
            : oppRace
              ? `live · ${formatRaceLong(oppRace)}`
              : "live"}
        </Dim>
      </div>
      {showBestGuessHint(profile) ? (
        <div style={{ marginTop: 6, fontSize: 12, opacity: 0.55 }}>
          best guess
          {meaningfulAlternatives(profile).length > 0
            ? ` — also: ${meaningfulAlternatives(profile)
                .slice(0, 3)
                .join(", ")}`
            : null}
        </div>
      ) : null}
    </WidgetShell>
  );
}

/**
 * Strip placeholder entries (empty strings, `?`, `? (?)`) the agent's
 * Pulse stub surfaces when a name search returned nothing useful.
 * Live tests with a casual ladder opponent yielded
 * `alternatives: ["? (?)", "? (?)"]` which rendered as ugly noise on
 * the scouting card; filtering keeps the card honest about "no
 * disambiguation available" without showing literal question marks.
 */
function meaningfulAlternatives(
  profile: LiveGameEnvelopeProfile | null | undefined,
): string[] {
  if (!profile || !Array.isArray(profile.alternatives)) return [];
  return profile.alternatives
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter((s) => {
      if (!s) return false;
      if (s === "?") return false;
      // Drop the agent's empty "? (?)" placeholder shape — that's a
      // stub the bridge emits when Pulse returned no candidates with
      // resolvable identity, not a real disambiguation hint.
      if (/^\?\s*\(\s*\??\s*\)$/.test(s)) return false;
      return true;
    });
}

/**
 * The "best guess" hint only adds value when (a) the bridge actually
 * has lower-than-1 confidence in its primary pick, AND (b) there are
 * meaningful alternatives the streamer could compare against. A
 * confidence-only signal with no real alternatives is just noise.
 */
function showBestGuessHint(
  profile: LiveGameEnvelopeProfile | null | undefined,
): boolean {
  if (!profile) return false;
  if (profile.confidence === undefined || profile.confidence >= 1) return false;
  return meaningfulAlternatives(profile).length > 0;
}

function formatRaceLong(race: string): string {
  const r = race.trim().toLowerCase();
  if (r === "terran") return "Terran";
  if (r === "zerg") return "Zerg";
  if (r === "protoss") return "Protoss";
  if (r === "random") return "Random";
  return race;
}

function formatRival(live: LiveGamePayload): string | null {
  if (!live.rival) return null;
  const wins = live.rival.headToHead?.wins ?? 0;
  const losses = live.rival.headToHead?.losses ?? 0;
  const total = wins + losses;
  // Pre-screenshot: SPA showed "FAMILIAR - Last: <result>". We don't
  // carry per-rival "lastResult" through the cloud payload, so fall
  // back to the most recent result in `recentGames` when one exists.
  const lastFromRecent =
    live.recentGames && live.recentGames[0] ? live.recentGames[0].result : null;
  const tier = total >= 6 ? "RIVAL" : "FAMILIAR";
  if (lastFromRecent) return `${tier} - Last: ${lastFromRecent === "Win" ? "Victory" : lastFromRecent === "Loss" ? "Defeat" : "Tie"}`;
  return total > 0 ? tier : null;
}
