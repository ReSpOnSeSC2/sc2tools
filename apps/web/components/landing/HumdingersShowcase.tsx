import Image from "next/image";
import { Gamepad2 } from "lucide-react";
import { buttonClassName } from "@/components/ui/buttonStyles";
import { HUMDINGERS_PATH, HUMDINGERS_SIZE } from "@/lib/humdingers";

/**
 * Features Humdingers, the site owner's browser RPG, right after the hero.
 * Play is a plain anchor, not Next's Link, because the game is one large
 * static page (see isStaticPlayPath). The screenshot is the title screen at
 * the game's exact 2x scale, so it stays crisp with pixelated scaling.
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
            Besides StarCraft, the only games I&rsquo;ve ever been this passionate
            about are EarthBound on the SNES and Mother 3. So I&rsquo;m making a
            spiritual successor. Worlds 1 and 2 are playable free in your
            browser, on phone or desktop.
          </p>
          <a
            href={HUMDINGERS_PATH}
            className={buttonClassName({ size: "lg", className: "mt-6 h-auto min-h-12 max-w-full py-2 text-center" })}
          >
            <Gamepad2 className="h-5 w-5 shrink-0" aria-hidden />
            {/* One flex item, so a narrow phone breaks the line before the size. */}
            <span>Play Humdingers <span className="whitespace-nowrap">({HUMDINGERS_SIZE})</span></span>
          </a>
          <p className="mt-3 text-caption text-text-dim">Not affiliated with Nintendo.</p>
        </div>
        <div className="min-w-0 overflow-hidden rounded-xl border border-line bg-bg-elevated/40 shadow-card">
          <Image
            src="/landing/humdingers-title.png"
            alt="Humdingers title screen"
            width={768}
            height={432}
            unoptimized
            className="block h-auto w-full [image-rendering:pixelated]"
          />
        </div>
      </div>
    </section>
  );
}
