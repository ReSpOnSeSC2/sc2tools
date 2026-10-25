/** MM:SS (or H:MM:SS past the hour), shared by controls and scene widgets. */
export function formatCountdown(remainMs: number): string {
  const totalSec = Math.ceil(Math.max(0, remainMs) / 1000);
  const h = Math.floor(totalSec / 3600), m = Math.floor((totalSec % 3600) / 60), s = totalSec % 60;
  const mm = String(m).padStart(2, "0"), ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
