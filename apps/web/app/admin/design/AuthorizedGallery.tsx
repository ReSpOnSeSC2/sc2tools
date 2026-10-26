import { apiFetch } from "@/lib/api";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { DesignGallery } from "./DesignGallery";
import { GalleryRetry } from "./GalleryRetry";

/** The API's account role is authoritative; client metadata and shell visibility
 * cannot grant access. Every failure leaves the gallery unmounted. */
export async function AuthorizedGallery() {
  try {
    const result = await apiFetch<{ isAdmin?: boolean }>("/v1/me", { signal: AbortSignal.timeout(5000) });
    if (result.ok && result.data?.isAdmin === true) return <DesignGallery />;
    return <GalleryAccess denied={result.ok || result.status === 401 || result.status === 403} />;
  } catch {
    return <GalleryAccess denied={false} />;
  }
}

function GalleryAccess({ denied }: { denied: boolean }) {
  return <div className="space-y-5"><PageHeader title={denied ? "Design gallery is admin only" : "Gallery access could not be checked"} /><Card padded>
    <p className="mb-4 text-body text-text-muted">{denied
      ? "Sign in with an administrator account to view these examples."
      : "The access check is temporarily unavailable. Try again to check your account."}</p>
    <GalleryRetry />
  </Card></div>;
}
