import { apiFetch } from "@/lib/api";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { DesignGallery } from "./DesignGallery";
import { GalleryRetry } from "./GalleryRetry";

/** The API's account role is authoritative; client metadata and shell visibility
 * cannot grant access. Every failure leaves the gallery unmounted. */
export async function AuthorizedGallery() {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // apiFetch obtains auth and the JWT before fetch; its signal alone cannot
    // bound that wait. The local race also covers token and response-body work.
    const result = await Promise.race([
      apiFetch<{ isAdmin?: boolean }>("/v1/me", { signal: controller.signal }),
      new Promise<null>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, 5000); }),
    ]);
    if (!result) return <GalleryAccess denied={false} />;
    if (result.ok && result.data?.isAdmin === true) return <DesignGallery />;
    return <GalleryAccess denied={result.ok || result.status === 401 || result.status === 403} />;
  } catch {
    return <GalleryAccess denied={false} />;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
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
