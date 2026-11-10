import { StreamReportView } from "@/components/reports/StreamReportView";

export const metadata = { title: "Stream report", description: "Record, MMR, maps, builds and viewer activity for one stream." };
export default async function StreamReportRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <StreamReportView id={id} />;
}
