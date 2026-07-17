import { adminAuth, adminDb } from "./firebase-admin";

// Cache Firestore admin-collection lookups for 5 minutes.
// Token revocation is always checked live via verifyIdToken(token, true).
const adminCache = new Map<string, number>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function isAdminCached(uid: string): boolean {
  const expiry = adminCache.get(uid);
  if (!expiry) return false;
  if (Date.now() > expiry) { adminCache.delete(uid); return false; }
  return true;
}

export async function verifyAdmin(request: Request): Promise<{ uid: string; email: string }> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new Error("Missing authorization header");
  }

  const token = authHeader.slice(7);

  // checkRevoked=true makes Firebase verify the token hasn't been explicitly
  // revoked (e.g. after account compromise). Adds one network round-trip.
  let decoded: Awaited<ReturnType<typeof adminAuth.verifyIdToken>>;
  try {
    decoded = await adminAuth.verifyIdToken(token, true);
  } catch (err: any) {
    if (err.code === "auth/id-token-revoked") {
      throw new Error("Token revoked — please sign in again");
    }
    throw err;
  }

  const adminEmail = process.env.ADMIN_EMAIL || "admin@dealschool.in";

  if (decoded.email === adminEmail) {
    return { uid: decoded.uid, email: decoded.email };
  }

  if (isAdminCached(decoded.uid)) {
    return { uid: decoded.uid, email: decoded.email || "" };
  }

  const snap = await adminDb.collection("admins").doc(decoded.uid).get();
  if (!snap.exists) {
    throw new Error("Unauthorized: admin access required");
  }

  adminCache.set(decoded.uid, Date.now() + CACHE_TTL_MS);
  return { uid: decoded.uid, email: decoded.email || "" };
}
