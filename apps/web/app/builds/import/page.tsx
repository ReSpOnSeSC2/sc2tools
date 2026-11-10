import { Suspense } from "react";
import { BuildsLibrary } from "@/components/builds/BuildsLibrary";

// A shared build arrives as /builds/import#code=…: the code stays in the
// URL fragment (never sent to the server), and the library opens its
// Import dialog with it.
export const metadata = {
  title: "Import a build",
  robots: { index: false, follow: false },
};

export default function BuildImportPage() {
  return (
    <div className="space-y-6">
      <Suspense fallback={<p role="status">Loading build library…</p>}><BuildsLibrary /></Suspense>
    </div>
  );
}
