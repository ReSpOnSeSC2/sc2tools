"use client";

import dynamic from "next/dynamic";
import { Card } from "@/components/ui/Card";

export const LazyImportProgressCard = dynamic(
  () => import("./ImportProgressCard").then(module => module.ImportProgressCard),
  { loading: () => <Card><p role="status" className="text-caption text-text-muted">Loading import progress…</p></Card> },
);
