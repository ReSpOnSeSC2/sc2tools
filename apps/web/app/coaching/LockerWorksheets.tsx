"use client";

import { useAuth } from "@clerk/nextjs";
import { LockerWorksheetsPanel } from "./LockerWorksheetsPanel";
import { LockerViewScope } from "./LockerViewScope";
import { useLockerView } from "./useLockerView";

type Props = { viewerRole: "admin" | "coach" | "student"; memberId: string | null };

export default function LockerWorksheets(props: Props) {
  const { userId } = useAuth();
  return userId ? <LockerViewScope key={JSON.stringify([userId, props.viewerRole, props.memberId])}>
    <Worksheets accountId={userId} {...props} />
  </LockerViewScope> : null;
}

function Worksheets({ accountId, viewerRole, memberId }: Props & { accountId: string }) {
  const locker = useLockerView(accountId, "worksheets", viewerRole, memberId);
  return <LockerWorksheetsPanel accountId={accountId} role={viewerRole} memberId={memberId} locker={locker} />;
}
