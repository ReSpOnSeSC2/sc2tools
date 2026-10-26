"use client";

import { AuthContextLink } from "@/components/auth/AuthContextLink";
import { usePathname } from "next/navigation";
import { GUIDE_LINK_CLASS } from "./guideUi";

export function GuideSignInPrompt({ hasTimings }: { hasTimings: boolean }) {
  const pathname = usePathname();
  return <p className="text-caption text-text-muted"><AuthContextLink kind="sign-in" returnTo={pathname} className={GUIDE_LINK_CLASS}>{hasTimings ? "Sign in to see your own timings next to these" : "Sign in to compare your win rate"}</AuthContextLink>{hasTimings ? "." : " with this build to the community's."}</p>;
}
