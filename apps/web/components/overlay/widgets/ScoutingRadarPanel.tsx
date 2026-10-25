import { RadarChart } from "@/components/cards/RadarChart";
import type { LiveGamePayload } from "../types";

/** Compact replay evidence panel for the 600px broadcast scouting card. */
export function ScoutingRadarPanel({ payload }: { payload: LiveGamePayload }) {
  const card = payload.playerCard;
  // Older servers and the first unenriched tick have no profile yet. Keep
  // their established layout until evidence arrives instead of inventing it.
  if (!card || !Array.isArray(card.axes) || card.axes.length < 3) return null;

  const sampleSize = Number.isFinite(card.sampleSize)
    ? Math.max(0, Math.floor(card.sampleSize))
    : 0;
  const hasEvidence = sampleSize > 0 && card.axes.some(
    (axis) => typeof axis.value === "number" && Number.isFinite(axis.value),
  );
  const missingAxes = card.axes.some((axis) => axis.value == null || !Number.isFinite(axis.value));
  const partialCoverage = card.axes.some((axis) => axis.samples < sampleSize);
  const mmr = typeof payload.oppMmr === "number" && Number.isFinite(payload.oppMmr) && payload.oppMmr > 0
    ? Math.round(payload.oppMmr)
    : null;
  const race = payload.oppRace?.trim();
  const color = race?.toLowerCase().startsWith("z")
    ? "#c4a1ff"
    : race?.toLowerCase().startsWith("t")
      ? "#ff8585"
      : "#7cdaef";

  return (
    <div
      data-testid="scouting-radar-panel"
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) 245px",
        alignItems: "center",
        gap: 12,
        padding: "8px 0 10px",
        marginBottom: 10,
        borderBottom: "1px solid rgba(255,255,255,0.1)",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div
          style={{ color, fontSize: 11, fontWeight: 800, letterSpacing: 1.45 }}
        >
          OBSERVED TENDENCIES
        </div>
        {race ? (
          <div style={{ marginTop: 7, fontSize: 20, fontWeight: 750 }}>
            {race}
          </div>
        ) : null}
        {mmr !== null ? (
          <div style={{ marginTop: 4, fontSize: 13, fontVariantNumeric: "tabular-nums", color }}>
            {mmr} MMR
          </div>
        ) : null}
        <div
          style={{ marginTop: 6, fontSize: 13, lineHeight: 1.45, color: "#e6e8ee" }}
        >
          {sampleSize > 0
            ? `${card.sampled ? "Latest " : "Based on "}${sampleSize} replay${sampleSize === 1 ? "" : "s"}`
            : "No replay history yet"}
        </div>
        {payload.favOpening?.name ? (
          <div style={{ marginTop: 12, minWidth: 0 }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.1, opacity: 0.6 }}>
              USUAL OPENING
            </div>
            <div
              style={{ marginTop: 3, fontSize: 14, fontWeight: 650, overflowWrap: "anywhere" }}
            >
              {payload.favOpening.name}
            </div>
          </div>
        ) : null}
        <div
          style={{ marginTop: 10, fontSize: 11, lineHeight: 1.45, color: "#aeb9ca" }}
        >
          {hasEvidence
            ? `Share of observed games${missingAxes ? " · missing data shown as —" : partialCoverage ? " · coverage varies by metric" : ""}`
            : "Tendencies appear as replay evidence becomes available."}
        </div>
      </div>
      <RadarChart
        label={`${payload.oppName || "Opponent"} replay tendencies`}
        axes={card.axes}
        color={color}
        compact
      />
    </div>
  );
}
