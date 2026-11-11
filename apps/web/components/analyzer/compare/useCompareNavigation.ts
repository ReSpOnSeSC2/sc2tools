"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/lib/clientApi";
import { compareHref, compareReferenceRequest, COMPARE_REFERENCES_PATH, type CompareReferences } from "@/lib/compareGameLinks";
import { isPublicReplayReference } from "@/lib/replayRouteAccess";

const ACTION_ONLY = { isPaused: () => true } as const;

export function useCompareNavigation() {
  const { request } = useApi(COMPARE_REFERENCES_PATH, ACTION_ONLY, { timeoutMs: 8000 });
  const router = useRouter();
  const pending = useRef(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function compare(a: string, b: string, onSuccess?: () => void) {
    if (pending.current) return;
    pending.current = true;
    setLoading(true);
    setError(null);
    try {
      const { references: [left, right] } = await request<CompareReferences>(compareReferenceRequest([a, b]));
      if (!left || !right || !isPublicReplayReference(left) || !isPublicReplayReference(right)) {
        setError("One of these games is no longer in your synced history.");
        return;
      }
      onSuccess?.();
      router.push(compareHref(left, right));
    } catch {
      setError("Couldn't open this comparison. Try again.");
    } finally {
      pending.current = false;
      setLoading(false);
    }
  }

  return { compare, loading, error };
}
