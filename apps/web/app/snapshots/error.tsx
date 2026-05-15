"use client";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6 lg:px-8">
      <div className="rounded-xl border border-danger/30 bg-danger/5 p-6">
        <h1 className="text-h3 font-semibold text-text">
          Snapshot analysis failed to load
        </h1>
        <p className="mt-2 text-body text-text-muted">
          {error.message || "Something went wrong on our side."}
        </p>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={() => reset()}
            className="btn"
          >
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}
