import Image from "next/image";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import {
  AVAILABILITY_LABELS,
  NEW_FEATURE_GROUPS,
  type NewFeatureAvailability,
  type NewFeatureCard,
  type NewFeatureCardSize,
  type NewFeatureGroup,
  type NewFeatureImage,
} from "@/lib/landingNewFeatures";

/**
 * What the latest releases added, directly above Humdingers. Rendered on the
 * server with no client code, so the landing page's first-load JavaScript is
 * unchanged. Every card carries an availability label so a visitor never
 * reads a switched-off or not-yet-released feature as live.
 */
const BADGE_BASE = "inline-flex min-h-6 items-center rounded-full border px-2 text-micro font-semibold";
const BADGE_TONES: Record<NewFeatureAvailability, string> = {
  live: "border-success/30 bg-success/5 text-success",
  desktop: "border-accent-cyan/30 bg-accent-cyan/15 text-accent-cyan",
  soon: "border-warning/30 bg-warning/5 text-warning",
};
const CARD = "flex h-full min-w-0 flex-col gap-4 rounded-2xl border border-line bg-bg-surface/70 p-5 shadow-card sm:p-6";
const GROUP_COLUMNS = { 1: "", 3: "md:grid-cols-2 lg:grid-cols-3" } as const;

/** The orphan of a three-column group takes the whole tablet row and lays out like a feature card. */
export const ORPHAN_SPAN = "md:col-span-2 lg:col-span-1";
const ORPHAN_LAYOUT = "md:max-lg:grid md:max-lg:grid-cols-2 md:max-lg:items-center md:max-lg:gap-6";
const CARD_LAYOUT: Record<NewFeatureCardSize, string> = {
  feature: "md:grid md:grid-cols-[minmax(0,1fr)_20rem] md:items-center md:gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]",
  tile: "",
  wide: "lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] lg:items-center lg:gap-8",
};
const PICTURE_FIRST: Record<NewFeatureCardSize, string> = { feature: "md:order-last", tile: "", wide: "lg:order-last" };
const FRAME_WIDTH: Record<NewFeatureCardSize, string> = { feature: "max-w-[22rem]", tile: "max-w-sm", wide: "" };

/** The width each picture is shown at, so next/image serves a file at least that wide. */
export const PICTURE_SIZES: Record<NewFeatureCardSize, string> = {
  feature: "(min-width: 1024px) 352px, (min-width: 768px) 320px, calc(100vw - 80px)",
  tile: "(min-width: 1024px) 376px, (min-width: 768px) 50vw, calc(100vw - 80px)",
  wide: "(min-width: 1024px) 640px, calc(100vw - 112px)",
};

// The site theme is the data-theme attribute on the root; with none set it is dark.
const IN_LIGHT_ONLY = "hidden [:root[data-theme=light]_&]:block";
const IN_DARK_ONLY = "[:root[data-theme=light]_&]:hidden";

export function WhatsNewShowcase() {
  return (
    <section id="whats-new" aria-labelledby="whats-new-heading" className="mt-20 scroll-mt-24 md:mt-28">
      <p className="hud-label">Latest releases</p>
      <h2 id="whats-new-heading" className="mt-2 font-display text-h2 font-bold leading-tight tracking-tight text-text">
        What&rsquo;s new
      </h2>
      <p className="mt-3 max-w-prose text-body-lg text-text-muted">
        A Randomizer that draws for every race and new tools for your stream,
        with a live stream directory on its way. Cards marked Desktop app 0.26.0
        need the Windows app.
      </p>
      {NEW_FEATURE_GROUPS.map((group) => <FeatureGroup key={group.id} group={group} />)}
    </section>
  );
}

function FeatureGroup({ group }: { group: NewFeatureGroup }) {
  const headingId = `whats-new-${group.id}`;
  return (
    <div className="mt-10">
      <h3 id={headingId} className="font-display text-h3 font-bold text-text">{group.title}</h3>
      <ul aria-labelledby={headingId} className={`mt-4 grid gap-4 ${GROUP_COLUMNS[group.columns]}`}>
        {group.cards.map((card, index) => {
          const orphan = isOrphan(group, index);
          return (
            <li key={card.id} className={`min-w-0 ${orphan ? ORPHAN_SPAN : ""}`}>
              <FeatureCard card={card} orphan={orphan} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The last card of a three-column group would sit alone in a two-column row on a tablet. */
export function isOrphan(group: NewFeatureGroup, index: number): boolean {
  return group.columns === 3 && index === group.cards.length - 1;
}

function FeatureCard({ card, orphan }: { card: NewFeatureCard; orphan: boolean }) {
  const { size } = card;
  return (
    <article aria-labelledby={`${card.id}-title`} className={`${CARD} ${CARD_LAYOUT[size]} ${orphan ? ORPHAN_LAYOUT : ""}`}>
      <Picture image={card.image} size={size} />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <p><span className={`${BADGE_BASE} ${BADGE_TONES[card.availability]}`}>{AVAILABILITY_LABELS[card.availability]}</span></p>
        <h4 id={`${card.id}-title`} className="font-display text-h4 font-bold text-text">{card.title}</h4>
        <p className="max-w-prose text-body text-text-muted">{card.text}</p>
        {card.note ? <p className="text-caption font-semibold text-warning">{card.note}</p> : null}
        <Link
          href={card.link.href}
          className="mt-auto inline-flex min-h-11 items-center gap-2 self-start rounded-md text-caption font-semibold text-text underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {card.link.label}
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      </div>
    </article>
  );
}

/** A framed picture. The frame keeps the file's aspect ratio, so nothing moves as it loads. */
function Picture({ image, size }: { image: NewFeatureImage; size: NewFeatureCardSize }) {
  const themed = Boolean(image.dark);
  const classes = `block h-full w-full ${image.fade ? "[mask-image:linear-gradient(to_bottom,#000_80%,transparent)]" : ""}`;
  const shared = { width: image.width, height: image.height, sizes: PICTURE_SIZES[size], className: classes };
  return (
    <div
      className={`w-full min-w-0 overflow-hidden rounded-xl border border-line bg-bg-elevated/40 ${FRAME_WIDTH[size]} ${PICTURE_FIRST[size]}`}
      style={{ aspectRatio: `${image.width} / ${image.height}` }}
    >
      {themed ? (
        <>
          <Image src={image.src} alt={image.alt} {...shared} className={`${classes} ${IN_LIGHT_ONLY}`} />
          <Image src={image.dark!} alt={image.alt} {...shared} className={`${classes} ${IN_DARK_ONLY}`} />
        </>
      ) : (
        <Image src={image.src} alt={image.alt} {...shared} />
      )}
    </div>
  );
}
