import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { languageName, liveForLabel, PLATFORM_NAMES, viewerLabel, type LiveStream } from "@/lib/live/streams";

/** One live channel. The title is the link; its hit area stretches over the whole card. */
export function LiveStreamCard({ stream, now }: { stream: LiveStream; now: number }) {
  const platform = PLATFORM_NAMES[stream.platform];
  const liveFor = liveForLabel(stream.startedAt, now);
  return (
    <li className="relative flex min-h-11 flex-col gap-2 rounded-xl border border-line bg-bg-surface p-4 transition-colors hover:border-accent/50">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={stream.platform === "twitch" ? "accent" : "success"}>{platform}</Badge>
        <Badge variant="neutral">{languageName(stream.language)}</Badge>
        <span className="ml-auto text-caption font-semibold text-text">{viewerLabel(stream.viewers)}</span>
      </div>
      <h3 className="text-body font-semibold text-text">
        <a
          href={stream.url}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-sm after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-accent"
        >
          <span className="line-clamp-2 break-words">{stream.title || `${stream.channel} on ${platform}`}</span>
          <span className="sr-only"> (opens {platform} in a new tab)</span>
        </a>
      </h3>
      <p className="mt-auto flex items-center gap-1.5 text-caption text-text-muted">
        <span className="truncate">{stream.channel}</span>
        {liveFor && <span className="shrink-0">· live for {liveFor}</span>}
        <ExternalLink aria-hidden className="ml-auto size-4 shrink-0" />
      </p>
    </li>
  );
}
