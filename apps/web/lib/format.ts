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
 * Win-rate colour ramp. Mirrors `wrColor` in the analyzer SPA — green
 * above 55%, amber 45-55%, red below 45%, neutral when sample is tiny.
 */
export function wrColor(rate: number | null | undefined, games: number): string {
  if (rate == null || !Number.isFinite(rate) || games < 3) return "#9aa3b2";
  if (rate >= 0.6) return "#3ec07a";
  if (rate >= 0.55) return "#7ed957";
  if (rate >= 0.45) return "#e6b450";
  if (rate >= 0.4) return "#ff9d6c";
  return "#ff6b6b";
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
