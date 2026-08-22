import { notFound, redirect } from "next/navigation";
import { SectionPanel } from "@/components/analyzer/SectionPanel";
import { tabForSlug } from "@/components/analyzer/tabs";

/**
 * /app/[section] — one route per analyzer section (strategies, trends,
 * macro, maps, builds, arcade). Opponents has dedicated routes at
 * /app/opponents so each dossier gets a URL of its own.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  const tab = tabForSlug(section);
  if (!tab) return { title: "SC2 Tools" };
  return {
    title: `${tab.label} · SC2 Tools`,
    description: tab.description,
  };
}

export default async function SectionRoute({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  const tab = tabForSlug(section);
  if (!tab) notFound();
  // /app/opponents is a static route with its own pages; a dynamic hit
  // here (e.g. a manually typed variant) still lands somewhere sensible.
  if (tab.id === "opponents") redirect("/app/opponents");

  return <SectionPanel tab={tab.id} />;
}
