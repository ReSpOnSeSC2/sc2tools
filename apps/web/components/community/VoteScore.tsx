/** The same signed, explicitly named net score on every Community surface. */
export function VoteScore({ votes, size = "sm" }: { votes: number; size?: "sm" | "md" }) {
  const safe = Number.isFinite(votes) ? votes : 0;
  const score = safe > 0 ? `+${safe}` : safe < 0 ? `−${Math.abs(safe)}` : "0";
  return <span aria-label={`Net score ${score}`} className={`font-mono tabular-nums ${size === "md" ? "text-h3 font-semibold" : "text-caption"} ${safe > 0 ? "text-success" : safe < 0 ? "text-danger" : "text-text-dim"}`}>{score}</span>;
}
