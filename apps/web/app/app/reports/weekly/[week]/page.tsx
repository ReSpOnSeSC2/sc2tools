import { WeeklyReportView } from "@/components/reports/WeeklyReportView";

export const metadata = { title: "Weekly report", description: "Your week in numbers next to the week before." };
export default async function WeeklyReportRoute({ params }: { params: Promise<{ week: string }> }) {
  const { week } = await params;
  return <WeeklyReportView week={week} />;
}
