"use client";
import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall } from "@/lib/clientApi";
import { Card } from "@/components/ui/Card";
import { Section } from "@/components/ui/Section";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { backupErrorMessage } from "./backupErrors";

const ACTIONS = [{ kind: "opponents", label: "Recount opponent records" }, { kind: "replay-archive", label: "Re-check replay archive" }, { kind: "custom-builds", label: "Re-run custom-build matching" }];
export function DataRepairCard({ onStarted }: { onStarted?: () => Promise<void> }) {
  const { getToken } = useAuth(); const { toast } = useToast(); const [pending, setPending] = useState(""); const [error, setError] = useState("");
  async function repair(kind: string) {
    if (pending) return; setPending(kind); setError("");
    try { await apiCall(getToken, `/v1/me/repair/${kind}`, { method: "POST", body: "{}" }); await onStarted?.().catch(() => {}); toast.success("Repair started", { description: "A snapshot was saved first. Your notification bell will show the result." }); }
    catch (error) { setError(backupErrorMessage(error)); }
    finally { setPending(""); }
  }
  return <Section id="repair-data" className="scroll-mt-28" title="Repair my data" description="Keep your saved games while recalculating derived records. Each repair can run once an hour, with a snapshot taken first."><Card><div className="flex flex-wrap gap-2">{ACTIONS.map((action) => <Button key={action.kind} variant="secondary" loading={pending === action.kind} disabled={Boolean(pending)} onClick={() => void repair(action.kind)}>{action.label}</Button>)}</div>{error ? <p role="alert" className="mt-3 text-body-sm text-danger">{error}</p> : null}<p className="mt-3 text-caption text-text-muted">An archive re-check verifies files already uploaded; missing files still need a desktop Re-sync. <LazyHelpLink slug="repair-my-data">Fixing wrong opponent counts</LazyHelpLink></p></Card></Section>;
}
