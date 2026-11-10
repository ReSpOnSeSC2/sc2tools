import { StreamReportsList } from "@/components/reports/StreamReportsList";

export const metadata = { title: "Stream reports", description: "A report for every stream you ended in the Dock." };
export default function StreamReportsRoute() {
  return <StreamReportsList />;
}
