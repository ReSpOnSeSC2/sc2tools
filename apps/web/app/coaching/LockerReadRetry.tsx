import { Button } from "@/components/ui/Button";

export function LockerReadRetry({ retry, retrying }: { retry: () => Promise<unknown>; retrying?: boolean }) {
  return <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 p-3">
    <p role="status" className="text-caption">The Locker could not refresh. Try again to save changes.</p>
    <Button type="button" variant="secondary" size="sm" loading={retrying} onClick={() => void retry()}>Retry Locker</Button>
  </div>;
}
