import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";

export async function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<{ allowed: boolean; retryAfterMs: number }> {
  const docRef = adminDb.collection("rateLimits").doc(key);

  return adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    const now  = Date.now();

    if (!snap.exists || (snap.data()!.resetAt as Timestamp).toMillis() <= now) {
      tx.set(docRef, {
        count:   1,
        resetAt: Timestamp.fromMillis(now + windowMs),
      });
      return { allowed: true, retryAfterMs: 0 };
    }

    const { count, resetAt } = snap.data() as { count: number; resetAt: Timestamp };

    if (count >= limit) {
      return { allowed: false, retryAfterMs: resetAt.toMillis() - now };
    }

    tx.update(docRef, { count: FieldValue.increment(1) });
    return { allowed: true, retryAfterMs: 0 };
  });
}

export function getClientIp(request: Request): string {
  const fwd = (request as any).headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return (request as any).headers.get("x-real-ip") || "unknown";
}
