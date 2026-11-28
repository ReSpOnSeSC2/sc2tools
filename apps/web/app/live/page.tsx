import Link from "next/link";
import { LiveStreams } from "@/components/live/LiveStreams";
import { pageMetadata } from "@/lib/seo/pageMetadata";

export const dynamic = "force-static";
export const metadata = pageMetadata({
  title: "Live StarCraft II Streams",
  description: "Every StarCraft II stream that is live now on Twitch and Kick, with viewer counts. Filter by platform and language, or find the small channels first.",
  canonical: "/live",
});

const LINK = "inline-flex min-h-11 items-center rounded-sm text-accent underline focus-visible:ring-2 focus-visible:ring-accent";

export default function LivePage() {
  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-8">
      <header className="space-y-1">
        <Link href="/tools" className={LINK}>All tools</Link>
        <h1 className="font-display text-3xl font-bold leading-tight text-text sm:text-display-lg">Live StarCraft&nbsp;II streams</h1>
        <p className="max-w-prose text-body text-text-muted">Who is live now on Twitch and Kick. Switch the order to find small channels first. Each card opens the channel on its own site.</p>
      </header>
      <LiveStreams />
      <p className="max-w-prose text-caption text-text-muted">Lists come from Twitch and Kick through SC2 Tools and refresh about every minute. Titles and channel names are written by the streamers.</p>
    </div>
  );
}
