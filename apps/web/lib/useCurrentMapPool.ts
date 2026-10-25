"use client";

import { useEffect, useState } from "react";
import { currentPool, type PoolMetadata } from "./currentMapPool";

/** Refresh age locally without changing personal-query keys or requesting server work. */
export function useCurrentMapPool(metadata?: PoolMetadata) {
  const [, setMinute] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setMinute((minute) => minute + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return currentPool(metadata);
}
