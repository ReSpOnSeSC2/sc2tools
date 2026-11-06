import type { ReactNode } from "react";
import { GuideFreshness } from "@/components/guides/GuideFreshness";
import { fetchGuideRevision } from "@/lib/guides/revision";

export default async function GuidesLayout({ children }: { children: ReactNode }) {
  const revision = await fetchGuideRevision();
  return (
    <>
      <GuideFreshness initialRevision={revision} />
      {children}
    </>
  );
}
