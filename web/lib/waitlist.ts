// Pure, dependency-free helpers behind the waitlist API route (app/api/waitlist/route.ts). Kept
// separate from the route so they can be unit-tested without standing up Next's request/response
// or a Supabase client — the route just wires these together.

// Pragmatic email shape check — Postgres has the final say via the CITEXT UNIQUE column; this just
// rejects obvious junk before we spend a round-trip.
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(value: unknown): value is string {
  return typeof value === "string" && EMAIL_RE.test(value.trim());
}

// Honeypot: a hidden field no human fills. A non-empty value means a bot submitted the form.
export function isHoneypotTripped(company: unknown): boolean {
  return typeof company === "string" && company.trim() !== "";
}

export function clientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim() || "unknown";
  return request.headers.get("x-real-ip") ?? "unknown";
}

export interface RateLimiterOptions {
  windowMs: number;
  maxRequests: number;
  // Injectable clock so tests can advance time deterministically; defaults to wall-clock.
  now?: () => number;
  // Cap on tracked keys before an opportunistic sweep drops expired entries.
  maxTrackedKeys?: number;
}

export interface RateLimiter {
  // Records a hit for `key` and returns true if it should be throttled (already at the limit).
  check(key: string): boolean;
}

// Cheap in-memory sliding window to blunt scripted spam. Caveat: serverless instances don't share
// memory and cold-start fresh, so this throttles a burst hitting one warm instance, not a
// distributed flood — for that you'd reach for Vercel WAF or Upstash. Still covers the realistic
// threat (a bot padding the list) with zero dependencies.
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { windowMs, maxRequests, now = () => Date.now(), maxTrackedKeys = 5000 } = options;
  const hits = new Map<string, number[]>();

  return {
    check(key: string): boolean {
      const t = now();
      const recent = (hits.get(key) ?? []).filter((ts) => t - ts < windowMs);
      if (recent.length >= maxRequests) {
        hits.set(key, recent);
        return true;
      }
      recent.push(t);
      hits.set(key, recent);
      // Opportunistic sweep so the map can't grow unbounded across many unique keys.
      if (hits.size > maxTrackedKeys) {
        for (const [k, times] of hits) {
          if (times.every((ts) => t - ts >= windowMs)) hits.delete(k);
        }
      }
      return false;
    }
  };
}
