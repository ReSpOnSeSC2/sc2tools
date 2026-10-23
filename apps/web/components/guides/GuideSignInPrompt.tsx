"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { guideSignInHref } from "./guideAuthLinks";
import { GUIDE_LINK_CLASS } from "./guideUi";

export function GuideSignInPrompt({ hasTimings }: { hasTimings: boolean }) {
  const pathname = usePathname();
  return <p className="text-caption text-text-muted"><Link href={guideSignInHref(pathname)} className={GUIDE_LINK_CLASS}>{hasTimings ? "Sign in to see your own timings next to these" : "Sign in to compare your win rate"}</Link>{hasTimings ? "." : " with this build to the community's."}</p>;
}
