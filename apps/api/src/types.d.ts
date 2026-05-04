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
        // Only set when source === "device" — used by the heartbeat
        // route to identify which device row to update without trusting
        // a request body field.
        tokenHash?: string;
      };
    }
  }
}

export {};
