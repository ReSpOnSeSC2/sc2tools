import type { Metadata } from "next";
import { BuildDetailView } from "@/components/builds/BuildDetailView";

interface BuildDetailPageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({
  params,
}: BuildDetailPageProps): Promise<Metadata> {
  const { slug } = await params;
  return {
    title: `${decodeURIComponent(slug)} · Custom build · SC2 Tools`,
  };
}

export default async function BuildDetailPage({ params }: BuildDetailPageProps) {
  const { slug } = await params;
  return <BuildDetailView slug={slug} />;
}
