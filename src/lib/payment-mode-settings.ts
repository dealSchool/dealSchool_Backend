import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";

// Singleton doc — one active Cashfree mode (sandbox/live) at a time, matching
// the rest of the codebase's single-settings-doc design (see cohort-settings.ts).
// Defaults to "sandbox" until an admin explicitly switches it via PATCH
// /settings/payment, so a missing/misconfigured doc never accidentally takes
// live payments.
export type PaymentMode = "sandbox" | "live";

const PAYMENT_DOC = adminDb.collection("settings").doc("payment");

// This is read on every Cashfree API call (base URL + auth headers) but
// changes only when an admin flips the toggle, so it's cached in memory for
// a short TTL — same pattern as verify-admin.ts's admin-doc cache, which
// works here because this runs as a persistent Node process, not serverless.
const CACHE_TTL_MS = 60 * 1000;
let cached: { mode: PaymentMode; expiresAt: number } | null = null;

export async function getPaymentMode(): Promise<PaymentMode> {
  if (cached && Date.now() < cached.expiresAt) return cached.mode;

  const snap = await PAYMENT_DOC.get();
  const rawMode = snap.exists ? snap.data()?.mode : undefined;
  const mode: PaymentMode = rawMode === "live" ? "live" : "sandbox";

  cached = { mode, expiresAt: Date.now() + CACHE_TTL_MS };
  return mode;
}

export async function setPaymentMode(mode: string): Promise<PaymentMode> {
  if (mode !== "sandbox" && mode !== "live") {
    throw new Error("Invalid payment mode");
  }
  await PAYMENT_DOC.set(
    { mode, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  cached = { mode, expiresAt: Date.now() + CACHE_TTL_MS };
  return mode;
}
