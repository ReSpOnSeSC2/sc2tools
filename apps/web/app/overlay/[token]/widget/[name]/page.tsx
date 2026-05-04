import { OverlayWidgetClient } from "@/components/OverlayWidgetClient";

export const metadata = {
  title: "Live overlay widget",
  robots: { index: false, follow: false },
};

const VALID_WIDGETS = new Set([
  "opponent",
  "match-result",
  "post-game",
  "mmr-delta",
  "streak",
  "cheese",
  "rematch",
  "rival",
  "rank",
  "meta",
  "topbuilds",
  "fav-opening",
  "best-answer",
  "scouting",
  "session",
]);

export default async function OverlayWidgetPage({
  params,
}: {
  params: Promise<{ token: string; name: string }>;
}) {
  const { token, name } = await params;
  const widget = VALID_WIDGETS.has(name) ? name : null;
  if (!widget) {
    return (
      <div
        style={{
          fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
          color: "#ff6b6b",
          padding: 16,
        }}
      >
        Unknown widget &quot;{name}&quot;. Valid: {[...VALID_WIDGETS].join(", ")}
      </div>
    );
  }
  return <OverlayWidgetClient token={token} widget={widget} />;
}
