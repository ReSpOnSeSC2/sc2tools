// Compatibility for old monitors. Each serverless route has its own lifetime,
// so this endpoint cannot warm the dashboard. Serve the same static website
// reachability result without executing another Node function on each ping.
export { GET, HEAD } from "../ping/route";
export const dynamic = "force-static";
