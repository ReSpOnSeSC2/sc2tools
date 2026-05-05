// Type augmentations consumed by the JSDoc-annotated JS in src/.

import "express";

declare global {
  namespace Express {
    interface Request {
      // Set by middleware/requestId.js for log correlation.
      id?: string;
      // Set by middleware/auth.js after Clerk/device auth resolves.
      auth?: {
        userId: string;
        source: "clerk" | "device";
        // Only set when source === "clerk" — the raw Clerk identifier
        // (e.g. "user_2abc..."). Used by the SC2TOOLS_ADMIN_USER_IDS
        // gate so admins paste IDs straight from the Clerk dashboard
        // rather than having to look up the internal UUID.
        clerkUserId?: string;
        // Only set when source === "device" — used by the heartbeat
        // route to identify which device row to update without trusting
        // a request body field.
        tokenHash?: string;
      };
    }
  }
}

export {};
