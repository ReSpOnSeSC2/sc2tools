import Image from "next/image";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import {
  AVAILABILITY_LABELS,
  NEW_FEATURE_GROUPS,
  type NewFeatureAvailability,
  type NewFeatureCard,
  type NewFeatureGroup,
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
const CARD_SPAN: Record<NewFeatureCard["size"], string> = {
  lead: "md:col-span-2",
  tile: "",
  wide: "",
};

const WIDE_LAYOUT = "lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] lg:items-center lg:gap-8";
const SIDE_BY_SIDE_LAYOUT = "md:max-lg:grid md:max-lg:grid-cols-2 md:max-lg:items-center md:max-lg:gap-6";

function layoutClasses(wide: boolean, sideBySide: boolean): string {
  if (wide) return WIDE_LAYOUT;
  return sideBySide ? SIDE_BY_SIDE_LAYOUT : "";
}

export function WhatsNewShowcase() {
  return (
    <section id="whats-new" aria-labelledby="whats-new-heading" className="mt-20 scroll-mt-24 md:mt-28">
      <p className="hud-label">Just shipped</p>
      <h2 id="whats-new-heading" className="mt-2 font-display text-h2 font-bold leading-tight tracking-tight text-text">
        What&rsquo;s new
      </h2>
      <p className="mt-3 max-w-prose text-body-lg text-text-muted">
        A Randomizer that draws for every race, new tools for your stream and a
        live directory. Cards marked Desktop app 0.26.0 need the Windows app.
      </p>
      {NEW_FEATURE_GROUPS.map((group) => <FeatureGroup key={group.id} group={group} />)}
    </section>
  );
}

function FeatureGroup({ group }: { group: NewFeatureGroup }) {
  const headingId = `whats-new-${group.id}`;
  return (
    <div className="mt-10">
      <h3 id={headingId} className="font-display text-2xl font-bold tracking-tight text-text">{group.title}</h3>
      <ul aria-labelledby={headingId} className={`mt-4 grid gap-4 ${GROUP_COLUMNS[group.columns]}`}>
        {group.cards.map((card, index) => (
          <li key={card.id} className={`min-w-0 ${CARD_SPAN[card.size]} ${isOrphan(group, index) ? "md:col-span-2 lg:col-span-1" : ""}`}>
            <FeatureCard card={card} sideBySide={isOrphan(group, index)} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The last card of a three-column group would sit alone in a two-column row on a tablet. */
function isOrphan(group: NewFeatureGroup, index: number): boolean {
  return group.columns === 3 && index === group.cards.length - 1;
}

function FeatureCard({ card, sideBySide }: { card: NewFeatureCard; sideBySide: boolean }) {
  const wide = card.size === "wide";
  const { image } = card;
  return (
    <article aria-labelledby={`${card.id}-title`} className={`${CARD} ${layoutClasses(wide, sideBySide)}`}>
      <div
        className={`grid min-w-0 place-items-center overflow-hidden rounded-xl border border-line bg-bg-elevated/40 ${wide ? "lg:order-last" : ""}`}
        style={{ aspectRatio: card.size === "tile" ? "2 / 1" : `${image.width} / ${image.height}` }}
      >
        <Image
          src={image.src}
          alt={image.alt}
          width={image.width}
          height={image.height}
          sizes={wide ? "(min-width: 1024px) 640px, (min-width: 768px) 50vw, 100vw" : "(min-width: 1024px) 380px, (min-width: 768px) 50vw, 100vw"}
          className="block h-full w-full object-contain"
        />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <p><span className={`${BADGE_BASE} ${BADGE_TONES[card.availability]}`}>{AVAILABILITY_LABELS[card.availability]}</span></p>
        <h4 id={`${card.id}-title`} className="font-display text-xl font-bold leading-snug tracking-tight text-text">{card.title}</h4>
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
