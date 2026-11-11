"use client";

import { useApi } from "@/lib/clientApi";
import { useUserSocket } from "@/lib/useUserSocket";
import type { AdminAttentionResp } from "./adminTypes";

export function useAdminAttention(ownsRefresh = false) {
  const attention = useApi<AdminAttentionResp>("/v1/admin/attention", {
    refreshInterval: ownsRefresh ? 60_000 : 0,
    onErrorRetry: (error, _key, _config, retry, context) => {
      if (error.status === 401 || error.status === 403 || context.retryCount >= 3) return;
      setTimeout(() => retry({ retryCount: context.retryCount }), 5000);
    },
  });
  const refresh = () => { void attention.mutate(); };
  useUserSocket(ownsRefresh ? { "admin:event": refresh, connect: refresh } : null);
  return attention;
}
