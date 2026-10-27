import { Suspense } from "react";
import { SessionDetail } from "@/components/sessions/SessionDetail";

export const metadata = { title: "Session report", description: "Review the recorded games and account ratings in one session." };
export default async function SessionReportRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Suspense fallback={<p role="status">Loading session report…</p>}><SessionDetail id={id} /></Suspense>;
}
