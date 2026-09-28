import { Section } from "@/components/ui/Section";
import { YouTubeFacade } from "@/components/guides/YouTubeFacade";
import { GUIDE_LINK_CLASS, GUIDE_VIDEO_AUTHOR } from "@/components/guides/guideUi";
import { safeVideoUrls } from "@/components/guides/youtubeUrls";
import { fmtGuideDate } from "@/lib/guides/format";
import type { GuideVideo } from "@/lib/guides/types";

/**
 * "Video guide" block for build and counter pages: the first matched
 * channel video as a click-to-load player, with the description's own
 * excerpt and checklist quoted verbatim under the author credit. Further
 * matches are plain links. Renders nothing without videos.
 */
export function GuideVideoSection({
  videos,
  title = "Video guide",
}: {
  videos: ReadonlyArray<GuideVideo>;
  title?: string;
}) {
  const [first, ...rest] = videos;
  if (!first) return null;
  return (
    <Section title={title} id="video">
      <div className="grid gap-5 md:grid-cols-2 md:items-start">
        <YouTubeFacade
          video={{
            youtubeId: first.youtubeId,
            title: first.title,
            url: first.url,
            thumbnailUrl: first.thumbnailUrl,
            embedUrl: first.embedUrl,
          }}
        />
        <VideoNotes video={first} />
      </div>
      {rest.length > 0 ? <MoreVideos videos={rest} /> : null}
    </Section>
  );
}

function VideoNotes({ video }: { video: GuideVideo }) {
  const checklist = video.checklist ?? [];
  return (
    <div className="min-w-0 space-y-3">
      <div>
        <h3 className="font-display text-h4 font-bold text-text">{video.title}</h3>
        {video.publishedAt ? (
          <p className="text-caption text-text-dim">Published {fmtGuideDate(video.publishedAt)}</p>
        ) : null}
      </div>
      {video.excerpt || checklist.length > 0 ? (
        <figure className="space-y-2">
          <figcaption className="overline text-accent-cyan">
            From the video by {GUIDE_VIDEO_AUTHOR}
          </figcaption>
          {video.excerpt ? (
            <blockquote className="border-l-2 border-accent-cyan/50 pl-3 text-body text-text-muted">
              {video.excerpt}
            </blockquote>
          ) : null}
          {checklist.length > 0 ? (
            <ol className="list-decimal space-y-1 pl-5 text-caption text-text">
              {checklist.map((item, index) => (
                <li key={`${index}-${item}`}>{item}</li>
              ))}
            </ol>
          ) : null}
        </figure>
      ) : null}
    </div>
  );
}

function MoreVideos({ videos }: { videos: ReadonlyArray<GuideVideo> }) {
  const links = videos
    .map((video) => ({ video, href: safeVideoUrls(video).watch }))
    .filter((entry): entry is { video: GuideVideo; href: string } => entry.href !== null);
  if (links.length === 0) return null;
  return (
    <div className="mt-4 space-y-1">
      <h3 className="text-caption font-semibold text-text">More videos</h3>
      <ul className="space-y-1 text-caption">
        {links.map(({ video, href }) => (
          <li key={video.youtubeId}>
            <a href={href} target="_blank" rel="noopener noreferrer" className={GUIDE_LINK_CLASS}>
              {video.title}
            </a>{" "}
            {video.publishedAt ? (
              <span className="text-text-dim">· {fmtGuideDate(video.publishedAt)}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
