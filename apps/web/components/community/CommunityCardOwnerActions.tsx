"use client";

import dynamic from "next/dynamic";
import { useOwnerBuilds } from "./useOwnerBuilds";

const OwnerControls = dynamic(() => import("./CommunityBuildOwnerControls").then((module) => module.CommunityBuildOwnerControls), { ssr: false });
const ReplayCount = dynamic(() => import("./CommunityOwnerReplayCount").then((module) => module.CommunityOwnerReplayCount), { ssr: false });

/** Load private card controls only after the owner's publication list confirms this build. */
export function CommunityCardOwnerActions({ slug, title }: { slug: string; title: string }) {
  const { data } = useOwnerBuilds();
  if (!data?.items.some((item) => item.slug === slug)) return null;
  return <><OwnerControls slug={slug} title={title} compact /><ReplayCount publicSlug={slug} /></>;
}
