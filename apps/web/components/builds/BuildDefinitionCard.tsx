"use client";

import { Pencil } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { CommunityBuildSignatureTimeline } from "@/components/community/CommunityBuildSignatureTimeline";
import { coerceSavedRules, SKILL_LEVELS } from "@/lib/build-rules";
import { RulesSummary } from "./RulesSummary";
import type { CustomBuild } from "./types";

/** Read authored rules and strategy notes beside the owner's private notes. */
export function BuildDefinitionCard({ build, onEdit }: { build: CustomBuild; onEdit: () => void }) {
  const rules = coerceSavedRules(build.rules);
  const signature = Array.isArray(build.signature) ? build.signature : [];
  const rows = [
    { label: "Wins by", items: build.winConditions ?? [] },
    { label: "Loses to", items: build.losesTo ?? [] },
    { label: "Transitions into", items: build.transitionsInto ?? [] },
  ].filter((row) => row.items.length > 0);
  if (!rules.length && !signature.length && !rows.length) return null;
  const skill = SKILL_LEVELS.find((level) => level.id === build.skillLevel);
  const edit = <Button variant="ghost" size="sm" onClick={onEdit} aria-label="Edit build definition" iconLeft={<Pencil className="h-4 w-4" aria-hidden />}>Edit</Button>;
  const strategy = <div className="space-y-3">{rows.map((row) => <div key={row.label}><h3 className="mb-1 text-caption font-semibold text-text-muted">{row.label}</h3><ul className="flex flex-wrap gap-2">{row.items.map((item, index) => <li key={`${index}-${item}`}><Badge variant="neutral" className="max-w-full whitespace-normal break-words">{item}</Badge></li>)}</ul></div>)}{skill ? <p className="flex flex-wrap items-center gap-2 text-caption text-text-muted">Skill level <Badge variant="neutral">{skill.label}</Badge></p> : null}</div>;
  return rules.length ? <RulesSummary rules={rules} title="Build definition" actions={edit}>{strategy}</RulesSummary> : <Card title="Build definition" headingLevel={2} right={edit}><div className="space-y-4">{signature.length ? <CommunityBuildSignatureTimeline signature={signature} /> : null}{strategy}</div></Card>;
}
