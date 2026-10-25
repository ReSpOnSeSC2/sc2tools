"use client";
import { usePathname } from "next/navigation";
import { CommunityUnavailable } from "@/components/community/CommunityUnavailable";

/** An uncached detail outage remains recoverable without exposing server errors.
 * Timed data-cache refresh failures retain the prior successful public data. */
export default function CommunityError() {
  const path = usePathname();
  const title = path?.startsWith("/community/builds/") ? "This build is temporarily unavailable"
    : path?.startsWith("/community/authors/") ? "This profile is temporarily unavailable"
      : path?.startsWith("/community/opponents/") ? "Opponent profile temporarily unavailable"
        : "Community builds are temporarily unavailable";
  return <><meta name="robots" content="noindex, nofollow" /><CommunityUnavailable
    title={title} retryHref={path || "/community"} standalone /></>;
}
