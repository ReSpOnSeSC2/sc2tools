"use client";

import { useEffect, useState } from "react";

export function useVetoCountdown(deadline: number | null, serverTime: number, receivedAt: number) {
  const [now, setNow] = useState(receivedAt);
  useEffect(() => {
    if (deadline === null) return;
    const refresh = () => setNow(Date.now());
    refresh();
    const timer = setInterval(refresh, 250);
    return () => clearInterval(timer);
  }, [deadline, receivedAt]);
  return deadline === null ? null : Math.max(0, Math.ceil((deadline - serverTime - Math.max(0, now - receivedAt)) / 1000));
}
