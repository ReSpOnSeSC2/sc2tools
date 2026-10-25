# 0032: Lazy dossier analysis with explicit sampled history

Status: accepted, 2026-10-25.

The dossier already computed detailed timings and phase data but did not display them. Hydrating up to 100 replay details for its first screen also occupied the shared analysis admission gate before users reached those sections.

Clerk web requests to the ordinary profile route now read metadata only. A separate private, no-store analysis route acquires the existing admission gate before any reads and releases it after the entire bounded analysis. One lazy SWR resource supplies timings, compositions, phases and transitions. The native source can request the same endpoint with `includeProfile=1`. Existing installed Companions retain their original rich response on the old route through the trusted device-auth source; no user-agent or client-supplied capability header grants that behavior.

A timing row carries at most 100 literal game IDs from its recorded samples. The history endpoint intersects them with owner/opponent/cohort filters before its ordinary indexed pagination. The UI distinguishes this sample from full history. Durable game URLs carry a small sample marker rather than the long identifier list. Standard neighbor navigation waits for an explicit scope choice, bound synchronously to the owner and source cohort, and subsequent links represent that standard scope. This avoids broadening silently or adding storage and another neighbor query model.

The existing phase components and their internal sample links remain unchanged. Predictions explicitly describe their separate all-date recency cohort. No infrastructure, migration, persistent cache or additional account grant is introduced. Reverting restores the original eager profile; deploying the API first preserves both new and installed native clients during rollout.
