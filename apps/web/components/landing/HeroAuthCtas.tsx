"use client";

import type { ReactNode } from "react";
import { useAuth } from "@clerk/nextjs";
import { ArrowRight } from "lucide-react";
import { LinkButton } from "@/components/ui/Button";

const WRAPPING_CTA = "h-auto min-h-12 py-2 text-center";

export function HeroAuthCtas({ children }: { children: ReactNode }) {
  const { isSignedIn } = useAuth();

  // The static landing page can offer visitor actions before Clerk loads.
  return (
    <div className="mt-7 flex min-h-[44px] flex-wrap items-center gap-3">
      {isSignedIn === true ? (
        <>
          <LinkButton href="/app" size="lg" className={WRAPPING_CTA} iconRight={<ArrowRight className="h-5 w-5" aria-hidden />}>
            Open your dashboard
          </LinkButton>
          <LinkButton href="/changelog" variant="secondary" size="lg" className={WRAPPING_CTA}>
            What's new
          </LinkButton>
        </>
      ) : children}
    </div>
  );
}
