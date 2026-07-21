export function getClientIp(request: Request): string {
  const fwd = (request as any).headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return (request as any).headers.get("x-real-ip") || "unknown";
}

type Bucket = { count: number; resetAt: number };

// In-memory fixed-window limiter — no Firestore reads/writes, so it can't
// itself contribute to quota exhaustion. Per-process only: fine for a single
// instance, but won't share state across a clustered/multi-instance deploy.
const buckets = new Map<string, Bucket>();

export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterMs: 0 };
  }

  if (bucket.count >= limit) {
    return { allowed: false, retryAfterMs: bucket.resetAt - now };
  }

  bucket.count += 1;
  return { allowed: true, retryAfterMs: 0 };
}
