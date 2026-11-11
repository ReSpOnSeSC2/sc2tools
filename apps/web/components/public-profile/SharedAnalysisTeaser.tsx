import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { LinkButton } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/PageHeader";
import { resultLabel } from "@/components/analyzer/game/types";
import { signInHref } from "@/lib/authLinks";
import { fmtMinutes } from "@/lib/format";
import { sharedReplayMap } from "@/lib/sharedReplayTitle";
import type { PublicReplayCard } from "@/lib/publicReplayCard";
import { PublicReplayDownloadButton } from "./PublicReplayDownloadButton";

export function SharedAnalysisTeaser({ card, reference }: { card: PublicReplayCard; reference: string }) {
  const { profile, game } = card;
  const archive = "/players/" + encodeURIComponent(profile.handle) + "/replays";
  const result = resultLabel(game.result);
  const map = sharedReplayMap(game.map);
  const details = [game.matchup, map, game.durationSec === null ? null : fmtMinutes(game.durationSec)].filter(Boolean).join(" · ");
  return <Card variant="feature" className="space-y-5">
    <PageHeader eyebrow={<span className="inline-flex flex-wrap items-center gap-2">Shared replay
      {result !== "Unknown" ? <Badge variant={result === "Win" ? "success" : result === "Loss" ? "danger" : "neutral"}>{result}</Badge> : null}
    </span>} title={profile.displayName + "'s replay"} description={details} />
    {game.myBuild || game.oppStrategy ? <dl className="grid gap-3 sm:grid-cols-2">
      {game.myBuild ? <div><dt className="text-caption text-text-muted">Player build</dt><dd className="break-words font-semibold text-text">{game.myBuild}</dd></div> : null}
      {game.oppStrategy ? <div><dt className="text-caption text-text-muted">Opponent strategy</dt><dd className="break-words font-semibold text-text">{game.oppStrategy}</dd></div> : null}
    </dl> : null}
    <p className="text-body text-text-muted">Sign in free to open the timeline, macro breakdown and both build orders.</p>
    <div className="flex flex-wrap items-center gap-2">
      <LinkButton href={signInHref(archive + "/" + reference)}>Sign in free</LinkButton>
      <PublicReplayDownloadButton handle={profile.handle} gameId={reference} available={game.replayAvailable} appearance="pill" />
      <LinkButton href={archive} variant="ghost">View replay archive</LinkButton>
    </div>
  </Card>;
}
