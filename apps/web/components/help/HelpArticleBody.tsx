import Link from "next/link";
import { AlertTriangle, ArrowRight, BookOpen, CheckCircle2, Info, SlidersHorizontal } from "lucide-react";
import { helpInlinePlainText } from "@/lib/help/inline";
import type { HelpArticle, HelpBlock, HelpCalloutTone } from "@/lib/help/types";
import { HelpInline, type HelpLinkOptions } from "./HelpInline";
import { HelpWidget } from "./HelpWidget";

/**
 * Renders an article's blocks. One renderer for every surface:
 *
 *   - "page": the public /help/<slug> article (h2 sub-headings, which
 *     carry their `anchor` as id so /help/<slug>#<anchor> lands on them).
 *   - "compact": Settings → Help sections and the <HelpLink> sheet
 *     (h3 sub-headings, tighter rhythm, no ids: Settings → Help shows
 *     every article on one page, where anchors could repeat).
 *
 * Server-safe (no hooks); `links.onOpenArticle` is only passed by
 * client surfaces.
 */

export type HelpArticleBodyVariant = "page" | "compact";

const TONES: Record<HelpCalloutTone, { box: string; icon: typeof Info; iconClass: string }> = {
  info: { box: "border-accent-cyan/40 bg-accent-cyan/10", icon: Info, iconClass: "text-accent-cyan" },
  warning: { box: "border-warning/40 bg-warning/10", icon: AlertTriangle, iconClass: "text-warning" },
  success: { box: "border-success/40 bg-success/10", icon: CheckCircle2, iconClass: "text-success" },
};

const HEADING_CLASS: Record<HelpArticleBodyVariant, string> = {
  page: "pt-2 font-display text-h4 font-bold text-text",
  compact: "pt-1 text-body font-semibold text-text",
};

/** Section headings: clear the sticky site header; no ring on script focus. */
const ANCHOR_CLASS: Record<HelpArticleBodyVariant, string> = {
  page: "scroll-mt-24",
  compact: "focus:outline-none",
};

function Block({
  block,
  variant,
  links,
}: {
  block: HelpBlock;
  variant: HelpArticleBodyVariant;
  links: HelpLinkOptions;
}) {
  switch (block.type) {
    case "paragraph":
      return (
        <p>
          <HelpInline text={block.text} links={links} />
        </p>
      );
    case "heading": {
      const Heading = variant === "page" ? "h2" : "h3";
      // A section anchor is the element id on the article page, so the
      // browser handles /help/<slug>#<id>. Compact surfaces can show many
      // articles at once (Settings → Help), so they mark it with a data
      // attribute instead; <HelpLink anchor> focuses it inside its sheet.
      const anchorProps = !block.anchor
        ? {}
        : variant === "page"
          ? { id: block.anchor }
          : { "data-help-anchor": block.anchor, tabIndex: -1 };
      return (
        <Heading
          {...anchorProps}
          className={block.anchor ? `${HEADING_CLASS[variant]} ${ANCHOR_CLASS[variant]}` : HEADING_CLASS[variant]}
        >
          <HelpInline text={block.text} links={links} />
        </Heading>
      );
    }
    case "steps":
      return (
        // role="list" keeps list semantics in Safari once the markers are custom.
        <ol role="list" className="space-y-3">
          {block.items.map((item, index) => (
            <li key={index} className="flex gap-3">
              <span
                aria-hidden
                className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-cyan/15 text-micro font-bold text-accent-cyan"
              >
                {index + 1}
              </span>
              <div className="min-w-0">
                <HelpInline text={item} links={links} />
              </div>
            </li>
          ))}
        </ol>
      );
    case "list":
      return (
        <ul className="list-disc space-y-1 pl-5">
          {block.items.map((item, index) => (
            <li key={index}>
              <HelpInline text={item} links={links} />
            </li>
          ))}
        </ul>
      );
    case "callout": {
      const tone = TONES[block.tone];
      const Icon = tone.icon;
      return (
        <div role="note" className={`flex gap-3 rounded-lg border px-4 py-3 ${tone.box}`}>
          <Icon className={`mt-1 h-4 w-4 shrink-0 ${tone.iconClass}`} aria-hidden />
          <div className="min-w-0 space-y-1">
            {block.title ? (
              <p className="font-semibold text-text">
                <HelpInline text={block.title} links={links} />
              </p>
            ) : null}
            <p>
              <HelpInline text={block.text} links={links} />
            </p>
          </div>
        </div>
      );
    }
    case "settingsLink": {
      const Icon = block.href.startsWith("/settings") ? SlidersHorizontal : BookOpen;
      return (
        <p>
          <Link
            href={block.href}
            className="inline-flex min-h-11 items-center gap-2 rounded-sm font-semibold text-accent-cyan underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden />
            {helpInlinePlainText(block.label)}
            <ArrowRight className="h-4 w-4 shrink-0" aria-hidden />
          </Link>
        </p>
      );
    }
    case "image":
      return (
        <figure className="space-y-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- help screenshots are static /public files of varying size */}
          <img
            src={block.src}
            alt={block.alt}
            loading="lazy"
            decoding="async"
            className="h-auto w-full rounded-lg border border-border"
          />
          {block.caption ? (
            <figcaption className="text-caption text-text-dim">
              <HelpInline text={block.caption} links={links} />
            </figcaption>
          ) : null}
        </figure>
      );
    case "table":
      return (
        <div
          role="region"
          aria-label={`Table: ${block.head.map(helpInlinePlainText).join(", ")}`}
          tabIndex={0}
          className="overflow-x-auto rounded-lg border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <table className="w-full min-w-[28rem] border-collapse text-left text-caption">
            <thead className="bg-bg-elevated/60 text-text">
              <tr>
                {block.head.map((cell, index) => (
                  <th key={index} scope="col" className="px-3 py-2 font-semibold">
                    <HelpInline text={cell} links={links} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="border-t border-border">
                  {row.map((cell, index) => (
                    <td key={index} className="px-3 py-2 align-top">
                      <HelpInline text={cell} links={links} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "widget":
      return <HelpWidget widget={block.widget} />;
  }
}

export function HelpArticleBody({
  article,
  variant = "page",
  links = {},
}: {
  article: HelpArticle;
  variant?: HelpArticleBodyVariant;
  links?: HelpLinkOptions;
}) {
  return (
    <div className={variant === "page" ? "space-y-4 text-body text-text-muted" : "space-y-3 text-body text-text-muted"}>
      {article.body.map((block, index) => (
        <Block key={index} block={block} variant={variant} links={links} />
      ))}
    </div>
  );
}
