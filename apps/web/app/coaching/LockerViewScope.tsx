import type { ReactNode } from "react";
import { SWRConfig } from "swr";

const isolatedCache = { provider: () => new Map() };

/** The keyed mount owns its private responses for the life of this Locker view. */
export function LockerViewScope({ children }: { children: ReactNode }) {
  return <SWRConfig value={isolatedCache}>{children}</SWRConfig>;
}
