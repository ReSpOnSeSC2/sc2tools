"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { Share2 } from "lucide-react";
import { Button } from "@/components/ui/Button";

const ShareReportDialog = dynamic(() => import("./ShareReportDialog").then((value) => value.ShareReportDialog));

/** Owner action on the game page's battle report: opens the compose dialog. */
export function ShareReportButton({ gameId }: { gameId: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <Button variant="ghost" size="sm" iconLeft={<Share2 className="h-4 w-4" aria-hidden />} onClick={() => setOpen(true)}>Share report…</Button>
    {open ? <ShareReportDialog gameId={gameId} open={open} onClose={() => setOpen(false)} /> : null}
  </>;
}
