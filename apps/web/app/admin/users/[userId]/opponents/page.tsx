"use client";
import { Suspense, use } from "react";
import Link from "next/link";
import { AdminPageHeader } from "../../../components/AdminPageHeader";
import { AdminPlayersList } from "../../../components/AdminPlayersList";
import { LoadingRows } from "../../../components/AdminFragments";
type Props = { params: Promise<{ userId: string }> };
function OpponentsBody({ params }: Props) {
  const { userId } = use(params);
  return <div className="space-y-6"><AdminPageHeader anchor="users-and-repairing-data" title="Opponents" description="Inspect the opponents recorded for this account." actions={<Link href={`/admin/users/${encodeURIComponent(userId)}`} className="text-caption text-text-muted">← User detail</Link>} /><AdminPlayersList userId={userId} /></div>;
}
export default function AdminUserOpponentsPage(props: Props) { return <Suspense fallback={<LoadingRows rows={8} />}><OpponentsBody {...props} /></Suspense>; }
