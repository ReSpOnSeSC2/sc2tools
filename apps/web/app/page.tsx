import type { Metadata } from "next";
import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  BarChart3,
  CheckCircle2,
  Cloud,
  Download,
  Gamepad2,
  Heart,
  Library,
  Map,
  Mic2,
  Shield,
  Swords,
  Tv,
  Wand2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Banner } from "@/components/Banner";
import {
  HeroCarousel,
  type HeroCarouselSlide,
} from "@/components/landing/HeroCarousel";
import { ReplayDemo } from "@/components/landing/ReplayDemo";
import { InstallPrompt } from "@/components/pwa/InstallPrompt";

/* =============================================================== */
/* PAGE                                                             */
/*                                                                  */
/* Art direction: this is laid out as a magazine "field manual",    */
/* not a centred SaaS landing page. One sans (Hanken, body) + one   */
/* serif (Fraunces, headlines); a clay-rose editorial accent as the */
/* single unusual note against the cool teal/cyan; squared corners  */
/* (rounded-md / none, never 2xl); and asymmetric, columnar spacing */
/* with hairline rules instead of glowing cards.                    */
/* =============================================================== */

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://sc2tools.com";

export const metadata: Metadata = {
  // Self-referencing canonical so query params (?source=pwa, utm_*) don't
  // fragment ranking signals across "duplicate" URLs.
  alternates: { canonical: "/" },
};

/**
 * Organization + WebSite structured data. Helps Google build the brand
 * knowledge panel and surface a sitelinks search box for "sc2tools".
 */
const ORGANIZATION_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "SC2 Tools",
  url: SITE_URL,
  logo: `${SITE_URL}/logo.png`,
};

const WEBSITE_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "SC2 Tools",
  url: SITE_URL,
  description:
    "Opponent intel, build orders, and a live OBS overlay for StarCraft II.",
};

export default function LandingPage() {
  return (
    <div className="mx-auto max-w-6xl">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(ORGANIZATION_JSON_LD) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(WEBSITE_JSON_LD) }}
      />
      <Masthead />
      <LeadFeature />
      <MobileInstallSection />
      <ReplaySection />
      <PillarsSection />
      <HowItWorksSection />
      <ArcadeSection />
      <PullQuoteSection />
      <DonateBanner />
      <FinalCtaSection />
    </div>
  );
}

/* =============================================================== */
/* MASTHEAD — the editorial header bar (issue meta + folio)         */
/* =============================================================== */

function Masthead() {
  return (
    <header className="border-y border-border-strong">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-3">
        <span className="kicker">SC2 Tools — Field Manual</span>
        <span className="font-mono text-caption text-text-dim">
          Scouting Dept. · No. 01 · Free forever
        </span>
      </div>
    </header>
  );
}

/* =============================================================== */
/* LEAD FEATURE — asymmetric hero: standfirst column + product peek */
/* =============================================================== */

function LeadFeature() {
  return (
    <section className="grid gap-x-10 gap-y-10 pt-10 md:pt-16 lg:grid-cols-12">
      {/* Headline + standfirst — narrow editorial column, left rail */}
      <div className="lg:col-span-5 lg:pr-2">
        <p className="kicker">Opponent Intelligence</p>
        <h1 className="mt-5 font-serif text-[44px] font-semibold leading-[1.02] tracking-[-0.01em] text-text md:text-[60px]">
          Your opponent&rsquo;s build,{" "}
          <em className="font-serif italic text-editorial">
            before they build it.
          </em>
        </h1>
        <p className="drop-initial mt-6 max-w-prose text-body-lg text-text-muted">
          Sign in, install a 219&nbsp;MB agent, and every replay you finish
          surfaces an opponent dossier, a build classifier, and a live OBS
          overlay — across every device. No tagging, no manual import.
        </p>

        <div className="mt-7 flex flex-wrap gap-3">
          <CtaLink
            href="/sign-up"
            iconRight={<ArrowRight className="h-5 w-5" aria-hidden />}
          >
            Get started — it&apos;s free
          </CtaLink>
          <CtaLink
            href="/download"
            variant="secondary"
            iconLeft={<Download className="h-5 w-5" aria-hidden />}
          >
            Download the agent
          </CtaLink>
        </div>

        <TrustStrip />
      </div>

      {/* Product peek — the wider plate, pushed to the right rail */}
      <div className="lg:col-span-7">
        <CarouselSection />
      </div>
    </section>
  );
}

function CarouselSection() {
  const slides: ReadonlyArray<HeroCarouselSlide> = [
    {
      id: "hero",
      label: "Your opponent's build, before they build it",
      content: <HeroBannerSlide />,
    },
    ...HERO_PEEK_SLIDES.map((peek) => ({
      id: peek.id,
      label: peek.eyebrow,
      content: <HeroPeekSlide {...peek} />,
    })),
  ];
  return (
    <div className="relative">
      <HeroCarousel slides={slides} ariaLabel="SC2 Tools landing carousel" />
    </div>
  );
}

/* =============================================================== */
/* MOBILE INSTALL — PWA "Add to Home Screen" banner (mobile only)   */
/* =============================================================== */

function MobileInstallSection() {
  return (
    <section className="relative mt-12 md:hidden">
      <InstallPrompt />
    </section>
  );
}

/* ----- Hero carousel slide bodies -------------------------------- */

function HeroBannerSlide() {
  return (
    <div className="relative">
      <Banner variant="hero" />
    </div>
  );
}

interface HeroPeek {
  id: string;
  eyebrow: string;
  title: string;
  body: string;
  imageSrc: string;
  imageAlt: string;
}

const HERO_PEEK_SLIDES: ReadonlyArray<HeroPeek> = [
  {
    id: "peek-dossier",
    eyebrow: "See it before you sign up",
    title: "Opponent dossier — auto-built",
    body: "Race, MMR, build tendencies, recent matchup history — surfaced the moment a replay finishes parsing.",
    imageSrc: "/landing/opponent-dna.png",
    imageAlt:
      "Opponent profile page in SC2 Tools showing matchup record, build tendencies, and median key timings",
  },
  {
    id: "peek-overlay-live",
    eyebrow: "See it before you sign up",
    title: "Live OBS overlay — copy & paste",
    body: "15 broadcast-ready widgets behind one URL. Drop it into a Browser Source and you're streaming.",
    imageSrc: "/landing/overlay-live.png",
    imageAlt:
      "StarCraft II gameplay with the SC2 Tools live OBS overlay running — opponent identity card, session record, and rematch flag",
  },
  {
    id: "peek-overlay-rematch",
    eyebrow: "See it before you sign up",
    title: "Familiar-opponent flags, on stream",
    body: "The scouting overlay shows your stats against this player — the build order they opened with, and whether you won or lost.",
    imageSrc: "/landing/overlay-rematch.png",
    imageAlt:
      "Stream overlay rematch widget — opponent name, MMR, FAMILIAR / Last Defeat tag, and a list of recent games",
  },
  {
    id: "peek-builds",
    eyebrow: "See it before you sign up",
    title: "Build classifier — no tagging",
    body: "Every replay auto-classified into your build library. Win-rate per opener, per matchup, per map.",
    imageSrc: "/landing/builds.png",
    imageAlt:
      "Custom Builds page in SC2 Tools showing per-build wins, losses, win rate, and trend sparklines",
  },
  {
    id: "peek-build-editor",
    eyebrow: "See it before you sign up",
    title: "Save any replay as a custom build",
    body: "Open a game, click ‘Save as new build’, set your rules — your replays reclassify under the new build-order name instantly.",
    imageSrc: "/landing/build-editor.png",
    imageAlt:
      "Save-as-new-build editor with the source replay timeline on the left and one-click rule promotion buttons",
  },
];

function HeroPeekSlide({
  eyebrow,
  title,
  body,
  imageSrc,
  imageAlt,
}: HeroPeek) {
  return (
    <div className="grid min-h-[260px] items-center gap-6 px-6 py-8 sm:min-h-[320px] sm:px-9 sm:py-10 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] md:gap-9">
      <div className="space-y-3">
        <p className="kicker">{eyebrow}</p>
        <h2 className="font-serif text-[26px] font-semibold leading-tight tracking-[-0.01em] text-text md:text-[30px]">
          {title}
        </h2>
        <p className="text-body-lg text-text-muted">{body}</p>
      </div>
      <div className="overflow-hidden rounded-md border-2 border-line bg-bg-elevated/40">
        <Image
          src={imageSrc}
          alt={imageAlt}
          width={1600}
          height={900}
          sizes="(min-width: 1024px) 60vw, 100vw"
          className="block h-auto w-full"
        />
      </div>
    </div>
  );
}

const TRUST_BADGES: ReadonlyArray<{ icon: LucideIcon; label: string }> = [
  { icon: Shield, label: "Free desktop" },
  { icon: Cloud, label: "Cross-device cloud" },
  { icon: Tv, label: "OBS overlay ready" },
  { icon: CheckCircle2, label: "GDPR" },
];

function TrustStrip() {
  return (
    <ul className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border pt-4 text-text-muted">
      {TRUST_BADGES.map(({ icon: Icon, label }) => (
        <li key={label} className="flex items-center gap-1.5 text-caption">
          <Icon className="h-4 w-4 text-editorial" aria-hidden />
          <span>{label}</span>
        </li>
      ))}
    </ul>
  );
}

/* =============================================================== */
/* REPLAY DEMO — framed as a numbered editorial feature             */
/* =============================================================== */

function ReplaySection() {
  return (
    <section className="mt-24 md:mt-32">
      <ReplayDemo />
    </section>
  );
}

/* =============================================================== */
/* PILLARS — the feature index, set as a magazine list             */
/* =============================================================== */

interface Pillar {
  icon: LucideIcon;
  title: string;
  body: string;
}

const PILLARS: ReadonlyArray<Pillar> = [
  {
    icon: Tv,
    title: "Live OBS Overlay",
    body: "15 broadcast-ready widgets, per-widget URLs. Drop one URL into Browser Source and you're streaming.",
  },
  {
    icon: Swords,
    title: "Strategy Detection",
    body: "Per-matchup playbook with rule-based opener identification across 100+ builds.",
  },
  {
    icon: Mic2,
    title: "Voice Readout",
    body: "Optional in-ear scouting card before each game.",
  },
  {
    icon: Wand2,
    title: "Auto Replay Classification",
    body: "Parse every game in seconds, no tagging.",
  },
  {
    icon: BarChart3,
    title: "Build Recognizer",
    body: "Per-build W-L, with map and MMR breakdowns.",
  },
  {
    icon: Map,
    title: "Map Intel & Veto Planning",
    body: "Per-map win rates and timing libraries.",
  },
  {
    icon: Library,
    title: "Custom Build Library",
    body: "Sync your openers, browse the community pool.",
  },
];

function PillarsSection() {
  return (
    <section className="mt-24 md:mt-32">
      <EditorialHead
        folio="B"
        kicker="The kit"
        title="Seven instruments, one pipeline."
        standfirst="Every cloud feature you'll use, all wired into the same replay-parsing pipeline."
      />
      {/* Asymmetric index: a numbered editorial list, not a card wall. */}
      <ol className="mt-10 grid gap-x-10 gap-y-px sm:grid-cols-2">
        {PILLARS.map((p, i) => (
          <PillarEntry key={p.title} index={i + 1} {...p} />
        ))}
      </ol>
    </section>
  );
}

function PillarEntry({
  index,
  icon: Icon,
  title,
  body,
}: Pillar & { index: number }) {
  return (
    <li className="flex gap-4 border-t border-border py-6">
      <span
        aria-hidden
        className="select-none font-serif text-h2 font-normal leading-none text-editorial/70 tabular-nums"
      >
        {index.toString().padStart(2, "0")}
      </span>
      <div className="space-y-1.5">
        <h3 className="flex items-center gap-2 font-serif text-h3 font-semibold tracking-[-0.01em] text-text">
          <Icon className="h-5 w-5 text-accent-cyan" aria-hidden />
          {title}
        </h3>
        <p className="text-body text-text-muted">{body}</p>
      </div>
    </li>
  );
}

/* =============================================================== */
/* HOW IT WORKS — three editorial steps with big serif folios       */
/* =============================================================== */

interface Step {
  num: string;
  title: string;
  body: string;
}

const STEPS: ReadonlyArray<Step> = [
  {
    num: "01",
    title: "Install the agent",
    body: "Download the 219 MB installer and pair it with your account in 90 seconds.",
  },
  {
    num: "02",
    title: "Play normally",
    body: "Every replay you finish parses and uploads in the background. No tagging, no manual import.",
  },
  {
    num: "03",
    title: "Light it up",
    body: "Your dashboard updates between games. Drop your overlay URL into OBS for stream-day reveal.",
  },
];

function HowItWorksSection() {
  return (
    <section className="mt-24 md:mt-32">
      <EditorialHead
        folio="C"
        kicker="The routine"
        title="Three steps. Then it stays out of your way."
      />
      <div className="mt-10 grid gap-x-10 gap-y-10 md:grid-cols-3">
        {STEPS.map((step) => (
          <div key={step.num} className="border-t-2 border-line pt-5">
            <span className="block font-serif text-display-lg font-normal leading-none text-editorial">
              {step.num}
            </span>
            <h3 className="mt-4 font-serif text-h3 font-semibold tracking-[-0.01em] text-text">
              {step.title}
            </h3>
            <p className="mt-2 text-body text-text-muted">{step.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/* =============================================================== */
/* ARCADE — quizzes/games generated from the user's real replays    */
/* =============================================================== */

interface ArcadeTile {
  /** Path under /public for the mode's PNG icon. */
  iconSrc: string;
  title: string;
  body: string;
}

const ARCADE_TILES: ReadonlyArray<ArcadeTile> = [
  {
    iconSrc: "/arcade/icons/buildle.png",
    title: "Buildle",
    body: "Daily case file. One real game, one hidden fact, one shot to crack it.",
  },
  {
    iconSrc: "/arcade/icons/closers-eye.png",
    title: "Closer's Eye",
    body: "Which of your builds closes wins the fastest? Mean win-length, blind.",
  },
  {
    iconSrc: "/arcade/icons/two-truths-lie.png",
    title: "Two Truths & a Lie",
    body: "Two real facts about your play, one fake. Spot the lie.",
  },
  {
    iconSrc: "/arcade/icons/bingo-ladder.png",
    title: "Bingo: Ladder Edition",
    body: "A 5×5 of forward objectives. Your next-7-day games tick the cells.",
  },
  {
    iconSrc: "/arcade/icons/stock-market.png",
    title: "Stock Market",
    body: "Lock in a build portfolio. Weekly P&L feeds the leaderboard.",
  },
];

function ArcadeSection() {
  return (
    <section className="mt-24 md:mt-32">
      <EditorialHead
        folio="D"
        kicker="New · Arcade"
        title="Your ladder data, playable."
        standfirst="Thirteen modes — quizzes, games, weekly bingo — all generated from your real replays. Daily drop, XP, shareable score cards."
      />
      <ul className="mt-10 grid gap-x-10 gap-y-px sm:grid-cols-2 lg:grid-cols-3">
        {ARCADE_TILES.map((tile) => (
          <ArcadeEntry key={tile.title} {...tile} />
        ))}
        <ArcadeMoreEntry />
      </ul>
      <div className="mt-8 flex flex-wrap items-center gap-3">
        <CtaLink
          href="/sign-up"
          iconLeft={<Gamepad2 className="h-5 w-5" aria-hidden />}
          iconRight={<ArrowRight className="h-5 w-5" aria-hidden />}
        >
          Sign in to play
        </CtaLink>
      </div>
    </section>
  );
}

function ArcadeEntry({ iconSrc, title, body }: ArcadeTile) {
  return (
    <li className="flex gap-4 border-t border-border py-6">
      <span
        aria-hidden
        className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-md border-2 border-editorial/30 bg-editorial/10"
      >
        <Image
          src={iconSrc}
          alt=""
          width={28}
          height={28}
          className="h-7 w-7"
          unoptimized
        />
      </span>
      <div className="space-y-1.5">
        <h3 className="font-serif text-h4 font-semibold text-text">{title}</h3>
        <p className="text-body text-text-muted">{body}</p>
      </div>
    </li>
  );
}

function ArcadeMoreEntry() {
  return (
    <li className="flex gap-4 border-t border-border py-6">
      <span
        aria-hidden
        className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-md border-2 border-editorial/30 bg-editorial/10 text-editorial"
      >
        <Gamepad2 className="h-5 w-5" />
      </span>
      <div className="space-y-1.5">
        <h3 className="font-serif text-h4 font-semibold text-text">
          +8 more modes
        </h3>
        <p className="text-body text-text-muted">
          Streaks, macro memory, rivalries, comebacks, build cards… Quick Play
          any of them, or chase the Daily Drop.
        </p>
      </div>
    </li>
  );
}

/* =============================================================== */
/* PULL QUOTE — editorial standfirst, replaces the centred blurb    */
/* =============================================================== */

function PullQuoteSection() {
  return (
    <section className="mt-24 grid gap-x-10 gap-y-6 md:mt-32 lg:grid-cols-12">
      <p className="kicker self-start lg:col-span-3 lg:pt-3">Built in the open</p>
      <blockquote className="lg:col-span-9">
        <p className="border-l-2 border-editorial pl-6 font-serif text-[28px] font-normal italic leading-snug tracking-[-0.01em] text-text md:text-[36px]">
          Built by ladder players, for ladder players. Every classifier rule,
          every overlay, every UI decision came from someone trying to win
          their next game.
        </p>
      </blockquote>
    </section>
  );
}

/* =============================================================== */
/* DONATE BANNER                                                    */
/* =============================================================== */

function DonateBanner() {
  return (
    <section className="mt-24 md:mt-32">
      <div className="grid items-center gap-6 rounded-md border-2 border-line bg-bg-surface p-6 shadow-hard md:grid-cols-[auto_minmax(0,1fr)_auto] md:gap-8 md:p-8">
        <span
          aria-hidden
          className="inline-flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-md border-2 border-editorial/40 bg-editorial/10 text-editorial"
        >
          <Heart className="h-7 w-7" />
        </span>
        <div className="space-y-1.5">
          <p className="kicker">Donation-supported</p>
          <h2 className="font-serif text-h3 font-semibold tracking-[-0.01em] text-text md:text-h2">
            Free now, free forever — donations keep the servers up.
          </h2>
          <p className="text-body text-text-muted">
            One paid Render service, a MongoDB Atlas M10 cluster, and the
            sc2tools.com domain run the cloud. If SC2 Tools is helping your
            ladder grind, a one-time tip helps cover the bill.
          </p>
        </div>
        <Link
          href="/donate"
          className="inline-flex h-12 items-center justify-center gap-2 rounded-md bg-accent px-5 text-body-lg font-semibold text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg md:self-center"
        >
          See how to chip in
          <ArrowRight className="h-5 w-5" aria-hidden />
        </Link>
      </div>
    </section>
  );
}

/* =============================================================== */
/* FINAL CTA — the closer, left-aligned editorial sign-off          */
/* =============================================================== */

function FinalCtaSection() {
  return (
    <section className="mt-24 md:mt-32">
      <div className="rounded-md border-2 border-accent bg-bg-surface px-6 py-12 shadow-hard md:px-12 md:py-16">
        <p className="kicker">The bottom line</p>
        <h2 className="mt-4 max-w-3xl font-serif text-[40px] font-semibold leading-[1.04] tracking-[-0.01em] text-text md:text-display-lg">
          Stop guessing.{" "}
          <em className="font-serif italic text-editorial">Start knowing.</em>
        </h2>
        <p className="mt-5 max-w-2xl text-body-lg text-text-muted">
          Free to start. No credit card. Your replays stay on your machine;
          only the parsed metadata syncs.
        </p>
        <div className="mt-7 flex flex-wrap items-center gap-3">
          <CtaLink
            href="/sign-up"
            iconRight={<ArrowRight className="h-5 w-5" aria-hidden />}
          >
            Create your account
          </CtaLink>
          <CtaLink
            href="/community"
            variant="secondary"
            iconLeft={<Library className="h-5 w-5" aria-hidden />}
          >
            Browse community builds
          </CtaLink>
        </div>
      </div>
    </section>
  );
}

/* =============================================================== */
/* EDITORIAL HEAD — shared section masthead (folio + kicker + head) */
/* =============================================================== */

interface EditorialHeadProps {
  /** Single-letter section folio printed in the left rail. */
  folio: string;
  kicker: string;
  title: ReactNode;
  standfirst?: string;
}

function EditorialHead({ folio, kicker, title, standfirst }: EditorialHeadProps) {
  return (
    <div className="grid gap-x-10 gap-y-4 lg:grid-cols-12">
      <div className="flex items-start gap-4 lg:col-span-4">
        <span
          aria-hidden
          className="select-none font-serif text-display-lg font-normal leading-[0.8] text-editorial/30"
        >
          {folio}
        </span>
        <p className="kicker pt-2">{kicker}</p>
      </div>
      <div className="lg:col-span-8">
        <hr className="ed-rule mb-5" />
        <h2 className="font-serif text-[32px] font-semibold leading-tight tracking-[-0.01em] text-text md:text-[40px]">
          {title}
        </h2>
        {standfirst ? (
          <p className="mt-3 max-w-2xl text-body-lg text-text-muted">
            {standfirst}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/* =============================================================== */
/* CTA LINK — landing-page-only Button-styled <Link> (squared)      */
/* =============================================================== */

interface CtaLinkProps {
  href: string;
  variant?: "primary" | "secondary";
  size?: "md" | "lg";
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  children: ReactNode;
  className?: string;
}

function CtaLink({
  href,
  variant = "primary",
  size = "lg",
  iconLeft,
  iconRight,
  children,
  className = "",
}: CtaLinkProps) {
  const variantClass =
    variant === "primary"
      ? "bg-accent text-white hover:bg-accent-hover"
      : "bg-bg-elevated text-text border-2 border-line hover:bg-bg-subtle";
  const sizeClass =
    size === "lg"
      ? "h-12 px-5 text-body-lg gap-2.5"
      : "h-10 px-4 text-body gap-2";
  return (
    <Link
      href={href}
      className={[
        "inline-flex min-w-[44px] items-center justify-center rounded-md font-semibold",
        "transition-colors duration-100",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        variantClass,
        sizeClass,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {iconLeft ? <span className="flex-shrink-0">{iconLeft}</span> : null}
      {children}
      {iconRight ? <span className="flex-shrink-0">{iconRight}</span> : null}
    </Link>
  );
}
