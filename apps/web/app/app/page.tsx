import { apiFetch } from "@/lib/api";
import { DashboardLayout } from "@/components/dashboard/DashboardLayout";
import { Card } from "@/components/ui/Card";

type Me = {
  userId: string;
  source: string;
  games: { total: number; latest: string | null };
};

export default async function AnalyzerHome() {
  const meRes = await apiFetch<Me>("/v1/me");

  if (!meRes.ok) {
    return (
      <Card padded>
        <h1 className="mb-2 text-h2 font-semibold">Dashboard</h1>
        <p className="text-danger">
          Could not reach the API ({meRes.status} {meRes.error}). Check
          NEXT_PUBLIC_API_BASE in your env, and that the API server is
          running.
        </p>
      </Card>
    );
  }

  return <DashboardLayout me={meRes.data} />;
}
