import { ShieldCheck } from "lucide-react";

/**
 * What turning on public replays shares: shown before consent on the
 * Replays page and in the game Share menu, so both ask with the same words.
 */
export function ReplaySharingDisclosure() {
  return <div className="space-y-2">
    <h3 className="flex items-center gap-2 text-caption font-semibold text-text"><ShieldCheck className="h-4 w-4 text-accent-cyan" aria-hidden /> Exactly what visitors can see</h3>
    <p className="text-caption leading-relaxed text-text-muted">
      Turning this on shares every synced replay in this archive—not only games visible under your current dashboard filters. Anyone can see replay dates, maps, results, player display names and races, game-time MMR, detected builds and strategies, macro scores, matched Twitch or YouTube VOD links, and download archived original replay files. Replay Analysis and the full Macro breakdown require the visitor to sign in to SC2 Tools.
    </p>
    <p className="text-caption leading-relaxed text-text-muted">
      An original .SC2Replay can contain player/account identifiers, chat, team information, and other data Blizzard embeds in the file. Starting a download also gives that visitor a temporary storage URL, which can reveal the storage host and object path until it expires in about one minute.
    </p>
    <p className="text-caption leading-relaxed text-text-muted">
      Turn sharing off at any time to disable the page, analysis access and new downloads. Your player replay address stays assigned to you and becomes available again if you re-enable sharing. A download URL already issued before sharing is disabled can continue working until its one-minute expiry.
    </p>
  </div>;
}
