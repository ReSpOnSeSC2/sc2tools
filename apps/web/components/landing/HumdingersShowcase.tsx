import Image from "next/image";
import { Gamepad2 } from "lucide-react";
import { buttonClassName } from "@/components/ui/buttonStyles";
import { HUMDINGERS_GAMEPLAY_SHOTS, HUMDINGERS_PATH, HUMDINGERS_SIZE } from "@/lib/humdingers";

/**
 * Features Humdingers, the site owner's browser RPG, right after the hero.
 * Play is a plain anchor, not Next's Link: the game page switches the site
 * shell off and loads a large static file (see isStaticPlayPath). The title
 * screen and two gameplay shots are at the game's exact 2x scale, so they
 * stay crisp with pixelated scaling.
 */
export function HumdingersShowcase() {
  return (
    <section id="humdingers" aria-labelledby="humdingers-heading" className="mt-16 scroll-mt-24 md:mt-20">
      <div className="surface-sheen grid items-center gap-6 overflow-hidden rounded-2xl border border-line bg-bg-surface/70 p-5 shadow-card sm:p-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-10 lg:p-8">
        <div className="min-w-0">
          <p className="hud-label">Free browser RPG</p>
          <h2 id="humdingers-heading" className="mt-2 font-display text-h2 font-bold leading-tight tracking-tight text-text">
            Humdingers
          </h2>
          <p className="mt-3 max-w-prose text-body-lg text-text-muted">
            Besides StarCraft: Brood War and StarCraft II, the only games
            I&rsquo;ve ever been this passionate about are EarthBound on the SNES
            and Mother 3. So I&rsquo;m making a spiritual successor. Worlds 1 and 2
            are playable free in your browser, on phone or desktop.
          </p>
          <a
            href={HUMDINGERS_PATH}
            className={buttonClassName({ size: "lg", className: "mt-6 h-auto min-h-12 max-w-full py-2 text-center" })}
          >
            <Gamepad2 className="h-5 w-5 shrink-0" aria-hidden />
            {/* One flex item, so a narrow phone breaks the line before the size. */}
            <span>Play Humdingers <span className="whitespace-nowrap">({HUMDINGERS_SIZE})</span></span>
          </a>
          <p className="mt-3 text-caption text-text-dim">
            Sign in with a free SC2 Tools account to play. Your saves follow your account. Not affiliated with Nintendo.
          </p>
        </div>
        <div className="grid min-w-0 gap-3">
          <Shot src="/landing/humdingers-title.png" alt="Humdingers title screen" />
          <div className="grid grid-cols-2 gap-3">
            {HUMDINGERS_GAMEPLAY_SHOTS.map((shot) => <Shot key={shot.src} src={shot.src} alt={shot.alt} />)}
          </div>
        </div>
      </div>
    </section>
  );
}

function Shot({ src, alt }: { src: string; alt: string }) {
  return (
    <div className="min-w-0 overflow-hidden rounded-xl border border-line bg-bg-elevated/40 shadow-card">
      <Image src={src} alt={alt} width={768} height={432} unoptimized className="block h-auto w-full [image-rendering:pixelated]" />
    </div>
  );
}
