/**
 * Next.js client instrumentation hook (runs once, before the app
 * hydrates). Boots Sentry when NEXT_PUBLIC_SENTRY_DSN is set; a no-op
 * otherwise, so local dev and DSN-less deploys pay zero cost.
 */
import { initClientSentry } from "@/lib/sentry";

void initClientSentry();
