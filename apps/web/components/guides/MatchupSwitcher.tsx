import Link from "next/link";
import Image from "next/image";
import { getIconPath } from "@/lib/sc2-icons";
import { guidePaths } from "./guideMetadata";
import { guideBandQueryString } from "@/lib/guides/format";
import type { GuideEra } from "@/lib/guides/types";
import { MatchupLabel } from "./MatchupLabel";

export function MatchupSwitcher({ current, era, counters = false }: { current: string; era: GuideEra; counters?: boolean }) {
  return <nav aria-label="Matchups" className="flex max-w-full gap-3 overflow-x-auto pb-1 sm:flex-wrap">
    {([['P', 'Protoss'], ['T', 'Terran'], ['Z', 'Zerg']] as const).map(([letter, race]) => <div key={letter} className="flex shrink-0 items-center gap-1.5" aria-label={race}>
      <RaceMark race={race} />
      {['P', 'T', 'Z'].map((opponent) => {
        const matchup = `${letter}v${opponent}`;
        const path = counters ? guidePaths.counters(matchup.toLowerCase()) : guidePaths.matchup(matchup.toLowerCase());
        return <Link key={matchup} href={`${path}${guideBandQueryString(null, era)}`} aria-current={current.toLowerCase() === matchup.toLowerCase() ? "page" : undefined}
          className="inline-flex min-h-9 shrink-0 items-center rounded-full border-2 border-border bg-bg-surface px-3 text-caption font-semibold aria-[current=page]:border-accent">
          <MatchupLabel matchup={matchup} />
        </Link>;
      })}
    </div>)}
  </nav>;
}

function RaceMark({ race }: { race: string }) {
  const icon = getIconPath(race, "race");
  return icon ? <Image src={icon} width={20} height={20} alt={race} /> : <span>{race}</span>;
}
