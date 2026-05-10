"use client";

import { Card } from "@/components/ui/Card";
import { ModeRunner } from "../ModeRunner";
import { modeById } from "../modes";
import { BadgeGrid } from "../collection/BadgeGrid";
import { CosmeticsShop } from "../collection/CosmeticsShop";
import { useArcadeState } from "../hooks/useArcadeState";

export function CollectionSurface() {
  const { state } = useArcadeState();
  const cards = modeById("builds-as-cards");
  return (
    <div className="space-y-5">
      <Card title="Card binder">
        {cards ? <ModeRunner mode={cards} isDaily={false} /> : null}
      </Card>
      <Card title={`Badges (${Object.keys(state.badges).length} earned)`}>
        <BadgeGrid earned={state.badges} />
      </Card>
      <Card title="Cosmetics shop">
        <CosmeticsShop />
      </Card>
    </div>
  );
}
