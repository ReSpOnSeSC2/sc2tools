import Image from "next/image";
import Link from "next/link";
import { BookOpen, Library, Lock, Users } from "lucide-react";
import { HelpLink } from "@/components/help/HelpLink";
import { GlowHalo } from "@/components/ui/GlowHalo";
import { PageHeader } from "@/components/ui/PageHeader";
import { buttonClassName } from "@/components/ui/buttonStyles";
import { signInHref, signUpHref } from "@/lib/authLinks";

/**
 * What /builds shows a signed-out visitor: what custom builds do, how
 * they work, and the way in (create an account or sign in, both
 * returning here), plus the public build pages they can use right now.
 * The library itself, and its New build / Reclassify actions, need an
 * account, so none of them render here.
 *
 * No hooks, so it can move into the server-rendered page as is.
 */

const STEPS: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "Save an opener",
    body: "Open any game's build order and click Save as new build, or write the rules yourself, like “Stargate before 4:00”.",
  },
  {
    title: "Your replays get matched",
    body: "Every game you upload is checked against your rules and tagged with the build you played. Older replays are matched too.",
  },
  {
    title: "See what works",
    body: "Each build shows its win rate by matchup, its recent games and how those games usually play out.",
  },
];

export function BuildsPublicIntro({ returnTo = "/builds" }: { returnTo?: string }) {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Custom builds"
        title="Your own build library"
        description="Describe the openers you play once. Every replay you upload is matched to them automatically, with win rates for each build and matchup."
      />

      <section
        aria-labelledby="builds-intro-how"
        className="relative overflow-hidden rounded-2xl border-2 border-line bg-bg-surface p-5 shadow-hard sm:p-8"
      >
        <GlowHalo color="cyan" position="top" opacity={0.6} size={70} />
        <div className="relative grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:items-center">
          <div className="space-y-6">
            <div className="space-y-4">
              <h2 id="builds-intro-how" className="text-h3 font-bold text-text">
                How custom builds work
              </h2>
              <ol className="space-y-4">
                {STEPS.map((step, index) => (
                  <li key={step.title} className="flex gap-3">
                    <span
                      aria-hidden
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 border-line bg-accent/15 font-display text-caption font-bold text-accent"
                    >
                      {index + 1}
                    </span>
                    <div className="min-w-0">
                      <p className="text-body font-semibold text-text">{step.title}</p>
                      <p className="text-caption text-text-muted">{step.body}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>

            <div className="space-y-3 rounded-xl border-2 border-line bg-bg-elevated/60 p-4">
              <h3 className="text-body font-bold text-text">Sign up to start your library</h3>
              <p className="flex items-start gap-2 text-caption text-text-muted">
                <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <span>
                  Your build library needs a free account, and your builds stay
                  private unless you publish one. Community builds and
                  Definitions are public.{" "}
                  <HelpLink slug="a-page-asked-me-to-sign-in">Which pages are public?</HelpLink>
                </span>
              </p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Link href={signUpHref(returnTo)} className={buttonClassName({ variant: "primary" })}>
                  Create account
                </Link>
                <Link href={signInHref(returnTo)} className={buttonClassName({ variant: "secondary" })}>
                  Sign in
                </Link>
              </div>
            </div>

            <nav aria-label="Public build pages" className="flex flex-wrap gap-x-5 gap-y-2">
              <Link
                href="/community"
                className="inline-flex min-h-[44px] items-center gap-2 rounded-sm text-body font-semibold text-accent-cyan underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <Users className="h-4 w-4" aria-hidden />
                Browse community builds
              </Link>
              <Link
                href="/definitions"
                className="inline-flex min-h-[44px] items-center gap-2 rounded-sm text-body font-semibold text-accent-cyan underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <BookOpen className="h-4 w-4" aria-hidden />
                Build definitions
              </Link>
            </nav>
          </div>

          <figure className="space-y-2">
            <div className="overflow-hidden rounded-xl border-2 border-line bg-bg-elevated/40">
              <Image
                src="/landing/build-editor.png"
                alt="The SC2 Tools build editor: a replay's build order on one side, the rules you pick from it on the other"
                width={1848}
                height={952}
                sizes="(min-width: 1024px) 50vw, 100vw"
                className="block h-auto w-full"
              />
            </div>
            <figcaption className="flex items-center gap-1.5 text-caption text-text-dim">
              <Library className="h-3.5 w-3.5 shrink-0" aria-hidden />
              Pick the steps that define your opener straight from a replay.
            </figcaption>
          </figure>
        </div>
      </section>
    </div>
  );
}
