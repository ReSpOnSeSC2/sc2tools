import { NextResponse } from "next/server";

// Website reachability is a static delivery check. Running a server function
// for a fixed status response wastes the web CPU allowance and cannot keep
// the separately hosted Render API awake. Check /v1/ping on that API for its
// own reachability; do not use this endpoint as a server warmup.

export const dynamic = "force-static";

export function GET(): NextResponse {
  return NextResponse.json(
    { status: "ok" },
    {
      headers: {
        "cache-control": "public, max-age=0, must-revalidate",
      },
    },
  );
}

export function HEAD(): NextResponse {
  return new NextResponse(null, {
    status: 200,
    headers: { "cache-control": "public, max-age=0, must-revalidate" },
  });
}
