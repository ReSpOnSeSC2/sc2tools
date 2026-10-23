"use client";
import { useAdminAction } from "./useAdminAction";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
export function AdminRoleCard({userId,isAdmin,grantable,onDone}:{userId:string;isAdmin:boolean;grantable:boolean;onDone:()=>void}) {
  const {state,begin,dismiss,run}=useAdminAction(onDone), action=isAdmin?"revoke-admin":"grant-admin";
  return <Card padded><h2 className="text-body font-semibold">Admin access</h2><p className="my-2 text-caption text-text-muted">{isAdmin?"This user is an admin. Your own access, configured admins and the last administrator cannot be revoked.":"Only an existing admin can grant full access to this console."}</p>
    {state.kind==="idle"?<Button disabled={!grantable} variant={isAdmin?"danger":"primary"} onClick={()=>begin(`/v1/admin/users/${encodeURIComponent(userId)}/${action}`)}>{isAdmin?"Revoke admin":"Grant admin"}</Button>:null}
    {state.kind==="done"||state.kind==="error"?<><p role={state.kind==="error"?"alert":"status"} className="mt-2 text-caption">{state.kind==="error"?state.message:"Admin access updated."}</p><Button size="sm" variant="ghost" onClick={dismiss}>Dismiss</Button></>:null}
    <ConfirmDialog open={state.kind==="confirm"||state.kind==="busy"} loading={state.kind==="busy"} onClose={dismiss} onConfirm={()=>void run()} title={isAdmin?"Revoke admin access?":"Grant admin access?"} description={isAdmin?"The user keeps their account and replay data.":"This grants full access to the console."} confirmLabel={isAdmin?"Revoke admin":"Grant admin"} />
  </Card>;
}
