import { describe, expect, it } from "vitest";
import { ALL_MODES } from "@/components/analyzer/arcade/modes";
import { ALL_WIDGETS } from "@/components/overlay/widgetLifecycle";
import { PRODUCT_FACTS } from "@/lib/productFacts";
import { STREAM_BACKGROUNDS } from "@/lib/streamBackgrounds";

describe("landing product facts", () => {
  it("matches the feature registries", () => {
    expect(PRODUCT_FACTS.overlayWidgets).toBe(ALL_WIDGETS.length);
    expect(PRODUCT_FACTS.arcadeModes).toBe(ALL_MODES.length);
    expect(PRODUCT_FACTS.virtualSets).toBe(STREAM_BACKGROUNDS.length);
  });
});
