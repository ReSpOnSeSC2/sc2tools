"use client";
import { useApi } from "@/lib/clientApi";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { RequestError } from "@/components/ui/RequestError";
import { AdminDate } from "./AdminDate";
type Snapshot = { devices:Array<{deviceId:string;hostname?:string;os?:string;version?:string;lastSeenAt:string|null;online:boolean}>; doctor:{ok:boolean;warnings:Array<{id:string;message:string}>}; replayArchive:{totalGames:number;archivedGames:number;missingGames:number}; imports:Array<{jobId:string;status:string;completed?:number;failed?:number}>;audit:Array<{auditId:string;action:string;createdAt:string;result:Record<string,number|boolean>}> };
export function SupportSnapshot({userId}:{userId:string}) {
  const swr=useApi<Snapshot>(`/v1/admin/users/${encodeURIComponent(userId)}/support`);
  return <Card padded><div className="flex items-center justify-between gap-3"><h2 className="text-h3">Support snapshot</h2><Button size="sm" variant="ghost" loading={swr.isValidating} onClick={()=>void swr.mutate()}>Refresh</Button></div>
    {swr.error?<RequestError error={swr.error} onRetry={()=>swr.mutate()} />:!swr.data?<p role="status">Loading support snapshot…</p>:<div className="mt-3 grid gap-4 md:grid-cols-2"><section><h3 className="font-semibold">Devices</h3>{swr.data.devices.length?swr.data.devices.map((d)=><p key={d.deviceId} className="text-caption [overflow-wrap:anywhere]">{d.hostname||"Unnamed device"} · {d.os||"Platform unknown"} · {d.version||"Version unknown"} · {d.online?"Online":"Offline"} · Last seen <AdminDate value={d.lastSeenAt} /></p>):<p className="text-caption">No active devices</p>}</section>
      <section><h3 className="font-semibold">Doctor</h3>{swr.data.doctor.warnings.length?swr.data.doctor.warnings.map((w)=><p key={w.id} className="text-caption">{w.message}</p>):<p className="text-caption">No diagnostic warnings</p>}</section>
      <section><h3 className="font-semibold">Replay archive</h3><p className="text-caption">{swr.data.replayArchive.archivedGames} archived · {swr.data.replayArchive.missingGames} missing · {swr.data.replayArchive.totalGames} total</p></section>
      <section><h3 className="font-semibold">Last 5 imports</h3>{swr.data.imports.length?swr.data.imports.map((job)=><p key={job.jobId} className="text-caption">{job.status} · {job.completed??0} completed · {job.failed??0} failed</p>):<p className="text-caption">No import jobs</p>}</section>
      <section className="md:col-span-2"><h3 className="font-semibold">Recent audit activity</h3>{swr.data.audit.length?swr.data.audit.map((a)=><p key={a.auditId} className="text-caption">{a.action} · <AdminDate value={a.createdAt} /></p>):<p className="text-caption">No retained audit rows</p>}</section></div>}
  </Card>;
}
