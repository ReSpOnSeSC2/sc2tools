// Shared formatting helpers — ported from
// reveal-sc2-opponent-main/stream-overlay-backend/public/analyzer/utils.

export function pct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${Math.round(v * 100)}%`;
}

export function pct1(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

export function fmtAgo(iso: string | number | Date | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const sec = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (sec < 60) return `${Math.round(sec)}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  if (sec < 604800) return `${Math.round(sec / 86400)}d ago`;
  return d.toLocaleDateString();
}

export function fmtDate(iso: string | number | Date | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

/**
 * Win-rate colour ramp. Severe scheme: deep red below 30%, deep green
 * above 65%, with a smooth red → amber → green gradient between so a
 * 50% bar never reads as "winning". Neutral grey when sample is tiny
 * (< 3 games) so a 1-0 day doesn't blare full green.
 */
export function wrColor(rate: number | null | undefined, games: number): string {
  if (rate == null || !Number.isFinite(rate) || games < 3) return "#9aa3b2";
  return wrRampHex(rate);
}

/**
 * Continuous win-rate → hex colour. Endpoints clamp at 30% / 65% so
 * differences inside the "interesting" middle band drive almost the
 * full colour range. Useful in chart cells / summary cards where the
 * caller doesn't want to think about thresholds.
 */
export function wrRampHex(rate: number): string {
  const [r, g, b] = wrRamp(rate);
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Continuous win-rate → RGB triple in [0, 255]. Two-stop gradient
 * through an amber midpoint at 47.5% so the transition never collapses
 * into mud. Exported so cell-style charts (calendar, heatmap) can
 * combine the colour with their own opacity for the volume signal.
 */
export function wrRamp(rate: number): [number, number, number] {
  const RED: [number, number, number] = [180, 35, 45];
  const AMBER: [number, number, number] = [220, 165, 50];
  const GREEN: [number, number, number] = [40, 145, 75];
  const t = clamp((rate - 0.3) / (0.65 - 0.3), 0, 1);
  if (t <= 0.5) {
    const k = t / 0.5;
    return [
      Math.round(RED[0] + (AMBER[0] - RED[0]) * k),
      Math.round(RED[1] + (AMBER[1] - RED[1]) * k),
      Math.round(RED[2] + (AMBER[2] - RED[2]) * k),
    ];
  }
  const k = (t - 0.5) / 0.5;
  return [
    Math.round(AMBER[0] + (GREEN[0] - AMBER[0]) * k),
    Math.round(AMBER[1] + (GREEN[1] - AMBER[1]) * k),
    Math.round(AMBER[2] + (GREEN[2] - AMBER[2]) * k),
  ];
}

function toHex(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
}

export function raceColour(race: string | null | undefined): string {
  const r = (race || "").charAt(0).toUpperCase();
  if (r === "T") return "#ff6b6b";
  if (r === "Z") return "#a78bfa";
  if (r === "P") return "#7c8cff";
  return "#9aa3b2";
}

export function fmtMmr(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return Math.round(v).toLocaleString();
}

export function fmtMinutes(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
