import Link from "next/link";
import { Crosshair, MessageSquareText, ShieldCheck, type LucideIcon } from "lucide-react";
import { buttonClassName } from "@/components/ui/buttonStyles";
import { signInHref, signUpHref } from "@/lib/authLinks";

/**
 * "How the Review Exchange works" for a signed-out visitor on /reviews:
 * three steps and the way in. Reading reviews is open to everyone;
 * asking and answering need a free account (your synced games are what
 * you ask about, and what verifies your league). Server-component safe.
 */

const STEPS: ReadonlyArray<{ icon: LucideIcon; title: string; body: string }> = [
  {
    icon: MessageSquareText,
    title: "Ask about a moment",
    body: "Open one of your synced 1v1 games and ask a question, like “Why did my push at 7:30 fail?”.",
  },
  {
    icon: Crosshair,
    title: "Get answers on the replay",
    body: "Reviewers pin each comment to an exact moment on the replay timeline and the map.",
  },
  {
    icon: ShieldCheck,
    title: "Know who is answering",
    body: "Every reviewer's league is checked against their own synced games, never self-reported.",
  },
];

export function ReviewExchangeIntro() {
  return (
    <section
      aria-labelledby="review-exchange-how"
      className="rounded-xl border-2 border-line bg-bg-surface p-4 shadow-hard sm:p-5"
    >
      <h2 id="review-exchange-how" className="text-h4 font-bold text-text">
        How the Review Exchange works
      </h2>
      <ol className="mt-4 grid gap-4 md:grid-cols-3">
        {STEPS.map(({ icon: StepIcon, title, body }, index) => (
          <li key={title} className="flex gap-3">
            <span
              aria-hidden
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 border-line bg-accent/15 text-accent"
            >
              <StepIcon className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <p className="text-body font-semibold text-text">
                <span className="sr-only">Step {index + 1}: </span>
                {title}
              </p>
              <p className="text-caption text-text-muted">{body}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-5 flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-caption text-text-muted">
          Reading reviews is free for everyone. Asking and answering need a free account.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Link href={signUpHref("/reviews")} className={buttonClassName({ variant: "primary", size: "sm" })}>
            Create a free account
          </Link>
          <Link href={signInHref("/reviews")} className={buttonClassName({ variant: "secondary", size: "sm" })}>
            Sign in
          </Link>
        </div>
      </div>
    </section>
  );
}
