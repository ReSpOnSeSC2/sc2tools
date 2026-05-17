"use client";

import { Icon } from "@/components/ui/Icon";
import type { PerGameScoutingEnvelope } from "../types";
import { Dim } from "../WidgetShell";

/**
 * "Last 5 games" block on the scouting widget — newest-first rows of
 * (header + opponent build-order strip + composition snapshots per
 * phase reached + optional strategy footer) for the user's most
 * recent games against the current opponent.
 *
 * Real data only: every value comes from the cloud's per-game
 * scouting envelope, which itself comes from a stored
 * macroBreakdown + oppBuildLog. The component refuses to fabricate
 * compositions or build-order events — if the per-game envelope
 * flags ``unit_timeline_missing`` / ``opp_buildlog_missing`` /
 * ``opp_bases_synthesized``, the corresponding section renders a
 * dimmed "unavailable" badge instead of inventing a fallback.
 *
 * The legacy median-based ``OpponentPhases`` strip is intentionally
 * NOT used here — see ScoutingWidget.tsx for the removal note.
 */

const PHASE_BUCKETS: Array<{
  label: string;
  phases: Array<keyof PerGameScoutingEnvelope["oppCompositionByPhase"]>;
}> = [
  { label: "Early/Mid", phases: ["earlyMid"] },
  { label: "Mid", phases: ["mid"] },
  { label: "Mid/Late+", phases: ["midLate", "late"] },
];

const END_REASON_LABEL: Record<PerGameScoutingEnvelope["endReason"], string> = {
  early_allin: "All-in",
  early_loss: "Early loss",
  early_win: "Early win",
  midgame_engagement: "Mid-game engagement",
  macro_game: "Macro game",
  unknown: "Outcome unclear",
};

const END_PHASE_LABEL: Record<PerGameScoutingEnvelope["endPhase"], string> = {
  early: "Early",
  earlyMid: "Early/Mid",
  mid: "Mid",
  midLate: "Mid/Late",
  late: "Late",
};

const BUILD_ORDER_GROUP_GAP_SEC = 10;

export function ScoutingLastGames({
  envelopes,
}: {
  envelopes: PerGameScoutingEnvelope[];
}) {
  if (envelopes.length === 0) return null;
  return (
    <div
      style={{ marginTop: 14 }}
      data-testid="scouting-last-games"
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: 1.5,
          opacity: 0.55,
          marginBottom: 6,
        }}
      >
        <span>LAST 5 GAMES — REAL TIMELINES</span>
        {envelopes.length < 5 ? (
          <span style={{ fontSize: 11, opacity: 0.8 }}>
            {envelopes.length} of 5
          </span>
        ) : null}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {envelopes.map((env) => (
          <LastGameRow key={env.gameId || env.date} envelope={env} />
        ))}
      </div>
    </div>
  );
}

function LastGameRow({ envelope }: { envelope: PerGameScoutingEnvelope }) {
  const compositionUnavailable = envelope.flags.includes("unit_timeline_missing");
  const buildOrderUnavailable = envelope.flags.includes("opp_buildlog_missing");
  return (
    <div
      style={{
        background: "rgba(255,255,255,0.04)",
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)",
        borderRadius: 6,
        padding: "8px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
      data-testid="scouting-last-game"
      data-game-id={envelope.gameId}
    >
      <LastGameHeader envelope={envelope} />
      {buildOrderUnavailable ? (
        <div
          style={{ fontSize: 11.5, opacity: 0.5 }}
          data-testid="scouting-build-order-unavailable"
        >
          Opponent build log not extracted for this game.
        </div>
      ) : (
        <BuildOrderStrip events={envelope.oppBuildOrder} />
      )}
      {compositionUnavailable ? (
        <div
          style={{ fontSize: 11.5, opacity: 0.5 }}
          data-testid="scouting-composition-unavailable"
        >
          Composition data unavailable for this game.
        </div>
      ) : (
        <CompositionStrip composition={envelope.oppCompositionByPhase} />
      )}
      {envelope.oppStrategy ? (
        <div style={{ fontSize: 11.5, opacity: 0.7 }}>
          <Dim>
            <span>Labelled strategy:</span>
          </Dim>{" "}
          {envelope.oppStrategy}
        </div>
      ) : null}
    </div>
  );
}

function LastGameHeader({ envelope }: { envelope: PerGameScoutingEnvelope }) {
  const isWin = envelope.result === "win";
  const isLoss = envelope.result === "loss";
  const chipBg = isWin ? "#3ec07a" : isLoss ? "#ff6b6b" : "rgba(255,255,255,0.18)";
  const chipFg = isWin ? "#06241B" : isLoss ? "#2A0708" : "#e6e8ee";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        fontSize: 13,
      }}
    >
      <span
        aria-label={envelope.result}
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
        {isWin ? "W" : isLoss ? "L" : "T"}
      </span>
      <span
        style={{ fontVariantNumeric: "tabular-nums", fontWeight: 700 }}
      >
        {formatDuration(envelope.durationSec)}
      </span>
      {envelope.map ? (
        <span style={{ opacity: 0.7, fontSize: 12 }}>{envelope.map}</span>
      ) : null}
      <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
        <Pill kind="phase">{END_PHASE_LABEL[envelope.endPhase]}</Pill>
        <Pill kind="reason">{END_REASON_LABEL[envelope.endReason]}</Pill>
      </span>
    </div>
  );
}

function Pill({
  children,
  kind,
}: {
  children: React.ReactNode;
  kind: "phase" | "reason";
}) {
  const bg = kind === "phase" ? "rgba(62,192,199,0.18)" : "rgba(230,180,80,0.18)";
  const fg = kind === "phase" ? "#7fdde2" : "#e6b450";
  return (
    <span
      style={{
        background: bg,
        color: fg,
        padding: "1px 7px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 0.3,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

function BuildOrderStrip({
  events,
}: {
  events: PerGameScoutingEnvelope["oppBuildOrder"];
}) {
  if (events.length === 0) {
    return (
      <div style={{ fontSize: 11.5, opacity: 0.5 }}>
        No build-order events recorded.
      </div>
    );
  }
  // Group events that fire within BUILD_ORDER_GROUP_GAP_SEC of each
  // other so the row doesn't smear into overlapping icons.
  const groups: Array<{ time: number; events: typeof events }> = [];
  for (const ev of events) {
    const last = groups[groups.length - 1];
    if (last && ev.time - last.time <= BUILD_ORDER_GROUP_GAP_SEC) {
      last.events.push(ev);
    } else {
      groups.push({ time: ev.time, events: [ev] });
    }
  }
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 8,
      }}
      data-testid="scouting-build-order-strip"
    >
      {groups.map((g) => (
        <div
          key={g.time}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 2,
            padding: "2px 4px",
            borderRadius: 4,
            background: "rgba(255,255,255,0.03)",
          }}
        >
          {g.events.map((ev) => (
            <Icon
              key={`${ev.name}-${ev.time}`}
              name={ev.name}
              kind={iconKindForCategory(ev.category)}
              size={20}
              alt={ev.name}
            />
          ))}
          <span
            style={{
              marginLeft: 4,
              fontSize: 11,
              fontVariantNumeric: "tabular-nums",
              opacity: 0.75,
            }}
          >
            {formatDuration(g.time)}
          </span>
        </div>
      ))}
    </div>
  );
}

function iconKindForCategory(
  category: PerGameScoutingEnvelope["oppBuildOrder"][number]["category"],
): "building" | "unit" | "upgrade" {
  return category;
}

function CompositionStrip({
  composition,
}: {
  composition: PerGameScoutingEnvelope["oppCompositionByPhase"];
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr 1fr",
        gap: 6,
      }}
      data-testid="scouting-composition-strip"
    >
      {PHASE_BUCKETS.map((bucket) => {
        const merged = mergeBucket(bucket.phases, composition);
        return (
          <CompositionCard
            key={bucket.label}
            label={bucket.label}
            reached={merged.reached}
            units={merged.units}
          />
        );
      })}
    </div>
  );
}

function mergeBucket(
  phases: Array<keyof PerGameScoutingEnvelope["oppCompositionByPhase"]>,
  composition: PerGameScoutingEnvelope["oppCompositionByPhase"],
): {
  reached: boolean;
  units: Array<{ token: string; count: number }>;
} {
  let reached = false;
  /** @type {Map<string, number>} */
  const tokens = new Map<string, number>();
  for (const p of phases) {
    const slice = composition[p];
    if (!slice) continue;
    if (slice.reached) reached = true;
    for (const u of slice.units) {
      const prev = tokens.get(u.token) || 0;
      if (u.count > prev) tokens.set(u.token, u.count);
    }
  }
  const units = Array.from(tokens.entries())
    .map(([token, count]) => ({ token, count }))
    .sort((a, b) => {
      if (a.count !== b.count) return b.count - a.count;
      if (a.token < b.token) return -1;
      if (a.token > b.token) return 1;
      return 0;
    })
    .slice(0, 5);
  return { reached, units };
}

function CompositionCard({
  label,
  reached,
  units,
}: {
  label: string;
  reached: boolean;
  units: Array<{ token: string; count: number }>;
}) {
  return (
    <div
      style={{
        padding: "5px 6px",
        borderRadius: 5,
        background: "rgba(255,255,255,0.025)",
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.04)",
        minHeight: 60,
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
      data-testid="scouting-composition-card"
      data-phase={label}
    >
      <div
        style={{
          fontSize: 10,
          letterSpacing: 1.1,
          fontWeight: 700,
          opacity: 0.55,
        }}
      >
        {label}
      </div>
      {reached ? (
        units.length === 0 ? (
          <div style={{ fontSize: 11, opacity: 0.45 }}>—</div>
        ) : (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              flexWrap: "wrap",
              gap: 4,
            }}
          >
            {units.map((u) => (
              <span
                key={u.token}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 2,
                  fontSize: 11,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                <Icon name={u.token} kind="unit" size={16} alt={u.token} />
                <span style={{ opacity: 0.9 }}>{u.count}</span>
              </span>
            ))}
          </div>
        )
      ) : (
        <div
          style={{ fontSize: 11, opacity: 0.45 }}
          data-testid="scouting-composition-did-not-reach"
        >
          Did not reach
        </div>
      )}
    </div>
  );
}

function formatDuration(sec: number): string {
  const n = Math.max(0, Math.round(sec));
  const m = Math.floor(n / 60);
  const s = n - m * 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
