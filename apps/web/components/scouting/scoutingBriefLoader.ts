import { boundedApiRequest } from "@/lib/clientApi";

/** One optional import per explicit attempt. A held chunk cannot hide Retry forever. */
export function loadScoutingBriefCard() {
  return boundedApiRequest(() => import("./ScoutingBriefCard").then(module => ({ default: module.ScoutingBriefCard })), 15_000);
}
