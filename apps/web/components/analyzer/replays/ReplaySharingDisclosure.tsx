import { ShieldCheck } from "lucide-react";

/**
 * What turning on public replays shares: shown before consent on the
 * Replays page and in the game Share menu, so both ask with the same words.
 */
export function ReplaySharingDisclosure() {
  return <div className="space-y-2">
    <h3 className="flex items-center gap-2 text-caption font-semibold text-text"><ShieldCheck className="h-4 w-4 text-accent-cyan" aria-hidden /> Exactly what visitors can see</h3>
    <p className="text-caption leading-relaxed text-text-muted">
      Turning this on shares every synced replay in this archive. Hidden games and games resumed from a replay stay out. Dashboard filters do not limit sharing. Visitors see your display name, both races, your game-time MMR, an approximate opponent rating, detected builds and strategies, macro scores, replay dates, maps, results, and matched Twitch or YouTube VOD links. The archive and analysis keep opponents anonymous. Visitors can view replay previews and download available originals without an account. Full analysis requires sign-in.
    </p>
    <p className="text-caption leading-relaxed text-text-muted">
      Original .SC2Replay files can contain player names, account identifiers, chat, team information, and other data Blizzard records in the file.
    </p>
    <p className="text-caption leading-relaxed text-text-muted">
      Turn sharing off at any time to disable the page, analysis access, and new downloads. A download already in progress can finish. Your player replay address stays assigned to you and becomes available again if you re-enable sharing.
    </p>
  </div>;
}
