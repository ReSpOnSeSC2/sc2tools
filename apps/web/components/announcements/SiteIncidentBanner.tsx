"use client";
import { useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import useSWR from "swr";
import { apiCall, useApi } from "@/lib/clientApi";
import { useUserSocket } from "@/lib/useUserSocket";
import { Banner, type SiteNotice } from "@/components/ui/Banner";

const readBanner = (path: string) => apiCall<{ banner: SiteNotice | null }>(async () => null, path);
export function SiteIncidentBanner() {
  const [revision, setRevision] = useState("");
  const query = useSWR(`/v1/site/banner${revision ? `?v=${encodeURIComponent(revision)}` : ""}`, readBanner, { refreshInterval: 60000, keepPreviousData: true });
  const { data: me } = useApi<{ onboarding?: { goals?: string[] } }>("/v1/me");
  const pathname = usePathname();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [clockTick, setClockTick] = useState(0);
  const now = Date.now();
  const mutate = query.mutate;
  useUserSocket(useMemo(() => ({ "site:banner": (value: unknown) => { const hash = (value as { hash?: unknown })?.hash; if (typeof hash === "string") setRevision(hash); }, connect: () => { void mutate(); } }), [mutate]));
  const banner = query.data?.banner;
  useEffect(() => {
    if (!banner) return;
    try { setDismissed(localStorage.getItem("sc2tools:notice-dismissed")); } catch { /* Memory-only dismissal still works. */ }
    const deadline = [Date.parse(banner.startsAt), Date.parse(banner.endsAt)].filter((time) => time > Date.now()).sort((a, b) => a - b)[0];
    if (!deadline) return;
    const timer = setTimeout(() => setClockTick((tick) => tick + 1), Math.min(2147483647, deadline - Date.now() + 1)); return () => clearTimeout(timer);
  }, [banner, clockTick]);
  if (!banner || Date.parse(banner.startsAt) > now || Date.parse(banner.endsAt) <= now || banner.audience === "agent"
    || (banner.audience === "stream-studio" && !me?.onboarding?.goals?.includes("stream") && !pathname?.startsWith("/stream-studio"))
    || (banner.audience === "guides" && !me?.onboarding?.goals?.includes("improve") && !pathname?.startsWith("/guides"))
    || (banner.severity !== "critical" && dismissed === banner.hash)) return null;
  return <Banner notice={banner} onDismiss={() => { setDismissed(banner.hash); try { localStorage.setItem("sc2tools:notice-dismissed", banner.hash); } catch { /* Optional browser persistence. */ } }} />;
}
