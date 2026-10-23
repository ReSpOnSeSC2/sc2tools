"use client";
import { useState } from "react";
import { useApi } from "@/lib/clientApi";
import { AdminPageHeader } from "../components/AdminPageHeader";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { RequestError } from "@/components/ui/RequestError";
import { AdminPagination } from "../components/AdminPagination";
export default function AdminAuditPage(){
  const [action,setAction]=useState(""),[target,setTarget]=useState(""),[filters,setFilters]=useState({action:"",target:""}),[before,setBefore]=useState<string|null>(null),[stack,setStack]=useState<Array<string|null>>([]);
  const query=new URLSearchParams({...filters,...(before?{before}:{})});
  const swr=useApi<{items:Array<{auditId:string;createdAt:string;actorUserId:string|null;actorKind?:string;action:string;target:string|null;result:Record<string,number|boolean|string>}>;nextBefore:string|null}>(`/v1/admin/audit?${query}`,{keepPreviousData:true});
  return <div className="space-y-4"><AdminPageHeader anchor="audit-log" title="Audit log" description="Admin mutations retained for 400 days."/><details className="text-caption"><summary>How to read this</summary><p>Each row identifies the administrator, action, target, HTTP result and allowlisted counters. Wipes include games deleted. Request bodies, emails and tokens are excluded. Recording is best effort: a missing row does not prove an action never ran.</p></details>
    <form className="flex flex-wrap items-end gap-3" onSubmit={(e)=>{e.preventDefault();setFilters({action,target});setBefore(null);setStack([]);}}><label className="text-caption">Action<Input value={action} onChange={(e)=>setAction(e.target.value)}/></label><label className="text-caption">Target user or job<Input value={target} onChange={(e)=>setTarget(e.target.value)}/></label><Button type="submit" variant="secondary">Filter</Button></form>
    {swr.error?<RequestError error={swr.error} onRetry={()=>swr.mutate()}/>:!swr.data?<p role="status">Loading audit rows…</p>:<><div className="overflow-x-auto" aria-busy={swr.isValidating}><table className="w-full text-left text-caption"><caption className="sr-only">Retained administrator actions</caption><thead><tr>{["When","Admin","Action","Target","Result"].map(h=><th key={h} className="p-2">{h}</th>)}</tr></thead><tbody>{swr.data.items.map(row=><tr key={row.auditId} className="border-t border-border">{[new Date(row.createdAt).toLocaleString(),row.actorUserId||(row.actorKind==="service"?"Service credential":"Anonymized"),row.action,row.target||"—",Object.entries(row.result).map(([k,v])=>`${k}: ${v}`).join(" · ")].map((v,i)=><td key={i} className="max-w-xs break-all p-2">{v}</td>)}</tr>)}</tbody></table>{!swr.data.items.length?<p>No matching audit rows.</p>:null}</div><AdminPagination hasPrev={stack.length>0} hasNext={!!swr.data.nextBefore} onPrev={()=>{setBefore(stack.at(-1)??null);setStack(stack.slice(0,-1));}} onNext={()=>{setStack([...stack,before]);setBefore(swr.data?.nextBefore??null);}} itemCount={swr.data.items.length} label={`${swr.data.items.length} audit rows`} /></>}
  </div>;
}
