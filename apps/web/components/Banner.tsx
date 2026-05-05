import fs from "fs";
import path from "path";
import Image from "next/image";

/**
 * SC2 Tools branded banner.
 *
 * Asset resolution:
 *   - The wide artwork at `apps/web/public/banner.png` is preferred for
 *     the hero variant. Drop the file in and the layout switches.
 *   - Until that file exists, the hero falls back to a composed layout
 *     that pairs the round shield logo (`/logo.png`) with the
 *     "SC2TOOLS" wordmark + tech-grid accent stripes.
 *   - The "divider" variant always uses the round logo.
 *
 * All cyan / purple glow values flow through CSS variables defined in
 * app/globals.css (--halo-cyan, --halo-accent, --accent-cyan). Phase 17
 * migrated this module off raw RGB literals so the banner adapts to
 * both light and dark themes.
 */

type BannerVariant = "hero" | "divider";

const BANNER_REL_PATH = "banner.png";
const LOGO_PATH = "/logo.png";

export function Banner({ variant = "hero" }: { variant?: BannerVariant }) {
  if (variant === "divider") return <DividerBanner />;
  return <HeroBanner />;
}

function bannerExists(): boolean {
  try {
    return fs.existsSync(
      path.join(process.cwd(), "public", BANNER_REL_PATH),
    );
  } catch {
    return false;
  }
}

function HeroBanner() {
  const useWideArt = bannerExists();
  return (
    <div className="relative my-2 overflow-hidden rounded-xl border border-accent/30 bg-bg-elevated/40 shadow-halo-accent">
      <div
        className="pointer-events-none absolute inset-0 animate-halo-pulse-soft"
        style={{
          background:
            "radial-gradient(ellipse at center, var(--halo-cyan) 0%, transparent 65%)",
        }}
        aria-hidden
      />
      <div className="relative">
        {useWideArt ? <WideArt /> : <ComposedBanner />}
      </div>
    </div>
  );
}

function WideArt() {
  return (
    <Image
      src={`/${BANNER_REL_PATH}`}
      alt="SC2 Tools"
      width={2000}
      height={800}
      priority
      className="block h-auto w-full"
    />
  );
}

/**
 * Fallback layout used when banner.png isn't on disk: the round logo
 * left, the "SC2TOOLS" wordmark right, with tech-grid accent stripes.
 */
function ComposedBanner() {
  return (
    <div className="relative flex items-center gap-6 px-6 py-8 md:gap-10 md:px-10 md:py-12">
      <div className="relative flex-shrink-0">
        <div
          className="absolute inset-0 -z-10 rounded-full blur-2xl"
          style={{
            background:
              "radial-gradient(circle at center, rgb(var(--accent-cyan) / 0.5) 0%, transparent 70%)",
          }}
          aria-hidden
        />
        <Image
          src={LOGO_PATH}
          alt="SC2 Tools logo"
          width={140}
          height={140}
          priority
          className="rounded-full md:h-[180px] md:w-[180px]"
        />
      </div>
      <div className="min-w-0 flex-1">
        <AccentStripes />
        <h1
          className="font-mono text-4xl font-extrabold tracking-[0.18em] text-accent-cyan md:text-6xl"
          style={{
            textShadow:
              "0 0 18px rgb(var(--accent-cyan) / 0.55), 0 0 2px rgb(var(--text) / 0.4)",
          }}
        >
          SC2TOOLS
        </h1>
        <AccentStripes mirrored />
      </div>
    </div>
  );
}

function AccentStripes({ mirrored = false }: { mirrored?: boolean }) {
  return (
    <div
      className={`flex items-center gap-2 ${mirrored ? "mt-3" : "mb-3"}`}
      aria-hidden
    >
      <span className="h-[3px] w-12 bg-accent/80 shadow-halo-accent" />
      <span className="h-[3px] w-6 bg-accent/60" />
      <span className="h-[3px] w-3 bg-accent/40" />
    </div>
  );
}

function DividerBanner() {
  return (
    <div
      className="relative my-12 flex items-center gap-4"
      role="presentation"
      aria-hidden
    >
      <span className="h-px flex-1 bg-gradient-to-r from-transparent via-accent/60 to-accent/80" />
      <Image
        src={LOGO_PATH}
        alt=""
        width={56}
        height={56}
        className="flex-shrink-0 rounded-full opacity-90 shadow-halo-cyan"
      />
      <span className="h-px flex-1 bg-gradient-to-l from-transparent via-accent/60 to-accent/80" />
    </div>
  );
}
