"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { useApi } from "@/lib/clientApi";
import { Modal } from "@/components/ui/Modal";
import { QueryState } from "@/components/ui/QueryState";
import type { CustomBuild } from "./types";

const PublishPickerModal = dynamic(() => import("./PublishPickerModal").then((module) => module.PublishPickerModal));

/** Consume shareable intents once; the open dialog then owns its own state. */
export function BuildPublishIntent({ onChoose, onCreate }: { onChoose: (build: CustomBuild) => void; onCreate: () => void }) {
  const params = useSearchParams(); const router = useRouter();
  const query = params.toString(); const intent = params.get("publish");
  const handled = useRef<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [directSlug, setDirectSlug] = useState<string | null>(null);
  useEffect(() => {
    if (intent === null) { handled.current = null; return; }
    if (handled.current === query) return;
    handled.current = query;
    if (intent === "1") { setDirectSlug(null); setPickerOpen(true); }
    else if (/^[A-Za-z0-9._-]{1,80}$/.test(intent)) { setPickerOpen(false); setDirectSlug(intent); }
    const next = new URLSearchParams(query); next.delete("publish");
    router.replace(`/builds${next.size ? `?${next}` : ""}`, { scroll: false });
  }, [intent, query, router]);
  return <>
    {pickerOpen ? <PublishPickerModal onClose={() => setPickerOpen(false)} onCreate={onCreate} onChoose={(build) => { setPickerOpen(false); onChoose(build); }} /> : null}
    {directSlug ? <DirectPublication key={directSlug} slug={directSlug} onClose={() => setDirectSlug(null)} onChoose={(build) => { setDirectSlug(null); onChoose(build); }} /> : null}
  </>;
}

function DirectPublication({ slug, onClose, onChoose }: { slug: string; onClose: () => void; onChoose: (build: CustomBuild) => void }) {
  const query = useApi<CustomBuild>(`/v1/custom-builds/${encodeURIComponent(slug)}`);
  const selected = useRef(false);
  useEffect(() => {
    if (!query.data || query.isPreviousData || selected.current) return;
    selected.current = true; onChoose(query.data);
  }, [query.data, query.isPreviousData, onChoose]);
  return <Modal open onClose={onClose} title="Open build to publish" size="md"><QueryState q={query} errorTitle="This build could not be opened" /></Modal>;
}
