import { renderPublicOgImage } from "@/components/guides/og/PublicOgCard";
import { REPORT_CARD_METADATA } from "@/lib/instant/reportCardMetadata";
import { reportCardClass, reportCardParams } from "@/lib/instant/reportCardRoute";

export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return reportCardParams();
}

export async function GET(_request: Request, { params }: { params: Promise<{ type: string; class: string }> }) {
  const segments = await params;
  const cardClass = reportCardClass(segments.type, segments.class);
  if (!cardClass) return new Response(null, { status: 404 });
  return renderPublicOgImage({ ...REPORT_CARD_METADATA[cardClass], stats: [], steps: [] });
}
