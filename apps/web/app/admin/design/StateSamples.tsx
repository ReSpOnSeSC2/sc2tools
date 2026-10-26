"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card, type CardVariant } from "@/components/ui/Card";
import { DeviceFrame } from "@/components/ui/DeviceFrame";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { GlowHalo } from "@/components/ui/GlowHalo";
import { Icon } from "@/components/ui/Icon";
import { Input } from "@/components/ui/Input";
import { QueryState } from "@/components/ui/QueryState";
import { SaveBar } from "@/components/ui/SaveBar";
import { SectionBoundary } from "@/components/ui/SectionBoundary";
import { Select } from "@/components/ui/Select";
import { SkeletonBar, SkeletonCard, SkeletonChart, SkeletonKpi, SkeletonPageHeader, SkeletonRegion, SkeletonRows } from "@/components/ui/Skeleton";
import { StatCard } from "@/components/ui/Stat";
import { useDirtyForm } from "@/components/ui/useDirtyForm";

const cardVariants: CardVariant[] = ["default", "elevated", "feature", "interactive"];

export function StateSamples() {
  return <div className="space-y-5">
    <div className="grid gap-5 sm:grid-cols-2">{cardVariants.map(variant => <Card key={variant} variant={variant} title={`Card · ${variant}`} headingLevel={3} padded><p className="text-caption text-text-muted">Example surface, with a heading and padded content.</p></Card>)}</div>
    <div className="grid gap-4 sm:grid-cols-3"><StatCard label="Example wins" value="12" hint="Synthetic sample · 20 games" trend="up" trendLabel="Example increase" /><StatCard label="Example losses" value="8" size="sm" trend="down" trendLabel="Example decrease" /><StatCard label="Unknown statistic" value="—" size="lg" hint="No recorded value" trend="flat" /></div>
    <div className="grid gap-5 xl:grid-cols-2"><Card title="QueryState, RequestError and EmptyState" headingLevel={3} padded><QuerySamples /></Card><Card title="SaveBar and useDirtyForm" headingLevel={3} padded><SaveSample /></Card></div>
    <Card title="Skeleton family" headingLevel={3} padded><div className="grid gap-5 sm:grid-cols-2">
      <SkeletonRegion label="Example page header loading"><SkeletonPageHeader /></SkeletonRegion>
      <SkeletonRegion label="Example card loading"><SkeletonCard><SkeletonBar className="h-4 w-32" /></SkeletonCard></SkeletonRegion>
      <SkeletonRows rows={2} label="Example rows loading" /><SkeletonKpi label="Example statistic loading" /><SkeletonChart label="Example chart loading" />
    </div></Card>
    <SectionBoundary label="the gallery content example"><Card title="DeviceFrame, GlowHalo and Icon" headingLevel={3} padded>
      <p className="mb-4 text-caption text-text-muted">SectionBoundary protects this example. Decorative effects do not replace a label or a recorded value.</p>
      <div className="grid items-start gap-5 lg:grid-cols-3">{(["browser", "app", "phone"] as const).map(variant => <DeviceFrame key={variant} variant={variant} title={`${variant} example`}><div className="relative isolate overflow-hidden p-5"><GlowHalo /><div className="relative flex items-center gap-3"><Icon name="Probe" decorative /><span className="text-caption">Example {variant} content</span></div></div></DeviceFrame>)}</div>
    </Card></SectionBoundary>
  </div>;
}

function QuerySamples() {
  const [state, setState] = useState("loading");
  const ready = state === "ready" || state === "previous";
  const data = ready ? ["Example replay"] : state === "empty" ? [] : undefined;
  return <div className="space-y-4">
    <Field label="Query example state"><Select value={state} onChange={event => setState(event.target.value)}>{["loading", "empty", "error", "ready", "previous"].map(value => <option key={value}>{value}</option>)}</Select></Field>
    <QueryState q={{ data, error: state === "error" ? { status: 503, message: "Synthetic unavailable example" } : undefined, isPreviousData: state === "previous", mutate: () => setState("ready") }}
      skeleton={<SkeletonRows rows={2} label="Example query loading" />} isEmpty={rows => rows.length === 0}
      empty={<EmptyStatePanel title="No example results" description="This is the empty preview state." action={<Button variant="secondary" onClick={() => setState("ready")}>Load example</Button>} />}>
      {(rows, status) => <p className="text-caption">{rows[0]}{status.isPreviousData ? " · Showing the previous example while updating" : " · Ready preview"}</p>}
    </QueryState>
  </div>;
}

function SaveSample() {
  const [savedValue, setSavedValue] = useState("Original example");
  const form = useDirtyForm(savedValue, "Original example");
  const [saved, setSaved] = useState(false);
  return <div className="space-y-4">
    <Field label="Local draft example" hint="Edit this value to show the shared SaveBar. Nothing is sent to the server."><Input value={form.draft} onChange={event => { form.setDraft(event.target.value); setSaved(false); }} /></Field>
    <p role="status" className="text-caption">{saved ? "Example saved locally in this preview." : form.dirty ? "Preview has unsaved changes." : "Preview has no unsaved changes."}</p>
    <SaveBar visible={form.dirty} disableUnloadGuard stackOnMobile message="Unsaved gallery example" saveLabel="Save example" resetLabel="Reset example" onSave={() => { setSavedValue(form.draft); form.markSaved(); setSaved(true); }} onReset={() => { form.reset(); setSaved(false); }} />
  </div>;
}
