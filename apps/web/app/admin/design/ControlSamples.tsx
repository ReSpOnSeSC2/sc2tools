"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { Badge, type BadgeVariant } from "@/components/ui/Badge";
import { Button, LinkButton, type ButtonVariant } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { IconButton } from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Select } from "@/components/ui/Select";
import { Tabs } from "@/components/ui/Tabs";
import { Toggle } from "@/components/ui/Toggle";

const variants: ButtonVariant[] = ["primary", "secondary", "ghost", "danger"];
const badges: BadgeVariant[] = ["neutral", "accent", "cyan", "signal", "success", "warning", "danger"];

export function ControlSamples() {
  const [added, setAdded] = useState(0);
  return <div className="grid min-w-0 gap-5 xl:grid-cols-2">
    <Card title="Button, LinkButton and IconButton" headingLevel={3} padded>
      <div className="space-y-4">
        {variants.map(variant => <div key={variant} className="flex flex-wrap items-center gap-3">
          <Button variant={variant}>{variant}</Button><Button variant={variant} disabled>{variant} disabled</Button>
        </div>)}
        <div className="flex flex-wrap items-center gap-3"><Button size="sm">Small</Button><Button>Medium</Button><Button size="lg">Large</Button><Button loading>Loading example</Button></div>
        <div className="flex flex-wrap items-center gap-3"><LinkButton href="#gallery-states" variant="secondary">Link to states</LinkButton><IconButton aria-label="Add example" onClick={() => setAdded(value => value + 1)}><Plus className="h-5 w-5" /></IconButton><IconButton aria-label="Disabled add example" disabled><Plus className="h-5 w-5" /></IconButton></div>
        <p role="status" className="text-caption">{added ? `${added} local ${added === 1 ? "example" : "examples"} added.` : ""}</p>
      </div>
    </Card>
    <Card title="Field, Input and Select" headingLevel={3} padded><InputSamples /></Card>
    <Card title="Toggle, SegmentedControl and Tabs" headingLevel={3} padded><SelectionSamples /></Card>
    <Card title="Badge variants" headingLevel={3} padded><div className="flex flex-wrap items-center gap-3">{badges.map(variant => <Badge key={variant} variant={variant}>{variant}</Badge>)}<Badge size="sm">Small badge</Badge></div></Card>
  </div>;
}

function InputSamples() {
  return <div className="space-y-4">
    <Field label="Example name" hint="A hint associated with its control."><Input placeholder="Type an example" /></Field>
    <Field label="Invalid example" error="Enter an example name."><Input defaultValue="" /></Field>
    <Field label="Disabled example"><Input disabled defaultValue="Unavailable example" /></Field>
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Example select"><Select defaultValue="first"><option value="first">First example</option><option value="second">Second example</option></Select></Field>
      <Field label="Invalid select" error="Choose an example."><Select defaultValue=""><option value="">Choose…</option><option value="first">First example</option></Select></Field>
    </div>
    <Field label="Disabled select"><Select disabled><option>Unavailable example</option></Select></Field>
    <div className="grid gap-3 sm:grid-cols-2"><Field label="Small input"><Input inputSize="sm" /></Field><Field label="Large input"><Input inputSize="lg" /></Field></div>
  </div>;
}

function SelectionSamples() {
  const [enabled, setEnabled] = useState(false);
  const [segment, setSegment] = useState("all");
  const [tab, setTab] = useState("first");
  return <div className="space-y-5">
    <div className="flex flex-wrap items-center gap-3"><Toggle label="Enable example" checked={enabled} onChange={setEnabled} /><span className="text-caption">Example {enabled ? "on" : "off"}</span><Toggle label="Disabled off example" disabled checked={false} onChange={() => undefined} /><Toggle label="Disabled on example" disabled checked onChange={() => undefined} /></div>
    <SegmentedControl label="Example matchup" value={segment} onChange={setSegment} options={[{ value: "all", label: "All" }, { value: "p", label: "vs P", ariaLabel: "versus Protoss" }, { value: "t", label: "vs T", ariaLabel: "versus Terran" }]} />
    <Tabs value={tab} onValueChange={setTab}><Tabs.List ariaLabel="Example tabs"><Tabs.Trigger value="first">First</Tabs.Trigger><Tabs.Trigger value="second">Second</Tabs.Trigger></Tabs.List><Tabs.Content value="first"><p className="pt-3 text-caption">First example panel.</p></Tabs.Content><Tabs.Content value="second"><p className="pt-3 text-caption">Second example panel.</p></Tabs.Content></Tabs>
  </div>;
}
