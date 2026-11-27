import Image from "next/image";
import { ArrowRight, Gamepad2 } from "lucide-react";
import { HUMDINGERS_GAMEPLAY_SHOTS, HUMDINGERS_PATH, HUMDINGERS_SIZE } from "@/lib/humdingers";

/**
 * Links Humdingers, the site owner's browser RPG, above the Arcade tabs. It
 * is not an Arcade mode (modes are built from your replays; see README.md),
 * and it is a plain anchor because the game page loads a large static file.
 * The gameplay thumbnails sit beside the text, or under it on a phone.
 */
export function HumdingersCard() {
  return (
    <a
      href={HUMDINGERS_PATH}
      className="group flex flex-wrap items-center gap-3 rounded-xl border border-line bg-bg-surface/70 p-3 transition-colors hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-bg-elevated text-accent-cyan">
        <Gamepad2 className="h-5 w-5" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-body font-semibold text-text">Play Humdingers</span>
        <span className="block text-caption text-text-muted">
          The RPG I&rsquo;m making, a spiritual successor to EarthBound and Mother 3. Free in your browser, {HUMDINGERS_SIZE}.
        </span>
      </span>
      <ArrowRight className="h-4 w-4 shrink-0 text-text-dim motion-safe:transition-transform group-hover:translate-x-0.5 sm:order-last" aria-hidden />
      <span className="flex w-full gap-2 sm:w-auto">
        {HUMDINGERS_GAMEPLAY_SHOTS.map((shot) => (
          <Image key={shot.src} src={shot.src} alt="" width={768} height={432} unoptimized
            className="block h-auto min-w-0 flex-1 rounded-md border border-line [image-rendering:pixelated] sm:w-28 sm:flex-none" />
        ))}
      </span>
    </a>
  );
}
