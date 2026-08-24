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
  Shield,
  Swords,
  Tv,
  Users,
  Wand2,
} from "lucide-react";
import { Banner } from "@/components/Banner";
import {
  HeroCarousel,
  type HeroCarouselSlide,
} from "@/components/landing/HeroCarousel";
import { InstallPrompt } from "@/components/pwa/InstallPrompt";
import { RealGameShowcase } from "@/components/landing/RealGameShowcase";
import { ReplayDemo } from "@/components/landing/ReplayDemo";
import {
  PracticePreview,
  ReplayTheaterPreview,
  StreamStudioPreview,
  VirtualSetStrip,
} from "@/components/landing/ProductShowcases";
import { PRODUCT_FACTS } from "@/lib/productFacts";

export function LandingPageContent() {
  return (
    <>
      <LandingMasthead />
      <LandingHero />
      <RealGameShowcase />
      <OutcomeRail />
      <ImprovementChapter />
      <PracticeChapter />
      <StreamChapter />
      <IncludedChapter />
      <ReplaySection />
      <LandingHowItWorks />
      <MobileInstallSection />
      <SupportTeaser />
      <LandingFinalCta />
    </>
  );
}

/* =============================================================== */
/* CURRENT LANDING — one product story across Analyze / Practice /  */
/* Stream, with real and clearly-labelled illustrative examples.     */
/* =============================================================== */

function LandingMasthead() {
  return (
    <header className="border-y border-border-strong">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-3">
        <span className="kicker">SC2 Tools</span>
        <span className="font-mono text-caption text-text-dim">
          Analyze · Practice · Stream
        </span>
      </div>
    </header>
  );
}

function LandingHero() {
  return (
    <section className="pt-10 md:pt-16">
      <div className="grid items-start gap-x-10 gap-y-10 lg:grid-cols-12">
        <div className="lg:col-span-5 lg:pr-2">
          <p className="kicker">The complete StarCraft II companion</p>
          <h1 className="mt-5 font-serif text-[44px] font-semibold leading-[1.02] tracking-[-0.01em] text-text md:text-[60px]">
            Built for ladder players,{" "}
            <em className="font-serif italic text-editorial">by ladder players.</em>
          </h1>
          <p className="drop-initial mt-6 max-w-prose text-body-lg text-text-muted">
            Play normally. SC2 Tools reads every replay, reconstructs the
            match, learns the opponents you face, coaches the builds you
            practise, and powers a complete stream production suite.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <CtaLink
              href="/download"
              iconLeft={<Download className="h-5 w-5" aria-hidden />}
              iconRight={<ArrowRight className="h-5 w-5" aria-hidden />}
            >
              Download the free agent
            </CtaLink>
            <CtaLink href="#replay-demo" variant="secondary">
              Try a replay
            </CtaLink>
          </div>
          <LandingTrustStrip />
        </div>
        <div className="lg:col-span-7">
          <LandingCarousel />
        </div>
      </div>
    </section>
  );
}

function LandingCarousel() {
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

  return <HeroCarousel slides={slides} ariaLabel="SC2 Tools product highlights" />;
}

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
    id: "peek-overlay-live",
    eyebrow: "Live in OBS",
    title: "Broadcast-ready overlays — copy and paste",
    body: `${PRODUCT_FACTS.overlayWidgets} widgets behind one URL. Add it as a Browser Source and your stream is ready.`,
    imageSrc: "/landing/overlay-live.png",
    imageAlt:
      "StarCraft II gameplay with the SC2 Tools live OBS overlay showing opponent identity, session record, and rematch status",
  },
  {
    id: "peek-overlay-rematch",
    eyebrow: "Know the rematch",
    title: "Familiar-opponent intel, on stream",
    body: "See your record against this player, the openings they favour, and what happened the last time you met.",
    imageSrc: "/landing/overlay-rematch.png",
    imageAlt:
      "SC2 Tools rematch overlay showing opponent MMR, familiar-opponent status, and recent games",
  },
  {
    id: "peek-build-editor",
    eyebrow: "Build your playbook",
    title: "Save any replay as a custom build",
    body: "Promote the moments that define the opening and your replay history reclassifies safely in the background.",
    imageSrc: "/landing/build-editor.png",
    imageAlt:
      "SC2 Tools custom build editor with a replay timeline and one-click rule controls",
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

const LANDING_TRUST = [
  { icon: Shield, label: "Free to start" },
  { icon: Wand2, label: "No manual tagging" },
  { icon: Cloud, label: "Private cloud sync" },
  { icon: Tv, label: "Built for OBS" },
] as const;

function LandingTrustStrip() {
  return (
    <ul className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border pt-4 text-text-muted">
      {LANDING_TRUST.map(({ icon: Icon, label }) => (
        <li key={label} className="flex items-center gap-1.5 text-caption">
          <Icon className="h-4 w-4 text-editorial" aria-hidden />
          <span>{label}</span>
        </li>
      ))}
    </ul>
  );
}

const OUTCOMES = [
  {
    href: "#analyze",
    num: "01",
    kicker: "Analyze",
    title: "See the match you actually played.",
    body: "3D replay theater, opponent dossiers, Skill Fingerprints, trends, maps, macro and loss analysis.",
    icon: BarChart3,
  },
  {
    href: "#practice",
    num: "02",
    kicker: "Practice",
    title: "Turn plans into repeatable timings.",
    body: "Ghost Build coaching, custom build rules, community builds, Build Roulette and replay-powered Arcade modes.",
    icon: Swords,
  },
  {
    href: "#stream",
    num: "03",
    kicker: "Stream",
    title: "Run the whole show from one dock.",
    body: `${PRODUCT_FACTS.overlayWidgets} OBS widgets, four-platform chat, official alerts, scenes, B-roll, goals, polls and clips.`,
    icon: Tv,
  },
] as const;

function OutcomeRail() {
  return (
    <nav aria-label="Explore SC2 Tools features" className="mt-16 border-y border-border-strong md:mt-20">
      <div className="grid gap-px bg-border md:grid-cols-3">
        {OUTCOMES.map(({ href, num, kicker, title, body, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className="group bg-bg px-5 py-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent sm:px-6"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="font-serif text-h3 text-editorial/60">{num}</span>
              <Icon className="h-5 w-5 text-accent-cyan" aria-hidden />
            </div>
            <p className="kicker mt-5">{kicker}</p>
            <p className="mt-2 font-serif text-h4 font-semibold text-text group-hover:text-editorial">{title}</p>
            <p className="mt-2 text-caption text-text-muted">{body}</p>
            <span className="mt-4 inline-flex items-center gap-1.5 text-caption font-semibold text-accent-cyan">
              Explore {kicker.toLowerCase()} <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </span>
          </Link>
        ))}
      </div>
    </nav>
  );
}

function ImprovementChapter() {
  return (
    <section id="analyze" className="scroll-mt-24 pt-24 md:pt-32">
      <EditorialHead
        folio="A"
        kicker="Analyze"
        title="Watch the whole match unfold—not just the final score."
        standfirst="Replay Theatre reconstructs the game on the real map with 3D units, fog, exact spell casts, terrain-following paths, production rails, music and fullscreen controls—then keeps the original replay ready in your private vault."
      />
      <div className="mt-10">
        <ReplayTheaterPreview />
      </div>
      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <ChapterNote title="One opponent, every identity" body="Name changes, alternate characters and revealed barcodes stay in one dossier with a complete head-to-head history." />
        <ChapterNote title="Review from anywhere" body="Original .SC2Replay files archive privately, with downloads and timestamped Twitch or YouTube VOD jumps." />
        <ChapterNote title="Filters that answer real questions" body="Game length, map, matchup, build and MMR bands follow every relevant chart instead of resetting between views." />
      </div>
    </section>
  );
}

function ChapterNote({ title, body }: { title: string; body: string }) {
  return (
    <div className="border-t-2 border-line pt-4">
      <p className="font-serif text-h4 font-semibold text-text">{title}</p>
      <p className="mt-2 text-caption text-text-muted">{body}</p>
    </div>
  );
}

function PracticeChapter() {
  return (
    <section id="practice" className="scroll-mt-24 pt-24 md:pt-32">
      <EditorialHead
        folio="B"
        kicker="Practice"
        title="Build-order practice that stays with you in game."
        standfirst="Save any replay as a reusable build, define the moments that make it yours, and let your history reclassify in the background. Ghost Build keeps the next timing visible—or reads it aloud—while you play."
      />
      <div className="mt-10">
        <PracticePreview />
      </div>
      <ArcadeStrip />
    </section>
  );
}

const ARCADE_ICONS = [
  { src: "/arcade/icons/buildle.png", label: "Buildle" },
  { src: "/arcade/icons/macro-memory.png", label: "Macro Memory" },
  { src: "/arcade/icons/bingo-ladder.png", label: "Ladder Bingo" },
  { src: "/arcade/icons/stock-market.png", label: "Build Stock Market" },
  { src: "/arcade/icons/rivalry-ranker.png", label: "Rivalry Ranker" },
] as const;

function ArcadeStrip() {
  return (
    <div className="mt-8 grid gap-6 border-y border-border py-6 lg:grid-cols-[1fr_auto] lg:items-center">
      <div>
        <p className="kicker">Arcade · {PRODUCT_FACTS.arcadeModes} modes</p>
        <h3 className="mt-2 font-serif text-h3 font-semibold text-text">Your replay history, turned into daily challenges.</h3>
        <p className="mt-2 max-w-2xl text-caption text-text-muted">Quizzes, streak hunts, weekly bingo, build portfolios, score cards and season recaps—made from games you actually played.</p>
      </div>
      <ul className="flex flex-wrap gap-2" aria-label="Example Arcade modes">
        {ARCADE_ICONS.map((item) => (
          <li key={item.label} title={item.label} className="flex h-12 w-12 items-center justify-center rounded-md border border-editorial/30 bg-editorial/10">
            <Image src={item.src} alt="" width={32} height={32} className="h-8 w-8" unoptimized />
            <span className="sr-only">{item.label}</span>
          </li>
        ))}
        <li className="flex h-12 min-w-12 items-center justify-center rounded-md border border-border bg-bg-elevated px-3 text-caption font-bold text-text-muted">+{PRODUCT_FACTS.arcadeModes - ARCADE_ICONS.length}</li>
      </ul>
    </div>
  );
}

function StreamChapter() {
  return (
    <section id="stream" className="scroll-mt-24 pt-24 md:pt-32">
      <EditorialHead
        folio="C"
        kicker="Stream Studio"
        title="From queue screen to highlight reel, without leaving OBS."
        standfirst="Merge Twitch, Kick, YouTube and TikTok chat; connect official creator accounts for follows, subs, gifts, rewards, cheers and raids; then run scenes, polls, alerts, viewer counts and clip markers from the Stream Dock."
      />
      <div className="mt-10">
        <StreamStudioPreview />
      </div>
      <div className="mt-8">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="kicker">Built-in virtual sets</p>
            <h3 className="mt-2 font-serif text-h3 font-semibold text-text">Seven broadcast backdrops, ready at 1080p and 4K.</h3>
          </div>
          <p className="max-w-md text-caption text-text-muted">One-click OBS layouts, automatic scene switching, and synchronized landscape or portrait B-roll keep every canvas in step.</p>
        </div>
        <VirtualSetStrip />
      </div>
    </section>
  );
}

const INCLUDED_GROUPS = [
  {
    title: "Analyze",
    stat: `${PRODUCT_FACTS.knownBuilds}+ detected openings`,
    icon: BarChart3,
    items: [
      "3D map replay with spells, paths, fog and fullscreen",
      "Opponent identity grouping and head-to-head dossiers",
      `Matchup-specific Skill Fingerprint across ${PRODUCT_FACTS.fingerprintArchetypes} archetypes`,
      "MMR, playtime, map, macro, composition and loss analysis",
      "Global game-length and ladder filters",
      "Private replay archive, downloads and VOD seek links",
    ],
  },
  {
    title: "Practice",
    stat: `${PRODUCT_FACTS.arcadeModes} replay-powered Arcade modes`,
    icon: Gamepad2,
    items: [
      "Ghost Build visual and voice coach",
      "Custom rules with durable background reclassification",
      "Build Roulette plus one- or two-unit Gateway rolls",
      "Named or anonymous Community publishing",
      "Map-veto help, daily challenges and season recaps",
      "Touch-friendly army, cost and upgrade inspection",
    ],
  },
  {
    title: "Stream",
    stat: `${PRODUCT_FACTS.overlayWidgets} copy-and-paste OBS widgets`,
    icon: Tv,
    items: [
      "Unified Twitch, Kick, YouTube and TikTok chat",
      "Official follows, subs, gifts, rewards, cheers and raids",
      "Stream Dock with live viewers, polls, scenes and clip flags",
      "Automatic scene switching and one-click OBS layouts",
      `${PRODUCT_FACTS.virtualSets} virtual sets with synchronized B-roll`,
      "TTS, chat bot, goals, ticker, countdown and VOD timestamps",
    ],
  },
] as const;

function IncludedChapter() {
  return (
    <section className="pt-24 md:pt-32">
      <EditorialHead
        folio="D"
        kicker="Everything included"
        title="One replay pipeline. A whole ladder toolkit."
        standfirst="The headline features are only the start. Everything below ships in the same free product and stays fed by the same automatic replay sync."
      />
      <div className="mt-10 grid gap-6 lg:grid-cols-3">
        {INCLUDED_GROUPS.map(({ title, stat, icon: Icon, items }) => (
          <article key={title} className="rounded-md border-2 border-line bg-bg-surface p-5 shadow-hard sm:p-6">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="kicker">{title}</p>
                <p className="mt-2 text-caption font-semibold text-text">{stat}</p>
              </div>
              <Icon className="h-6 w-6 text-accent-cyan" aria-hidden />
            </div>
            <ul className="mt-5 space-y-3">
              {items.map((item) => (
                <li key={item} className="flex gap-2.5 text-caption text-text-muted">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </section>
  );
}

function LandingHowItWorks() {
  return (
    <section className="mt-24 md:mt-32">
      <EditorialHead
        folio="E"
        kicker="Getting started"
        title="Install once. Then just play."
      />
      <div className="mt-10 grid gap-x-10 gap-y-10 md:grid-cols-3">
        {[
          { num: "01", title: "Install the agent", body: "Sign in and install the small Windows agent. Setup takes about a minute." },
          { num: "02", title: "Play normally", body: "Every finished replay is read, classified and synced automatically in the background." },
          { num: "03", title: "Review, practise, stream", body: "Your dashboard, coaching views and OBS sources update between games." },
        ].map((step) => (
          <div key={step.num} className="border-t-2 border-line pt-5">
            <span className="block font-serif text-display-lg font-normal leading-none text-editorial">{step.num}</span>
            <h3 className="mt-4 font-serif text-h3 font-semibold text-text">{step.title}</h3>
            <p className="mt-2 text-body text-text-muted">{step.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function SupportTeaser() {
  return (
    <section className="mt-20 border-y border-border py-8">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="max-w-2xl">
          <p className="kicker">Free and community-supported</p>
          <h2 className="mt-2 font-serif text-h3 font-semibold text-text">No paywall between you and your replays.</h2>
          <p className="mt-2 text-caption text-text-muted">SC2 Tools publishes its real infrastructure costs and keeps support optional.</p>
        </div>
        <CtaLink href="/donate" variant="secondary" size="md">See costs or chip in</CtaLink>
      </div>
    </section>
  );
}

function LandingFinalCta() {
  return (
    <section className="mt-20 md:mt-24">
      <div className="rounded-md border-2 border-accent bg-bg-surface px-6 py-12 shadow-hard md:px-12 md:py-16">
        <p className="kicker">Ready for the next game?</p>
        <h2 className="mt-4 max-w-3xl font-serif text-[40px] font-semibold leading-[1.04] tracking-[-0.01em] text-text md:text-display-lg">
          Your replay already has the answers.{" "}
          <em className="font-serif italic text-editorial">Put them to work.</em>
        </h2>
        <p className="mt-5 max-w-2xl text-body-lg text-text-muted">Free to start, no card needed. Sync privately across devices and add OBS whenever you are ready.</p>
        <div className="mt-7 flex flex-wrap items-center gap-3">
          <CtaLink href="/download" iconLeft={<Download className="h-5 w-5" aria-hidden />} iconRight={<ArrowRight className="h-5 w-5" aria-hidden />}>Download the agent</CtaLink>
          <CtaLink href="/community" variant="secondary" iconLeft={<Users className="h-5 w-5" aria-hidden />}>Browse community builds</CtaLink>
        </div>
      </div>
    </section>
  );
}

function ReplaySection() {
  return (
    <section id="replay-demo" className="scroll-mt-24 mt-24 md:mt-32">
      <ReplayDemo />
    </section>
  );
}

function MobileInstallSection() {
  return (
    <section className="relative mt-24 md:hidden">
      <InstallPrompt />
    </section>
  );
}

interface EditorialHeadProps {
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
      ? "bg-accent text-white hover:brightness-90"
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
