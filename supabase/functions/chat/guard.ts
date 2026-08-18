/**
 * Browser-facing guards for /functions/v1/chat.
 *
 * Kept free of Deno APIs so test/chat-guard.ts can run the same code the
 * function deploys, the same way crypto.ts does.
 */

export const DEFAULT_ORIGINS = [
  "https://medixly.netlify.app",
  "https://medixly.ca",
  "http://localhost:8888",
  "http://127.0.0.1:8888",
];

export interface OriginPolicy {
  allowed: Set<string>;
  /** When true, any https://*.netlify.app origin is accepted. */
  netlifyWildcard: boolean;
}

export function parseOrigins(
  raw: string | undefined,
  strict = false,
): OriginPolicy {
  const extra = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    allowed: new Set([...DEFAULT_ORIGINS, ...extra]),
    netlifyWildcard: !strict,
  };
}

export function allowOrigin(origin: string | null, policy: OriginPolicy): string | null {
  if (!origin) return null;
  if (policy.allowed.has(origin)) return origin;
  if (!policy.netlifyWildcard) return null;
  try {
    const u = new URL(origin);
    if (u.protocol === "https:" && u.hostname.endsWith(".netlify.app") && u.hostname !== "netlify.app") {
      return origin;
    }
  } catch { /* ignore */ }
  return null;
}

export function corsHeaders(origin: string | null, policy: OriginPolicy): Record<string, string> {
  const allow = allowOrigin(origin, policy);
  const headers: Record<string, string> = {
    "access-control-allow-headers":
      "authorization, x-client-info, apikey, content-type, x-staff-key",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    vary: "Origin",
  };
  if (allow) headers["access-control-allow-origin"] = allow;
  return headers;
}

/** Patient link: token in the hash so it is not sent as a Referer. */
export function patientLink(base: string, token: string): string {
  const t = encodeURIComponent(token);
  try {
    const url = new URL(base);
    url.searchParams.delete("t");
    url.hash = `t=${t}`;
    return url.toString();
  } catch {
    const root = String(base || "https://medixly.netlify.app/").replace(/\/?$/, "/");
    return `${root}#t=${t}`;
  }
}

export function clientIp(headers: { get(name: string): string | null }): string {
  const cf = headers.get("cf-connecting-ip");
  if (cf?.trim()) return cf.trim();
  const xff = headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim() || "unknown";
  return "unknown";
}

export class RateLimiter {
  private buckets = new Map<string, { n: number; reset: number }>();

  constructor(readonly windowMs: number, readonly max: number) {}

  /** True if this hit is allowed. */
  hit(key: string, now = Date.now()): boolean {
    if (this.buckets.size > 8000) this.gc(now);
    const b = this.buckets.get(key);
    if (!b || now >= b.reset) {
      this.buckets.set(key, { n: 1, reset: now + this.windowMs });
      return true;
    }
    if (b.n >= this.max) return false;
    b.n += 1;
    return true;
  }

  gc(now = Date.now()) {
    for (const [k, b] of this.buckets) {
      if (now >= b.reset) this.buckets.delete(k);
    }
  }
}
