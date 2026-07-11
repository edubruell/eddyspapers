import type { Context } from "hono";

// Mirror Plumber's get_client_ip (backend/inst/plumber/api.R): the first token of
// X-Forwarded-For, else the real-IP header nginx also sets, else "unknown". Behind the
// reverse proxy XFF is always present; the fallbacks only matter for direct-to-:8001 dev
// hits. Log-only — never a security decision, so a best-effort value is fine.
export const clientIp = (c: Context): string => {
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return c.req.header("x-real-ip")?.trim() || "unknown";
};
