"use client";
import { AdminPageHeader } from "../components/AdminPageHeader";
import { AdminActionCard } from "../components/AdminActionCard";
import { useApi } from "@/lib/clientApi";
export default function AdminToolsPage() {
  const me = useApi<{userId:string;email?:string|null;games?:{total:number}}>("/v1/me");
  return <div className="space-y-6"><AdminPageHeader anchor="users-and-repairing-data" title="Tools" description="Resolve the account, review what is kept, and confirm each data repair." />
    <div className="grid gap-4 lg:grid-cols-2">{me.data ? <AdminActionCard action="rebuild-opponents" title="Fix my counters" user={{userId:me.data.userId,email:me.data.email||null,gameCount:me.data.games?.total||0}} /> : null}<AdminActionCard action="rebuild-opponents" /></div><AdminActionCard action="wipe-games" />
  </div>;
}
