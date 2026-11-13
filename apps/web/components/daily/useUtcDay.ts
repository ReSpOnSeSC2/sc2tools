"use client";

import { useEffect, useState } from "react";
import { DAY_MS, utcDay } from "@/lib/daily/rules";

export function useUtcDay(): number | null {
  const [day, setDay] = useState<number | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const sync = () => {
      clearTimeout(timer);
      const now = Date.now(), current = utcDay(now);
      setDay(current);
      timer = setTimeout(sync, (current + 1) * DAY_MS - now + 25);
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);
  return day;
}
