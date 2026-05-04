import { StreamingPanel } from "@/components/StreamingPanel";

export const metadata = {
  title: "Streaming · SC2 Tools",
};

export default function StreamingPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Streaming overlay</h1>
        <p className="text-text-muted">
          One URL. Drop it into OBS Browser Source, set width 1920 and
          height 1080. It updates live during your stream.
        </p>
      </header>
      <StreamingPanel />
    </div>
  );
}
