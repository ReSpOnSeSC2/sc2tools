/** A confirmed identity is distinct from an unverified SC2Pulse reveal. */
export function RevealedChip({ name, displayedName, confirmed = false, size = "sm" }: {
  name?: string | null;
  displayedName?: string;
  confirmed?: boolean;
  size?: "sm" | "md";
}) {
  const tag = name?.trim();
  if (!tag || tag === displayedName?.trim()) return null;
  return <span title={confirmed ? "Confirmed by an admin" : "Revealed on SC2Pulse"} className={`inline-flex min-w-0 shrink-0 items-center rounded-full bg-accent-cyan/15 px-2 py-0.5 font-semibold text-accent-cyan ${size === "md" ? "text-caption" : "text-micro"}`}><span className="max-w-[14rem] truncate">{confirmed ? "Confirmed as" : "Revealed as"} {tag}</span></span>;
}
