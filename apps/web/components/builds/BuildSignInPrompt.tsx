import Link from "next/link";
import { Lock, Users } from "lucide-react";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { buttonClassName } from "@/components/ui/buttonStyles";
import { signInHref, signUpHref } from "@/lib/authLinks";

/**
 * What /builds/<slug> shows a signed-out visitor. A custom build is
 * private to the account that saved it, so the only honest answer is
 * "sign in": both buttons come back to this build afterwards, and the
 * public community builds are one click away.
 */
export function BuildSignInPrompt({ slug }: { slug: string }) {
  const returnTo = `/builds/${encodeURIComponent(slug)}`;
  return (
    <section className="rounded-2xl border-2 border-line bg-bg-surface px-4 shadow-hard sm:px-6">
      <EmptyStatePanel
        size="lg"
        icon={<Lock className="h-6 w-6" aria-hidden />}
        title={<h1 className="text-h3 font-bold text-text">Sign in to open this build</h1>}
        description="Custom builds are private to the account that saved them. Sign in with that account to see this one."
        action={
          <div className="flex flex-col items-center gap-4">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Link href={signInHref(returnTo)} className={buttonClassName({ variant: "primary" })}>
                Sign in
              </Link>
              <Link href={signUpHref(returnTo)} className={buttonClassName({ variant: "secondary" })}>
                Create account
              </Link>
            </div>
            <Link
              href="/community"
              className="inline-flex min-h-[44px] items-center gap-2 rounded-sm text-body font-semibold text-accent-cyan underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <Users className="h-4 w-4" aria-hidden />
              Browse community builds
            </Link>
          </div>
        }
      />
    </section>
  );
}
