import { Suspense } from "react";
import { SessionsPage } from "@/components/sessions/SessionsPage";

export const metadata = { title: "Sessions", description: "Review your complete ladder sessions." };
export default function SessionsRoute() {
  return <Suspense fallback={<p role="status">Loading session history…</p>}><SessionsPage /></Suspense>;
}
