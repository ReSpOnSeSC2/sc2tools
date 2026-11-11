"use client";

import dynamic from "next/dynamic";

// Only a recognized dedicated source needs the live client. Its canvas is
// transparent until the socket supplies its first widget state.
export const OverlayWidgetSource = dynamic(
  () => import("@/components/OverlayWidgetClient").then(module => module.OverlayWidgetClient),
  { ssr: false },
);
