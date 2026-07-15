import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";

// Singleton doc — one active Cashfree mode (sandbox/live) at a time, matching
// the rest of the codebase's single-settings-doc design (see cohort-settings.ts).
// Defaults to "sandbox" until an admin explicitly switches it via PATCH
// /settings/payment, so a missing/misconfigured doc never accidentally takes
// live payments.
export type PaymentMode = "sandbox" | "live";

const PAYMENT_DOC = adminDb.collection("settings").doc("payment");

export async function getPaymentMode(): Promise<PaymentMode> {
  const snap = await PAYMENT_DOC.get();
  const mode = snap.exists ? snap.data()?.mode : undefined;
  return mode === "live" ? "live" : "sandbox";
}

export async function setPaymentMode(mode: string): Promise<PaymentMode> {
  if (mode !== "sandbox" && mode !== "live") {
    throw new Error("Invalid payment mode");
  }
  await PAYMENT_DOC.set(
    { mode, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  return mode;
}
