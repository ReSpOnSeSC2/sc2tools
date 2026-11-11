import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { GlowHalo } from "@/components/ui/GlowHalo";
import { Icon } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import { ShareButton } from "@/components/ui/ShareButton";
import { fmtMonthYear } from "@/lib/format";
import { raceIconName, raceTint, type Race } from "@/lib/race";
import type { PublicPlayerProfile } from "./types";

export function profileRace(value: string | null): Race | null {
  const token = value?.replace(/^vs\s*/i, "").trim().toLowerCase();
  if (token === "p" || token === "protoss") return "Protoss";
  if (token === "t" || token === "terran") return "Terran";
  if (token === "z" || token === "zerg") return "Zerg";
  if (token === "r" || token === "random") return "Random";
  return null;
}

function identityDescription(profile: PublicPlayerProfile, race: Race | null) {
  const since = fmtMonthYear(profile.joinedAt);
  const builds = profile.publishedBuildCount;
  return [
    race && profile.totals.games > 0 ? race + " player" : null,
    since !== "—" ? "Member since " + since : null,
    builds > 0 ? builds + " published " + (builds === 1 ? "build" : "builds") : null,
  ].filter(Boolean).join(" · ");
}

export function PlayerProfileHero({ profile, overview = true }: { profile: PublicPlayerProfile; overview?: boolean }) {
  const race = profileRace(profile.mainRace);
  const tint = race ? raceTint(race) : null;
  return <Card variant="feature" padded={false} className="relative overflow-hidden">
    <GlowHalo color="cyan" position="top-right" />
    <div className="relative p-5 sm:p-7">
      <PageHeader eyebrow={<span className="inline-flex flex-wrap items-center gap-2">Player profile
        {race && tint ? <Badge variant="neutral" size="sm" className={[tint.bg, tint.border, tint.text].join(" ")}
          iconLeft={<Icon name={raceIconName(race)} kind="race" size={14} decorative />}>{race}</Badge> : null}
      </span>}
        title={<span className="[overflow-wrap:anywhere]">{profile.displayName}</span>}
        description={overview ? identityDescription(profile, race) : undefined}
        actions={<ShareButton path={"/players/" + encodeURIComponent(profile.handle)} title={profile.displayName + " · StarCraft II player"} label="Share profile" />} />
    </div>
  </Card>;
}
