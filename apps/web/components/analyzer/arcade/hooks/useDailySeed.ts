"use client";

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { dailySeed, mulberry32, todayKey } from "../ArcadeEngine";

/**
 * useDailySeed — returns the user's IANA tz, today's day key, and a
 * memoised mulberry32 stream seeded by (userId, day). Re-keys when the
 * day rolls over so the Today surface auto-rotates without a refresh.
 */
export function useDailySeed() {
  const { userId } = useAuth();
  const tz = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    [],
  );
  // Tick once a minute so day rollover happens within ~60s.
  const [day, setDay] = useState(() => todayKey(new Date(), tz));
  useEffect(() => {
    const id = setInterval(() => {
      const next = todayKey(new Date(), tz);
      setDay((prev) => (prev === next ? prev : next));
    }, 60_000);
    return () => clearInterval(id);
  }, [tz]);

  const rng = useMemo(() => {
    const seed = dailySeed(userId || "anonymous", day);
    return mulberry32(seed);
  }, [userId, day]);

  return { tz, day, rng, userId: userId || "anonymous" };
}
