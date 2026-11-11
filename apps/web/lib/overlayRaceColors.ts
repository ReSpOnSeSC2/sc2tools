export const OVERLAY_RACE_COLORS = {
  T: "#ff6b6b",
  Z: "#a78bfa",
  P: "#7c8cff",
  R: "#96a4b0",
} as const;

export function overlayRaceColor(race?: string | null): string | undefined {
  const key = race?.trim().toLowerCase();
  switch (key) {
    case "t": case "terran": return OVERLAY_RACE_COLORS.T;
    case "z": case "zerg": return OVERLAY_RACE_COLORS.Z;
    case "p": case "protoss": return OVERLAY_RACE_COLORS.P;
    case "r": case "random": return OVERLAY_RACE_COLORS.R;
    default: return undefined;
  }
}
