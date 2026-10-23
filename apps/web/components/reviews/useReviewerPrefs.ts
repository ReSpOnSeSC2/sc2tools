"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall, useApi } from "@/lib/clientApi";
import type { ReviewerMe } from "@/lib/reviews";

export function useReviewerPrefs(onChanged?: () => void) {
  const { getToken } = useAuth();
  const me = useApi<ReviewerMe>("/v1/me/reviewer", { revalidateOnFocus: false });
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const toggle = async (key: "leaderboardOptIn" | "weeklyDigest", value: boolean) => {
    if (busy || !me.data) return;
    const prev = me.data;
    setBusy(true); setSaveError(null);
    try {
      await me.mutate({ ...prev, [key]: value }, { revalidate: false });
      const next = await apiCall<ReviewerMe>(getToken, "/v1/me/reviewer", { method: "PATCH", body: JSON.stringify({ [key]: value }) });
      await me.mutate(next, { revalidate: false }); onChanged?.();
    } catch {
      await me.mutate(prev, { revalidate: false }); setSaveError("Couldn't save that setting. Try again.");
    } finally { setBusy(false); }
  };
  return { me, busy, saveError, toggle };
}
