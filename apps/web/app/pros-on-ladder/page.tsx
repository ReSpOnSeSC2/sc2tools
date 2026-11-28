import Link from "next/link";
import { ProBoard } from "@/components/proBoard/ProBoard";
import { getJson } from "@/lib/serverApi";
import { pageMetadata } from "@/lib/seo/pageMetadata";

/** The page is rebuilt every few minutes, so it knows the server's gates and draws the right state at once. */
export const revalidate = 300;
export const metadata = pageMetadata({
  title: "Pros on Ladder",
  description: "Which StarCraft II Grandmasters and pros are playing on the ladder right now, how their last games went, and who is streaming.",
  canonical: "/pros-on-ladder",
});

const LINK = "inline-flex min-h-11 items-center rounded-sm text-accent underline focus-visible:ring-2 focus-visible:ring-accent";

const INTRO = "Who is playing on the Grandmaster ladder right now.";
const INTRO_NAMED = `${INTRO} Known pros show their last games and a link when they are live.`;

export default async function ProsOnLadderPage() {
  const gate = await getJson<{ available?: boolean; showNames?: boolean }>("/v1/pros-on-ladder/status", { revalidateSec: 300 });
  const names = gate?.showNames === true;
  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-8">
      <header className="space-y-1">
        <Link href="/tools" className={LINK}>All tools</Link>
        <h1 className="font-display text-3xl font-bold leading-tight text-text sm:text-display-lg">Pros on Ladder</h1>
        <p className="max-w-prose text-body text-text-muted">{names ? INTRO_NAMED : INTRO}</p>
      </header>
      <ProBoard closed={gate?.available === false} names={names} />
      <p className="max-w-prose text-caption text-text-muted">Games come from SC2Pulse through SC2 Tools and are refreshed every few minutes. Players are never named unless they are known pros, and no game names the other player.</p>
    </div>
  );
}
