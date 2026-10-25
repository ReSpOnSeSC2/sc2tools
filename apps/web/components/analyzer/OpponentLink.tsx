"use client";

import Link from "next/link";
import Image from "next/image";
import { opponentProfileHref } from "@/lib/opponentNavigation";
import { raceColour } from "@/lib/format";

/** One navigable opponent identity, reusable in replay rows and the header. */
export function OpponentLink({ pulseId, name, race, className = "" }: {
  pulseId?: string | null; name: string; race?: string | null; className?: string;
}) {
  const content = <>{race ? <RaceChip race={race} /> : null}<span className="max-w-[18ch] truncate" title={name}>{name}</span></>;
  const classes = `inline-flex min-w-0 items-center gap-1 ${className}`;
  return pulseId?.trim() ? <Link href={opponentProfileHref({ pulseId })} className={`${classes} text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`} onClick={(event) => event.stopPropagation()}>{content}</Link> : <span className={classes}>{content}</span>;
}

export function RaceChip({ race }: { race: string }) {
  const full = ({ T: "Terran", P: "Protoss", Z: "Zerg", R: "Random" } as Record<string, string>)[race.trim().charAt(0).toUpperCase()];
  return full ? <span className="inline-flex items-center" style={{ color: raceColour(race) }} role="img" aria-label={full}><Image src={`/icons/sc2/races/${full.toLowerCase()}.svg`} width={14} height={14} alt="" /></span> : null;
}
