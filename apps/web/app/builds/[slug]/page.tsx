import type { Metadata } from "next";
import { BuildDetailView } from "@/components/builds/BuildDetailView";

interface BuildDetailPageProps {
  params: Promise<{ slug: string }>;
}

// A private library page: the server never knows the build's name (the
// slug is only a URL key), so the title is generic ("Custom build · SC2
// Tools" through the root template) and the page is never indexed.
// BuildDetailView sets "<name> · Custom build · SC2 Tools" once it loads.
export const metadata: Metadata = {
  title: "Custom build",
  robots: { index: false, follow: false },
};

export default async function BuildDetailPage({ params }: BuildDetailPageProps) {
  const { slug } = await params;
  return <BuildDetailView slug={slug} />;
}
