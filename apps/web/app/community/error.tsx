"use client";
import { usePathname } from "next/navigation";
import { CommunityUnavailable } from "@/components/community/CommunityUnavailable";

/** Cold/outage renders remain recoverable. Throwing from the server detail
 * page lets ISR keep its last good render rather than caching this fallback. */
export default function CommunityError() {
  const path = usePathname();
  return <><meta name="robots" content="noindex, nofollow" /><CommunityUnavailable
    title="Community is temporarily unavailable" retryHref={path || "/community"} standalone /></>;
}
